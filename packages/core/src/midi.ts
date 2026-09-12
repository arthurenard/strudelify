/**
 * MIDI -> Song analysis. Works in Node and the browser (via @tonejs/midi).
 *
 * @tonejs/midi gives us notes, tempo and metre maps, but it drops the channel of controller
 * events on note-less tracks (format-1 files often keep volume/pan/program changes on their own
 * tracks) and it never exposes RPNs. A tiny raw-SMF scan (`scanChannelEvents`) recovers the
 * per-channel controller state so the mix (CC 7/10/11), sustain (CC 64), program changes and
 * coarse tuning (RPN 2) can be honoured.
 *
 * `songFromMidi` runs in steps: `readTiming` (dominant tempo and metre, the beat map, the bar-line
 * phase), `readParts` (notes merged per channel and program; drum channels from GS rhythm-part
 * sysex and XG bank 127 as well as channel 10), `resolveBanks` (programs selected with bank 127
 * read through the Roland MT-32 map when the file means it, whole files read through it when their
 * track names are the MT-32 patch names, and a track name overruling a program neither table reads
 * as the named instrument), `applyControllers` (mix, sustain, tuning), `cleanParts` (single-pitch
 * drum parts folded into the kit, effects, strays, doubles, stubs) and `assignRoles` (bass, chords,
 * drums, and the melody chosen by `chooseMelody`). Track names come from the raw chunks too
 * (`scanTrackNames`): @tonejs/midi splits a track per program and leaves the name on a note-less
 * piece whenever a bank or volume precedes the program change, which is the usual order. Names
 * that are credits rather than parts ("Tracked by X", an e-mail address, the song's own title or
 * artist) or that have no letters are dropped (`partName`).
 *
 * Time: Strudel has one tempo, so note positions are real seconds re-expressed as beats of the
 * dominant tempo (`beatMap`). A section at another tempo keeps its real duration (a 2x section fits
 * two of its bars in one cycle); when its tempo is within 5% of a simple ratio of the dominant one
 * (2x, 3x, 1.5x, half) it is snapped to that exact ratio so its notes stay on the cell grid instead
 * of drifting off it; other tempo ramps become slight timing drift. A count-in or default-tempo
 * stretch shorter than two bars before the dominant tempo is squeezed to a whole number of cells so
 * the song's first downbeat lands on a cell. Bar 0 is phased (`barPhase`) to the file's bar lines
 * that fit the grid, so neither a pickup bar in another metre nor a count-in at another tempo
 * shifts every later downbeat off the cycle boundary.
 *
 * Parts: tracks merge per channel and program; effects patches, stray events after the song,
 * duplicate copies (including stereo doubles delayed by up to `MAX_DOUBLE_DELAY` seconds) and stubs
 * of a few notes are removed or folded (`dropTrailingStrays`, `dedupeParts`, `foldStubs`).
 * Of two copies on different patches the one whose patch fits the register is kept (a bass patch
 * for a low line, `preferByRegister`). Polyphony is measured ignoring octave and unison doublings
 * (`stats`), so a lead written in octaves is still a lead, and block chords are told apart from
 * two-part harmony (`triadic`). Roles: a song with a bass on a bass patch keeps at most one more
 * bass by register (`capRegisterBasses`; a double bass or tuba in the bass register is the bass
 * like a bass patch, `LOW_LINE_PROGRAMS`); a vocal name wins the melody only for a substantial part
 * and an instrumental candidate must cover `MELODY_MIN_COVERAGE` of the song. A voice patch is a
 * singer only in the singer's range: a busy synth choir at F1 is the bass (`roleFor`,
 * `melodyScore`). A melody in several parts that take turns is the sung line, rendered on the
 * melody sound, when the parts are singer stand-ins (`assignRoles`).
 */
import * as ToneMidiNs from '@tonejs/midi';
import type { Midi as MidiType, Track as ToneTrack } from '@tonejs/midi';
import type { NoteEvent, Song, SongMeta, Track, TrackRole, Section, ChordEvent } from './types.js';
import { BASS_PROGRAMS, FX_PROGRAMS, GUITAR_PROGRAMS, VOCAL_PROGRAMS, SINGER_STANDIN_PROGRAMS, NOMINAL_VOLUME, MT32_BANK, MT32_NAMES, MT32_TO_GM, GM_INSTRUMENTS, DEFINITE_FAMILIES, gmLabel, family, nameFamily, nameFitsPatch, programForName, tableForName, nameSaysPatch, mixLevel, isAudible } from './gm.js';
import { estimateKey } from './key.js';
import { detectChord } from './detect.js';
import { pcName } from './chords.js';

// Node resolves the package's CommonJS build (default = module.exports), bundlers its ES build (named exports).
const ns = ToneMidiNs as unknown as { Midi?: typeof MidiType; default?: { Midi?: typeof MidiType } };
const Midi = (ns.Midi ?? ns.default?.Midi) as typeof MidiType;

export interface MidiIdentity {
  id: string;
  title: string;
  artist: string;
  year?: number;
}

// ---------- track names ----------

/**
 * Words that make a track a singer whatever else the name says: "backing vocals" and "Vocal
 * Harmony" are vocals, and "sax vocal lead" or "Synth Vox" name the patch that stands in for one.
 */
const VOCAL_RE = /vocal|vox|\bvoc\b|voice|sing|lyric|chant/i;
/** "Melody" alone names a singer only when no instrument is named ("Guitar melody" is a guitar). A bare "lead" is never enough: lead guitars and lead synths are named that way too. */
const WEAK_VOCAL_RE = /melod/i;
const INSTRUMENT_RE = /guitar|git|gtr|\bgt\b|piano|keys|organ|synth|brass|horn|sax|string|bass|drum|perc|flute|trumpet|violin|viola|cello|fiddle|harmonica|clav|bell|pad|oboe|clarinet|bassoon|accord|bandoneon|trombone|tuba|marimba|vibe|harp|sitar|banjo|mandolin/i;
/** Track names that say "bass" (but not "bass drum"). */
const BASS_NAME_RE = /\bbass\b/i;
const BASS_DRUM_RE = /drum|kick/i;

/**
 * Track names that are credits, not parts: "Tracked by X", "Sequenced by:", "Visit The Midi
 * Planet", an e-mail address or a URL, the song's title in quotes "by" the artist, a catalogue
 * code ("ID: WWST-0012"), the second line of a credit split over two tracks ("of Chris's MIDI
 * Project"). "by" alone is not a credit: "Stand By Me" and "Walk On By" are titles, "Byron Sax"
 * a player; it counts after a participle ("made by", "MIDIfied by"), after a quoted phrase, at the
 * start of the name, with a colon, or before the artist's name (`isCreditName` takes the song).
 * Such names say nothing about the instrument and would only turn into junk identifiers, so the
 * part is left nameless.
 */
const CREDIT_RE = /@|https?:|www\.|\.(?:com|net|org|de|dk|uk|fr|it|nl)\b|\btracked\b|sequenc|arrang|transcri|copyright|\(c\)|©|all rights|\bvisit\b|e-?mail|midi\s*(?:planet|mania|project|house)|\bwritten\b|\bcomposed\b|\bperformed\b|\bproduced\b|\b\w+(?:ed|fied)\s+(?:\w+\s+)?by\b|\b(?:midi|file|music|karaoke|words|lyrics)\s+by\b|["'“”‘’][^"'“”‘’]*["'“”‘’]\s*by\b|^by\b|\bby\s*:|\bid\s*:\s*\S|\b[A-Z]{2,5}-\d{3,}\b|^of\s|\bcomments?\b|\bwelcome\b|\bthanks?\b|\bthanx\b|\bgreetings?\b|\bhello\b|\bhi\s+to\b|\bsee you\b|winjammer|\bdemo\b|\bfeedback\b|\bhome\s*page\b|\bweb\s*(?:site|page)\b|\bfrom (?:the|their|my) album\b|^album\b|\balbum:|\bartist:|\btitle:|\bmail me\b|\bbuy (?:the|her|his|this)\b|\bnot for sale\b|\breserv|\bwords (?:&|and) music\b|\bdedicat|\bmore midi\b|\bmidi files?\b|\boriginal midi\b|\bmuted lyrics\b|\bversion\b|\bcorrections?\b|\bartist\b|:\s*$/i;
/**
 * Words that make a name a part's: an instrument (see `INSTRUMENT_RE`, `nameFamily`), a singer,
 * a role ("Lead", "Rhythm", "Fill", "Left Hand"), a kit piece, a register, a patch adjective. A
 * name of four or more words with none of them ("All comments welcome to", "Not For Sale or
 * Reproduction", "CAROLINA IN MY MI 2") is a sentence or a title, not a part.
 */
const PART_WORD_RE = /vocal|vox|voice|sing|melod|lead|solo|rhythm|rhy\b|pad|synth|syn\b|drum|perc|kick|snare|hat|cymb|tom\b|kit\b|keys|key\b|harmon|backing|back\b|fill|intro|chorus|verse|bridge|outro|arp|seq|riff|chord|comp|acc|left|right|hand|high|low|hi\b|lo\b|upper|lower|treble|alto|tenor|sopran|bari|section|sect|ens\b|orch|fx|effect|noise|sfx|loop|main|sub|top|line|part|track|trk|ch\b|channel|inst|dist|clean|mute|nylon|steel|acou|elec|el\b|slap|pick|finger|fretless|upright|wah|crunch|overdr|jazz|rock|pop|funk|latin|bell|whistle|pno|gtr|git|bs\b|org\b|clav|kalimba|koto|ocarina|xylo|glock|celest|timp|taiko|agogo|wood|shaker|maraca|conga|bongo|tamb|clap|castanet|triangle|cabasa|guiro|claves|cowbell|scratch|hit|stab|sweep|tremolo|pizz|choir|aah|ooh|breath|square|saw|calliope|chiff|charang|fifth|poly|warm|halo|metallic|bowed|new age|crystal|atmos|bright|goblin|echo|sci|rain|soundtrack|epiano|rhodes|wurli|honky|dulcimer|music box|tinkle|bagpipe|shanai|shamisen|contra|tpt|tbn|picc|recorder|bottle|shaku|orchestra|gm\b|gs\b|xg\b|mt-?32|sc-?55|midi/i;
/** From this many words on, a name without a part word is a sentence (see `PART_WORD_RE`). */
const SENTENCE_WORDS = 4;

/** Which song a track name may be naming instead of a part: the title, the artist, or both. */
export interface SongName { title: string; artist: string }

/** Letters and digits only, lower case, single spaces: how names are compared with the song's. */
function foldName(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * Whether a track name is a credit rather than a part (see `CREDIT_RE`): a credit word, or a
 * sentence of `SENTENCE_WORDS` words with no part word among them. Given the song, a name that is
 * its title or its artist ("Bohemian Rhapsody" on the piano track), that carries both, that says
 * "by" the artist ("Raspberry Swirl by Tori") or "midi" with the artist ("TORI MIDI!!!!") is a
 * credit too.
 */
export function isCreditName(name: string, song?: SongName): boolean {
  if (CREDIT_RE.test(name)) return true;
  const n = foldName(name);
  if (n.split(' ').length >= SENTENCE_WORDS && !PART_WORD_RE.test(name) && !INSTRUMENT_RE.test(name) && !nameFamily(name)) return true;
  if (!song) return false;
  const title = foldName(song.title), artist = foldName(song.artist);
  if (n && (n === title || n === artist)) return true;
  const hasWords = (s: string) => !!s && ` ${n} `.includes(` ${s} `);
  if (hasWords(title) && hasWords(artist)) return true;
  const artistWords = artist.split(' ').filter((w) => w.length >= 3);
  const by = /\bby\s+(\S+)/i.exec(n);
  if (by && artistWords.includes(by[1])) return true;
  return /\bmidi\b/.test(n) && artistWords.some((w) => hasWords(w));
}

/**
 * A track name fit to describe a part: trimmed, and empty when it is a credit or has no letters
 * at all (a channel number "34", a row of dashes, a date: nothing to call the part by).
 */
export function partName(name: string | undefined, song?: SongName): string {
  const n = (name ?? '').replace(/[\x00-\x1f\x7f\u2028\u2029]/g, '').trim();
  return n && /\p{L}/u.test(n) && !isCreditName(n, song) ? n : '';
}

/** Whether a track name says the part stands for a singer. */
export function nameSaysVocal(name: string): boolean {
  if (VOCAL_RE.test(name)) return true;
  return WEAK_VOCAL_RE.test(name) && !INSTRUMENT_RE.test(name);
}

// ---------- raw channel events ----------

export interface ChannelEvent {
  ticks: number;
  /** MIDI channel 0-15; -1 for a `reset` (system exclusive, no channel). */
  channel: number;
  kind: 'cc' | 'program' | 'reset' | 'rhythm';
  /** Controller number for `cc`, program number for `program`, the `Reset` kind for `reset`, the drum-map number (0 = melodic) for a GS `rhythm` part assignment. */
  number: number;
  /** Raw 0-127 controller value (unused for `program` and `reset`). */
  value: number;
}

/** System-exclusive resets that say which sound map the file was written for (see `ChannelEvent.kind`). */
export const Reset = { GM: 0, GS: 1, XG: 2 } as const;

/**
 * Walk the Standard MIDI File chunks and return every control change and program change with its
 * channel, plus the GM/GS/XG reset messages, in file order. Notes, tempo and meta events are left to
 * @tonejs/midi.
 */
export function scanChannelEvents(data: Uint8Array): ChannelEvent[] {
  const out: ChannelEvent[] = [];
  walkSmf(data, {
    channel: (ticks, status, d1, d2) => {
      const type = status & 0xf0, channel = status & 0x0f;
      if (type === 0xc0) out.push({ ticks, channel, kind: 'program', number: d1, value: d1 });
      else if (type === 0xb0) out.push({ ticks, channel, kind: 'cc', number: d1, value: d2 });
    },
    sysex: (ticks, b) => {
      // Only the resets matter (GM on: 7E xx 09 01, GS: 41 xx 42 12 ..., XG: 43 xx 4C ...).
      if (b.length < 4) return;
      if (b[0] === 0x7e && b[2] === 0x09) out.push({ ticks, channel: -1, kind: 'reset', number: Reset.GM, value: 0 });
      else if (b[0] === 0x41 && b[2] === 0x42 && b[3] === 0x12) {
        out.push({ ticks, channel: -1, kind: 'reset', number: Reset.GS, value: 0 });
        // GS "use for rhythm part" (40 1x 15 vv): part block 0x10 is channel 10, 0x11-0x19 channels 1-9, 0x1A-0x1F channels 11-16.
        if (b.length >= 8 && b[4] === 0x40 && (b[5] & 0xf0) === 0x10 && b[6] === 0x15) {
          const block = b[5] & 0x0f;
          out.push({ ticks, channel: block === 0 ? 9 : block <= 9 ? block - 1 : block, kind: 'rhythm', number: b[7], value: b[7] });
        }
      } else if (b[0] === 0x43 && b[2] === 0x4c) out.push({ ticks, channel: -1, kind: 'reset', number: Reset.XG, value: 0 });
    },
  });
  return out;
}

/**
 * Windows-1252 bytes 0x80-0x9F, where it differs from ISO-8859-1: curly quotes, dashes and the
 * rest of the printable characters sequencers put in track names. The five bytes the code page
 * leaves undefined (0x81, 0x8D, 0x8F, 0x90, 0x9D) keep their own code point, as the WHATWG index
 * does. Every other byte is its own code point in both code pages. Written out here rather than
 * left to `TextDecoder('windows-1252')`, which decodes this block as ISO-8859-1 C1 controls on a
 * Node build without the full ICU data.
 */
const CP1252_HIGH = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f' // 0x80-0x8F
  + '\u0090‘’“”•–—˜™š›œ\u009džŸ'; // 0x90-0x9F

/**
 * The text of a meta event. A Standard MIDI File declares no encoding: the bytes are UTF-8 when
 * they decode as such, otherwise Windows-1252 (the Latin-1 superset most sequencers wrote), so a
 * Spanish "mÉIS cOROS" or a French "Contrebasse à l'archet" keeps its letters instead of becoming
 * "m�IS", and a quoted "“Part”" keeps its quotation marks instead of two C1 controls. (Bytes that
 * are valid UTF-8 by accident are rare: an accented capital in Latin-1 is a lead byte that needs a
 * continuation byte after it, which a Latin-1 word almost never supplies.)
 */
export function decodeText(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* not UTF-8 */ }
  let s = '';
  for (const b of bytes) s += b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : String.fromCharCode(b);
  return s;
}

/**
 * A name as @tonejs/midi hands it over, re-read as bytes (`decodeText`): its parser turns every
 * byte into a character, so a UTF-8 name comes out as "Ã©" and a Windows-1252 one is intact. A
 * name with a code unit above 255 was not made that way and is left alone.
 */
function rawName(name: string): string {
  if (!name || !/^[\x00-\xff]*$/.test(name)) return name;
  return decodeText(Uint8Array.from(name, (c) => c.charCodeAt(0)));
}

/**
 * Track names per channel, from the raw chunks: the name of a track whose notes all sit on one
 * channel names that channel (the first such track wins). @tonejs/midi splits a track into one
 * sub-track per program and keeps the name meta on the first, so a track written as name, bank,
 * program change, notes (the usual order) hands its notes to a nameless sub-track. A track that
 * plays several channels (a format-0 file, a whole song on one track) names none of them.
 */
export function scanTrackNames(data: Uint8Array): Map<number, string> {
  const names = new Map<number, string>();
  let name = '';
  let channels = new Set<number>();
  const flush = () => {
    if (name && channels.size === 1) { const [ch] = channels; if (!names.has(ch)) names.set(ch, name); }
    name = '';
    channels = new Set();
  };
  walkSmf(data, {
    track: flush,
    meta: (type, bytes) => { if (type === 0x03 && !name) name = decodeText(bytes).trim(); },
    channel: (_ticks, status, _d1, d2) => { if ((status & 0xf0) === 0x90 && d2 > 0) channels.add(status & 0x0f); },
  });
  flush();
  return names;
}

interface SmfVisitor {
  /** Called at the start of every MTrk chunk. */
  track?: () => void;
  meta?: (type: number, bytes: Uint8Array) => void;
  sysex?: (ticks: number, bytes: Uint8Array) => void;
  /** A channel message: `status` carries type and channel; `d2` is 0 for the one-byte program and pressure messages. */
  channel?: (ticks: number, status: number, d1: number, d2: number) => void;
}

/** Walk the Standard MIDI File chunks and hand every event to the visitor, in file order. Garbage is tolerated. */
function walkSmf(data: Uint8Array, v: SmfVisitor): void {
  if (data.length < 14 || data[0] !== 0x4d || data[1] !== 0x54 || data[2] !== 0x68 || data[3] !== 0x64) return;
  const u32 = (p: number) => ((data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3]) >>> 0;
  let pos = 8 + u32(4);
  while (pos + 8 <= data.length) {
    const isTrack = data[pos] === 0x4d && data[pos + 1] === 0x54 && data[pos + 2] === 0x72 && data[pos + 3] === 0x6b;
    const start = pos + 8;
    const end = Math.min(data.length, start + u32(pos + 4));
    pos = end;
    if (!isTrack) continue;
    v.track?.();
    let p = start;
    let ticks = 0;
    let status = 0;
    const readVar = (): number => {
      let val = 0, b: number;
      do { b = data[p++]; val = (val << 7) | (b & 0x7f); } while (b & 0x80 && p < end);
      return val;
    };
    while (p < end) {
      ticks += readVar();
      if (p >= end) break;
      const first = data[p];
      // (`p += readVar()` would read `p` before the call advances it, so the length is read first.)
      if (first === 0xff) { const type = data[p + 1]; p += 2; const len = readVar(); v.meta?.(type, data.subarray(p, Math.min(end, p + len))); p += len; continue; }
      if (first === 0xf0 || first === 0xf7) { p += 1; const len = readVar(); if (first === 0xf0) v.sysex?.(ticks, data.subarray(p, Math.min(end, p + len))); p += len; status = 0; continue; }
      if (first >= 0xf1 && first <= 0xfe) { p += 1; continue; } // system common / realtime (not expected in files)
      if (first & 0x80) { status = first; p++; } else if (!status) { p++; continue; } // running status
      const type = status & 0xf0;
      if (type === 0xc0 || type === 0xd0) v.channel?.(ticks, status, data[p++] & 0x7f, 0);
      else { const d1 = data[p++] & 0x7f; const d2 = data[p++] & 0x7f; v.channel?.(ticks, status, d1, d2); }
    }
  }
}

interface Point { ticks: number; value: number }

interface ChannelState {
  volume: Point[];
  expression: Point[];
  pan: Point[];
  sustain: Point[];
  programs: Point[];
  /** Bank select MSB (CC 0). */
  bank: Point[];
  /** Coarse tuning (RPN 0/2) in semitones. */
  transpose: Point[];
}

/** Which sound maps the file's reset messages name. */
interface SoundMap { gm: boolean; gs: boolean; xg: boolean }

function soundMap(events: ChannelEvent[]): SoundMap {
  const kinds = new Set(events.filter((e) => e.kind === 'reset').map((e) => e.number));
  return { gm: kinds.has(Reset.GM), gs: kinds.has(Reset.GS), xg: kinds.has(Reset.XG) };
}

function channelStates(events: ChannelEvent[]): Map<number, ChannelState> {
  const map = new Map<number, ChannelState>();
  const rpn = new Map<number, { msb: number; lsb: number }>();
  const get = (ch: number): ChannelState => {
    let s = map.get(ch);
    if (!s) map.set(ch, (s = { volume: [], expression: [], pan: [], sustain: [], programs: [], bank: [], transpose: [] }));
    return s;
  };
  for (const e of events) {
    if (e.kind === 'reset' || e.kind === 'rhythm') continue;
    const s = get(e.channel);
    if (e.kind === 'program') { s.programs.push({ ticks: e.ticks, value: e.number }); continue; }
    switch (e.number) {
      case 0: s.bank.push({ ticks: e.ticks, value: e.value }); break;
      case 7: s.volume.push({ ticks: e.ticks, value: e.value }); break;
      case 11: s.expression.push({ ticks: e.ticks, value: e.value }); break;
      case 10: s.pan.push({ ticks: e.ticks, value: e.value }); break;
      case 64: s.sustain.push({ ticks: e.ticks, value: e.value }); break;
      case 101: { const r = rpn.get(e.channel) ?? { msb: 127, lsb: 127 }; r.msb = e.value; rpn.set(e.channel, r); break; }
      case 100: { const r = rpn.get(e.channel) ?? { msb: 127, lsb: 127 }; r.lsb = e.value; rpn.set(e.channel, r); break; }
      case 6: { // data entry MSB
        const r = rpn.get(e.channel);
        if (r && r.msb === 0 && r.lsb === 2) s.transpose.push({ ticks: e.ticks, value: e.value - 64 });
        break;
      }
    }
  }
  return map;
}

/** Value of the last point at or before `ticks`, or `fallback` when none. */
function valueAt(points: Point[], ticks: number, fallback: number): number {
  const p = pointAt(points, ticks);
  return p ? p.value : fallback;
}

function pointAt(points: Point[], ticks: number): Point | undefined {
  let lo = 0, hi = points.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (points[mid].ticks <= ticks) lo = mid + 1; else hi = mid; }
  return lo === 0 ? undefined : points[lo - 1];
}

/**
 * Bank select MSB in force for the notes at `ticks`: a bank select only takes effect at the next
 * program change, so it is the bank at the tick of the program change in force (a CC 0 sent after
 * the program change selects nothing until another one comes). Without any program change the bank
 * is read at the note, which is what a bank-only file expects of a drum channel.
 */
function bankAt(st: ChannelState, ticks: number): number {
  const pc = pointAt(st.programs, ticks);
  return valueAt(st.bank, pc ? pc.ticks : ticks, 0);
}

// ---------- small statistics ----------

/** Onsets closer than this (beats) count as the same moment, within a part and when comparing parts: a 64th note. */
const SAME_ONSET = 1 / 16;

export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** The value at quantile `q` of an ascending `sorted` array (nearest-rank, no interpolation). */
export function percentile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

/** Mean velocity of the notes; 0.75 (a GM mezzo-forte) when there are none. */
export function meanVelocity(notes: NoteEvent[]): number {
  if (!notes.length) return 0.75;
  return notes.reduce((a, n) => a + n.velocity, 0) / notes.length;
}

// ---------- tempo & metre ----------

interface Region<T> { ticks: number; value: T }

/**
 * The value in force for the longest total time (a value that recurs adds up its stretches).
 * `length` measures a stretch of ticks, in whatever unit should decide (seconds for tempos).
 */
function dominant<T>(regions: Region<T>[], endTicks: number, length: (from: number, to: number) => number = (a, b) => b - a): T {
  const totals = new Map<string, { value: T; len: number }>();
  for (let i = 0; i < regions.length; i++) {
    const next = i + 1 < regions.length ? regions[i + 1].ticks : Math.max(endTicks, regions[i].ticks + 1);
    const len = Math.max(0, length(regions[i].ticks, next));
    const key = JSON.stringify(regions[i].value);
    const entry = totals.get(key) ?? { value: regions[i].value, len: 0 };
    entry.len += len;
    totals.set(key, entry);
  }
  let best = regions[0].value, bestLen = -1;
  for (const { value, len } of totals.values()) if (len > bestLen) { bestLen = len; best = value; }
  return best;
}

/**
 * Tempo regions worth talking about: stretches shorter than one bar (a 2-tick default tempo before
 * the real one, the steps of a ritardando) are absorbed into their neighbours and runs of
 * near-identical tempos collapse, so the map lists musical tempo changes only. The time warp
 * itself uses the full tempo map through @tonejs/midi.
 */
function tempoMap(midi: MidiType, barTicks: number, endTicks: number): Region<number>[] {
  const raw = midi.header.tempos.map((t) => ({ ticks: t.ticks, value: Math.round(t.bpm * 10) / 10 })).sort((a, b) => a.ticks - b.ticks);
  if (!raw.length) return [{ ticks: 0, value: 120 }];
  const long = raw.filter((t, i) => (i + 1 < raw.length ? raw[i + 1].ticks : Math.max(endTicks, t.ticks + 1)) - t.ticks >= barTicks);
  const kept = long.length ? long : [raw.reduce((a, b) => (b.ticks - a.ticks > 0 ? b : a))];
  kept[0] = { ...kept[0], ticks: 0 };
  const out: Region<number>[] = [];
  for (const t of kept) {
    const tail = out[out.length - 1];
    if (tail && Math.abs(tail.value - t.value) / tail.value < 0.02) continue;
    out.push(t);
  }
  return out;
}

function meterMap(midi: MidiType): Region<[number, number]>[] {
  const sigs = midi.header.timeSignatures;
  if (!sigs.length) return [{ ticks: 0, value: [4, 4] }];
  const out: Region<[number, number]>[] = [];
  for (const s of sigs) {
    const v: [number, number] = [s.timeSignature[0] || 4, s.timeSignature[1] || 4];
    const tail = out[out.length - 1];
    if (tail && tail.value[0] === v[0] && tail.value[1] === v[1]) continue;
    out.push({ ticks: s.ticks, value: v });
  }
  return out;
}

/** Tempo ratios (dominant beats per file beat) that keep a section on the cell grid, and the tolerance for snapping to them. */
const GRID_RATIOS = [0.25, 0.5, 1, 1.5, 2, 3, 4];
const RATIO_TOLERANCE = 0.05;
/** A prefix at another tempo shorter than this many bars is a count-in or a default tempo, squeezed onto the cell grid. */
const PREFIX_MAX_BARS = 2;
/** The cell the prefix is squeezed to, in beats: a sixteenth, the straight grid's cell in every metre. */
const PREFIX_CELL = 0.25;

export interface BeatRegion {
  ticks: number;
  /** Position of the region's start on the dominant-tempo grid, in beats. */
  beat: number;
  /** Beats of the dominant grid per file beat: 2 when the region runs at half the dominant tempo. */
  ratio: number;
  bpm: number;
  snapped: boolean;
  /** Factor by which a count-in region was stretched (>1) or squeezed (<1) to end on a cell. */
  squeezed?: number;
}

/**
 * Map file ticks to beats of the dominant tempo. Each tempo region advances at `bpm / regionBpm`
 * grid beats per file beat, i.e. it keeps its real duration, except that a ratio within
 * `RATIO_TOLERANCE` of one of `GRID_RATIOS` is snapped to it exactly: a section at 154 bpm on a
 * 78 bpm grid plays as 2x (156 bpm, 1.3% fast) so its notes fall on cells instead of limping off
 * the grid by a cell every few bars. Given `barLen`, a prefix at another tempo shorter than
 * `PREFIX_MAX_BARS` (a one-bar count-in at 200 bpm before a 114 bpm song, 2.28 grid beats) is
 * squeezed by up to `RATIO_TOLERANCE` so the dominant tempo starts on a sixteenth.
 */
export function beatMap(tempos: { ticks: number; bpm: number }[], bpm: number, ppq: number, barLen?: number): BeatRegion[] {
  const raw = [...tempos].sort((a, b) => a.ticks - b.ticks);
  if (!raw.length || raw[0].ticks > 0) raw.unshift({ ticks: 0, bpm: raw.length ? raw[0].bpm : 120 });
  const regions: BeatRegion[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (i + 1 < raw.length && raw[i + 1].ticks === raw[i].ticks) continue; // a later event at the same tick wins
    const real = bpm / raw[i].bpm;
    const near = GRID_RATIOS.find((r) => Math.abs(real / r - 1) <= RATIO_TOLERANCE);
    // (A ratio off by rounding alone, the dominant tempo being rounded to 0.1 bpm, is not worth a remark.)
    regions.push({ ticks: raw[i].ticks, beat: 0, ratio: near ?? real, bpm: raw[i].bpm, snapped: near !== undefined && Math.abs(real / near - 1) > 0.002 });
  }
  const layout = () => {
    for (let i = 1; i < regions.length; i++) regions[i].beat = regions[i - 1].beat + ((regions[i].ticks - regions[i - 1].ticks) / ppq) * regions[i - 1].ratio;
  };
  layout();
  const first = regions.findIndex((r) => r.ratio === 1);
  if (barLen !== undefined && first > 0) {
    const len = regions[first].beat;
    const target = Math.round(len / PREFIX_CELL) * PREFIX_CELL;
    if (len > 0 && len < PREFIX_MAX_BARS * barLen && target > 0 && target !== len && Math.abs(target / len - 1) <= RATIO_TOLERANCE) {
      const factor = target / len;
      for (let i = 0; i < first; i++) { regions[i].ratio *= factor; regions[i].squeezed = factor; }
      layout();
    }
  }
  return regions;
}

/** Beats of the dominant grid at `ticks`, from a `beatMap`. */
export function beatAt(map: BeatRegion[], ticks: number, ppq: number): number {
  let lo = 0, hi = map.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (map[mid].ticks <= ticks) lo = mid + 1; else hi = mid; }
  const r = map[Math.max(0, lo - 1)];
  return r.beat + ((ticks - r.ticks) / ppq) * r.ratio;
}

/** Upper bound on bar lines examined for the phase: a corrupt file with events hours later cannot stall the analysis. */
const MAX_BAR_LINES = 100_000;

/**
 * Beat offset of bar 0 (`SongMeta.barOffset`): 0, or negative so that the file's bar lines fall on
 * cycle boundaries. Every bar line of the file (each metre region's bars, in the file's own ticks)
 * is mapped onto the dominant grid; the ones whose bar spans a whole number of grid bars (bars in
 * the dominant metre and tempo, or at an exact multiple of it) vote for their phase, weighted by
 * length. A 2/4 pickup before a 4/4 song or a one-bar count-in at another tempo then no longer
 * shifts every later downbeat off the cycle.
 */
export function barPhase(meters: Region<[number, number]>[], endTicks: number, ppq: number, barLen: number, toBeat: (ticks: number) => number): number {
  const votes = new Map<number, number>();
  let count = 0;
  for (let i = 0; i < meters.length; i++) {
    const m = meters[i];
    const next = i + 1 < meters.length ? meters[i + 1].ticks : Math.max(endTicks, m.ticks + 1);
    const barTicks = Math.max(1, Math.round(m.value[0] * (4 / m.value[1]) * ppq));
    for (let t = m.ticks; t < next && count < MAX_BAR_LINES; t += barTicks, count++) {
      const b0 = toBeat(t), b1 = toBeat(Math.min(t + barTicks, next));
      const k = (b1 - b0) / barLen;
      if (k < 0.98 || Math.abs(k - Math.round(k)) > 0.02 * k) continue;
      let phase = Math.round((((b0 % barLen) + barLen) % barLen) * 1000) / 1000;
      if (phase < 0.02 || barLen - phase < 0.02) phase = 0;
      votes.set(phase, (votes.get(phase) ?? 0) + (b1 - b0));
    }
  }
  let best = 0, bestLen = -1;
  for (const [phase, len] of votes) if (len > bestLen || (len === bestLen && phase < best)) { bestLen = len; best = phase; }
  return best > 0 ? best - barLen : 0;
}

// ---------- track statistics ----------

interface TrackStats {
  notes: number;
  avgPitch: number;
  medianPitch: number;
  p10Pitch: number;
  p90Pitch: number;
  /** Share of notes that sound together with another note of the part (any interval). */
  polyphony: number;
  /**
   * Share of notes that sound together with a note at an interval other than a unison or octave:
   * real harmony. A lead doubled in octaves has polyphony near 1 but chordal near 0.
   */
  chordal: number;
  /**
   * Share of onsets that strike three or more pitch classes at once: block chords. A line sung in
   * two-part harmony has a high `chordal` share but no triads.
   */
  triadic: number;
}

/** Two notes are simultaneous when they overlap for at least half of the shorter one. */
function overlapping(a: NoteEvent, b: NoteEvent): boolean {
  const overlap = Math.min(a.start + a.duration, b.start + b.duration) - Math.max(a.start, b.start);
  return overlap >= 0.5 * Math.min(a.duration, b.duration);
}

/** Statistics of a part's notes, which must be sorted by start. */
function stats(notes: NoteEvent[]): TrackStats {
  if (!notes.length) return { notes: 0, avgPitch: 0, medianPitch: 0, p10Pitch: 0, p90Pitch: 0, polyphony: 0, chordal: 0, triadic: 0 };
  const pitches = notes.map((n) => n.pitch).sort((a, b) => a - b);
  const avgPitch = pitches.reduce((a, p) => a + p, 0) / pitches.length;
  let simultaneous = 0, chordal = 0;
  for (let i = 0; i < notes.length; i++) {
    const a = notes[i];
    let hit = false, harmony = false;
    const visit = (b: NoteEvent) => {
      if (!overlapping(a, b)) return;
      hit = true;
      if ((a.pitch - b.pitch) % 12 !== 0) harmony = true;
    };
    for (let j = i - 1; j >= 0 && !harmony && notes[j].start > a.start - 16; j--) visit(notes[j]);
    for (let j = i + 1; j < notes.length && !harmony && notes[j].start < a.start + a.duration; j++) visit(notes[j]);
    if (hit) simultaneous++;
    if (harmony) chordal++;
  }
  let onsets = 0, triads = 0;
  let at = -Infinity;
  let classes = new Set<number>();
  for (const n of notes) {
    if (n.start - at > SAME_ONSET) {
      if (classes.size >= 3) triads++;
      onsets++;
      at = n.start;
      classes = new Set();
    }
    classes.add(n.pitch % 12);
  }
  if (classes.size >= 3) triads++;
  return {
    notes: notes.length,
    avgPitch,
    medianPitch: percentile(pitches, 0.5),
    p10Pitch: percentile(pitches, 0.1),
    p90Pitch: percentile(pitches, 0.9),
    polyphony: simultaneous / notes.length,
    chordal: chordal / notes.length,
    triadic: triads / Math.max(1, onsets),
  };
}

// ---------- sustain pedal ----------

/**
 * Lengthen notes that end while the sustain pedal is down, the way a GM synth would: until the pedal
 * is released, the same pitch is struck again, or `maxExtend` beats have passed.
 */
export function applySustain(notes: NoteEvent[], pedal: { beat: number; down: boolean }[], maxExtend: number): void {
  if (!pedal.length || !notes.length) return;
  const intervals: { start: number; end: number }[] = [];
  let downAt: number | null = null;
  for (const p of pedal) {
    if (p.down && downAt === null) downAt = p.beat;
    else if (!p.down && downAt !== null) { intervals.push({ start: downAt, end: p.beat }); downAt = null; }
  }
  if (downAt !== null) intervals.push({ start: downAt, end: Infinity });
  if (!intervals.length) return;
  const byPitch = new Map<number, number[]>();
  for (const n of notes) { let arr = byPitch.get(n.pitch); if (!arr) byPitch.set(n.pitch, (arr = [])); arr.push(n.start); }
  for (const arr of byPitch.values()) arr.sort((a, b) => a - b);
  for (const n of notes) {
    const end = n.start + n.duration;
    let lo = 0, hi = intervals.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (intervals[mid].start <= end) lo = mid + 1; else hi = mid; }
    const iv = lo > 0 ? intervals[lo - 1] : undefined;
    if (!iv || end >= iv.end) continue;
    let newEnd = Math.min(iv.end, n.start + maxExtend);
    const starts = byPitch.get(n.pitch)!;
    for (const s of starts) if (s > n.start + 1e-9) { newEnd = Math.min(newEnd, s); break; }
    if (newEnd > end) n.duration = newEnd - n.start;
  }
}

// ---------- duplicate parts ----------

interface Part {
  name: string;
  program: number;
  channel: number;
  percussion: boolean;
  /** The program was selected with bank MSB 127 (the Roland MT-32 map, see `resolveBanks`). */
  mt32?: boolean;
  notes: NoteEvent[];
  /** Raw file ticks of each note's onset (parallel to `notes`), for controller look-ups. */
  ticks: number[];
  volume?: number;
  pan?: number;
  remarks: string[];
}

/**
 * A copy of a part played up to this much later is a stereo double or slapback, not a separate
 * musical part: files often carry the lead twice, the second channel delayed by an eighth note or
 * by 100-250 ms. Measured in beats of the file, so the delay is the same note value whatever the
 * section's tempo.
 */
export const MAX_DOUBLE_DELAY = { beats: 0.5, seconds: 0.25 };

/** A note onset for part comparison: pitch and time (any unit). */
export interface Onset { pitch: number; at: number }

/** Onset times per pitch, sorted, for the look-ups below. */
function onsetsByPitch(notes: Onset[]): Map<number, number[]> {
  const byPitch = new Map<number, number[]>();
  for (const n of notes) { let arr = byPitch.get(n.pitch); if (!arr) byPitch.set(n.pitch, (arr = [])); arr.push(n.at); }
  for (const arr of byPitch.values()) arr.sort((x, y) => x - y);
  return byPitch;
}

/** Offset from `at` to the nearest of `starts` within `window`, or undefined. */
function nearestOffset(starts: number[], at: number, window: number): number | undefined {
  let lo = 0, hi = starts.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (starts[mid] < at) lo = mid + 1; else hi = mid; }
  let best: number | undefined;
  for (const k of [lo - 1, lo]) {
    if (k < 0 || k >= starts.length) continue;
    const d = starts[k] - at;
    if (Math.abs(d) <= window && (best === undefined || Math.abs(d) < Math.abs(best))) best = d;
  }
  return best;
}

/**
 * How much of `a` the part `b` also plays: the constant delay between the two copies (median of the
 * offsets between matching pitches, within `maxOffset`) and the number of `a`'s onsets that `b`
 * plays at that delay, within `SAME_ONSET`. Times are in beats of whatever clock the onsets use.
 */
export function matchParts(a: Onset[], b: Onset[], maxOffset: number): { shared: number; offset: number } {
  const byPitch = onsetsByPitch(b);
  const offsets: number[] = [];
  for (const n of a) { const d = nearestOffset(byPitch.get(n.pitch) ?? [], n.at, maxOffset); if (d !== undefined) offsets.push(d); }
  if (!offsets.length) return { shared: 0, offset: 0 };
  const offset = Math.abs(median(offsets)) <= SAME_ONSET ? 0 : median(offsets);
  let shared = 0;
  for (const n of a) if (nearestOffset(byPitch.get(n.pitch) ?? [], n.at + offset, SAME_ONSET) !== undefined) shared++;
  return { shared, offset };
}

export interface DedupeOptions<T> {
  /** Largest delay (in the unit of `onsets`) at which a copy still counts as a double. Default `SAME_ONSET`. */
  maxOffset?: number;
  /** Onset times of a part's notes, parallel to `notes`. Default: the notes' `start` beats. */
  onsets?: (part: T) => number[];
  /** Called for each dropped copy with the part it duplicates and how much later it played. */
  onDrop?: (dropped: T, kept: T, delay: number) => void;
  /** Which of two copies to keep on musical grounds (a bass patch for a low line), or undefined to let the louder one win. */
  prefer?: (a: T, b: T) => T | undefined;
}

/**
 * Drop parts that duplicate another part's notes (same pitches at the same onsets, allowing a few
 * stray differences), including copies played a constant delay of up to `maxOffset` late (a stereo
 * double, a slapback on another channel). Files often carry the same line twice on different
 * channels, or layered on two patches; the copy `prefer` names wins, else the louder copy, or the
 * earlier one when they tie. The original file order is preserved.
 */
export function dedupeParts<T extends { notes: NoteEvent[]; volume?: number }>(parts: T[], opts: DedupeOptions<T> = {}): T[] {
  const maxOffset = opts.maxOffset ?? SAME_ONSET;
  const onsets = (p: T): Onset[] => {
    const at = opts.onsets?.(p);
    return p.notes.map((n, i) => ({ pitch: n.pitch, at: at ? at[i] : n.start }));
  };
  const level = (p: T) => p.notes.length * (p.volume ?? NOMINAL_VOLUME);
  const dropped = new Set<number>();
  for (let i = 0; i < parts.length; i++) {
    if (dropped.has(i)) continue;
    const a = onsets(parts[i]);
    for (let j = i + 1; j < parts.length; j++) {
      if (dropped.has(j)) continue;
      const b = onsets(parts[j]);
      const small = Math.min(a.length, b.length), big = Math.max(a.length, b.length);
      if (small < 2 || small < 0.85 * big) continue;
      // Compare from the smaller part; `delay` is then how much later than parts[i] parts[j] plays.
      const fromI = a.length <= b.length;
      const m = fromI ? matchParts(a, b, maxOffset) : matchParts(b, a, maxOffset);
      if (m.shared < 0.9 * small) continue;
      const delay = fromI ? m.offset : -m.offset;
      const li = level(parts[i]), lj = level(parts[j]);
      const pref = opts.prefer?.(parts[i], parts[j]);
      const keepJ = pref ? pref === parts[j] : lj > li * 1.05 || (lj >= li / 1.05 && delay < 0);
      if (keepJ) { opts.onDrop?.(parts[i], parts[j], -delay); dropped.add(i); break; }
      opts.onDrop?.(parts[j], parts[i], delay);
      dropped.add(j);
    }
  }
  return parts.filter((_, i) => !dropped.has(i));
}

/** Parts with fewer notes than this are stubs: a fill or a stray note left on its own channel. */
export const STUB_NOTES = 8;

/**
 * Fold stubs into the part of the same instrument that plays nearest their register (a lick on a
 * spare channel of the same patch belongs with that instrument), so they neither clutter the code
 * nor count as parts of their own. Stubs of an instrument that has no real part are kept; the
 * compiler decides whether they are worth hearing.
 */
export function foldStubs<T extends { notes: NoteEvent[]; ticks?: number[]; program: number; percussion?: boolean }>(parts: T[]): T[] {
  const med = (p: T) => median(p.notes.map((n) => n.pitch));
  const out: T[] = [];
  for (const p of parts) {
    if (p.percussion || p.notes.length >= STUB_NOTES) { out.push(p); continue; }
    const hosts = parts.filter((h) => h !== p && !h.percussion && h.program === p.program && h.notes.length >= STUB_NOTES);
    if (!hosts.length) { out.push(p); continue; }
    const m = med(p);
    const host = hosts.reduce((best, h) => (Math.abs(med(h) - m) < Math.abs(med(best) - m) ? h : best));
    const merged = host.notes.map((n, i) => ({ n, t: host.ticks?.[i] ?? 0 })).concat(p.notes.map((n, i) => ({ n, t: p.ticks?.[i] ?? 0 })));
    merged.sort((x, y) => x.n.start - y.n.start || x.n.pitch - y.n.pitch);
    host.notes = merged.map((x) => x.n);
    if (host.ticks) host.ticks = merged.map((x) => x.t);
  }
  return out;
}

/** A total silence longer than this (bars) may separate the song from stray events left after it. */
export const STRAY_GAP_BARS = 6;
/** What follows such a silence is stray when its note density is below this share of what precedes it ... */
const STRAY_DENSITY_SHARE = 0.1;
/** ... and it is spread over more than this many bars (a short coda after a pause is music, not litter). */
const STRAY_SPAN_BARS = 32;
/** Longest note kept, in bars: a note-on without a note-off would otherwise hold to the end of the file. */
export const MAX_NOTE_BARS = 8;

/**
 * Drop notes that come after a total silence of more than `STRAY_GAP_BARS` bars when what follows
 * is far sparser than the song before it: corrupt files carry stray, near-silent events hours past
 * the last real note, which would make the song thousands of bars long. A hidden track keeps a
 * song-like density and a short coda after a pause spans only a few bars; both survive. Returns
 * what was dropped.
 */
export function dropTrailingStrays<T extends { notes: NoteEvent[] }>(parts: T[], barLen: number): { dropped: number; atBeat: number } {
  const onsets = parts.flatMap((p) => p.notes.map((n) => n.start)).sort((a, b) => a - b);
  let cut = onsets.length;
  for (let i = onsets.length - 1; i > 0; i--) {
    if (onsets[i] - onsets[i - 1] <= STRAY_GAP_BARS * barLen) continue;
    const span = (onsets[cut - 1] - onsets[i - 1]) / barLen; // the silence belongs to the tail
    const before = i / ((onsets[i - 1] - onsets[0]) / barLen + 1);
    if (span > STRAY_SPAN_BARS && (cut - i) / span < STRAY_DENSITY_SHARE * before) cut = i;
  }
  if (cut === onsets.length) return { dropped: 0, atBeat: 0 };
  const limit = onsets[cut - 1];
  let dropped = 0;
  for (const p of parts) {
    const keep = p.notes.filter((n) => n.start <= limit);
    dropped += p.notes.length - keep.length;
    p.notes = keep;
  }
  return { dropped, atBeat: onsets[cut] };
}

// ---------- roles ----------

/** Patches that usually carry a lead line: synth leads, reeds, pipes, brass solos, harmonica, fiddle. */
const LEAD_PROGRAMS = new Set([22, 40, 56, 57, 59, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 86, 87, 110]);
/** Patches that are almost always rhythm parts. */
const RHYTHM_PROGRAMS = new Set([28]);
/** Drum-like patches (timpani, tinkle bell, agogo, woodblock, taiko, melodic tom, synth drum, reverse cymbal): never the tune, and never the bass by register. */
const PERCUSSIVE_PROGRAMS = new Set([47, 112, 113, 115, 116, 117, 118, 119]);
/** A melody candidate must sound in at least this many bars: a one-bar fill is not the tune, whatever else the file lacks. */
const MELODY_MIN_BARS = 4;
/**
 * A part named as the vocal outranks every instrument only when it carries a share of the song: at
 * least this share of the busiest part's notes, or of the song's bars. Below that it is a token
 * ("Voices" with ten choir notes) and competes on its merits as a backing vocal.
 */
export const VOCAL_NAME_MIN_NOTE_SHARE = 0.1;
export const VOCAL_NAME_MIN_COVERAGE = 0.15;
/** An instrumental candidate (no vocal name, no vocal patch) must sound in this share of the song's bars to be the tune: a four-bar lick in a 100-bar song is a fill. */
export const MELODY_MIN_COVERAGE = 0.1;
/** The singer's range: a line whose mean pitch sits outside E3-C6 is a counter-line, not the tune. */
const VOCAL_RANGE: [number, number] = [52, 84];
/** String sections, choirs and pads: a low sustained line on these is a pedal, not a bass, unless the file says so. */
const PEDAL_PROGRAMS = new Set([48, 49, 50, 51, 52, 53, 54, 88, 89, 90, 91, 92, 93, 94, 95]);
/** A part is a line (a melody candidate) when at most this share of its onsets are block chords. */
const MELODY_MAX_TRIADIC = 0.1;
/** Two parts take turns when their common bars are at most this share of the later part's bars. */
const MELODY_MAX_OVERLAP = 0.1;
/** A part joins a singer's line only when it covers at least this share of the seed's bars (a fill is not a section of the tune). */
const MELODY_SECTION_SHARE = 0.25;
/** ... and when its notes per bar are within this factor of the seed's: a sixteenth-note synth riff is a hook, not a verse of the song sung by the same singer. */
const MELODY_DENSITY_RATIO = 2;
/**
 * Bass patches are only the bass when they sit in a bass register (median below G3): a tune written
 * on a bass patch is a tune. When the name says bass too, the patch is trusted up to middle C.
 */
const BASS_PATCH_MAX_MEDIAN = 55;
const NAMED_BASS_PATCH_MAX_MEDIAN = 60;
/**
 * Patches that carry the bass line whenever they sit in the bass register and play a line: the
 * double bass (a chanson's "Contrebasse", a baroque continuo) and the tuba (a polka's oompah, a
 * brass band's bottom). Not the cello: a cello at A2 under a real bass is a counter-line.
 */
const LOW_LINE_PROGRAMS = new Set([43, 58]);

/**
 * How much a part looks like the tune: a line rather than chords, busy, in the singer's range,
 * spanning a real melodic range, present through the song (linear in coverage: a solo over a
 * quarter of the song cannot beat a line sung through it), mixed up front (a line the file keeps
 * quiet is a counter-line, not the lead), and on a patch that carries leads rather than a muted
 * rhythm guitar. A vocal name wins outright (when the part is substantial, which the caller decides
 * through `nameVocal`); a vocal patch counts two and a half times; a name that says the part is the
 * tune counts `TUNE_NAME_WEIGHT` (see `tuneNameWeight`).
 */
function melodyScore(entry: { name?: string; program: number; volume?: number; notes: NoteEvent[] }, st: TrackStats, nameVocal: boolean, coverage: number): number {
  // A vocal name wins outright only for a part that carries a share of the song (see `substantialVocal`); a token "Voices" part of ten notes is a backing vocal.
  const spread = Math.max(0, st.p90Pitch - st.p10Pitch);
  const range = Math.min(1, Math.max(0.3, spread / 7));
  const patch = LEAD_PROGRAMS.has(entry.program) ? 1.4 : RHYTHM_PROGRAMS.has(entry.program) ? 0.3 : 1;
  const presence = Math.max(0.05, coverage);
  const inRange = st.avgPitch >= VOCAL_RANGE[0] && st.avgPitch <= VOCAL_RANGE[1] ? 1 : 0.3;
  const cc = (entry.volume ?? NOMINAL_VOLUME) / NOMINAL_VOLUME;
  const loudness = Math.min(1.2, Math.max(0.4, Math.sqrt(meanVelocity(entry.notes) * cc * cc / 0.75)));
  // A voice patch is the singer only in the singer's range: a synth choir at F1 is a synth bass.
  const voice = VOCAL_PROGRAMS.has(entry.program) && inRange === 1 ? 2.5 : 1;
  const tune = tuneNameWeight(entry.name ?? '');
  return (nameVocal ? 1000 : 0) + (1 - st.chordal) * Math.min(st.notes, 400) * patch * range * presence * inRange * loudness * voice * tune;
}

/**
 * What the file itself says the part is: a name calling it the melody ("ORGAN - MELODY", "Guitar
 * melody", "Mélodie") counts for more than one calling it a lead ("Lead Guitar", "Lead Synth"),
 * which players use for a solo instrument as much as for the tune. Weaker evidence than a vocal
 * name, which wins outright, but stronger than the note count and the patch: a transcriber who
 * writes "MELODY" on a channel has named the tune, whether or not another part plays more notes on
 * a leadier patch. A "Bass melody" or a part named as the bass is not a candidate at all: its role
 * is settled before the melody is chosen.
 */
const TUNE_NAME_RE = /melod|m[ée]lodi/i;
const LEAD_NAME_RE = /\blead\b/i;
const TUNE_NAME_WEIGHT = 2;
const LEAD_NAME_WEIGHT = 1.5;
function tuneNameWeight(name: string): number {
  if (TUNE_NAME_RE.test(name)) return TUNE_NAME_WEIGHT;
  return LEAD_NAME_RE.test(name) ? LEAD_NAME_WEIGHT : 1;
}

/** Whether a track name says the part is the bass ("Bass", "Syn Bass"; not "Bass Drum"). */
function nameSaysBass(name: string): boolean {
  return BASS_NAME_RE.test(name) && !BASS_DRUM_RE.test(name);
}

/** A string section, choir or pad in the bass register is a bass line rather than a pedal when it plays more than this many notes per beat it sounds in: busier than quarter notes. */
const PEDAL_BASS_DENSITY = 1;

/**
 * The role of a part before the melody is chosen: the bass by patch and register (a bass patch, a
 * part named as the bass, a double bass or tuba line, see `LOW_LINE_PROGRAMS`, or any patch in a
 * genuinely low register), chords by polyphony, else 'other'. `nameVocal` says the track name
 * calls it a singer, which alone keeps a low line out of the bass: a voice *patch* down there (a
 * synth choir at F1) is a synth bass, not a singer. `density` is the part's notes per beat of the
 * bars it sounds in.
 */
function roleFor(entry: Part, st: TrackStats, nameVocal: boolean, density: number): TrackRole {
  if (entry.percussion) return 'drums';
  const named = nameSaysBass(entry.name);
  if (BASS_PROGRAMS.has(entry.program) && st.medianPitch < (named ? NAMED_BASS_PATCH_MAX_MEDIAN : BASS_PATCH_MAX_MEDIAN)) return 'bass';
  if (named && st.medianPitch < BASS_PATCH_MAX_MEDIAN && st.chordal < 0.35) return 'bass';
  if (LOW_LINE_PROGRAMS.has(entry.program) && st.medianPitch < BASS_PATCH_MAX_MEDIAN && st.chordal < 0.35 && !nameVocal) return 'bass';
  if (isLowRegister(entry.program, st, density) && st.chordal < 0.25 && !nameVocal) return 'bass';
  if (st.chordal > 0.45) return 'chords';
  return 'other';
}

/**
 * A genuinely low register: median below G2 (43) and the top decile below D3 (50). Guitar patches
 * must sit below the guitar's own low E (40) to count, so a muted-guitar riff on the bottom strings
 * stays a guitar. A low string-ensemble, choir or pad drone is a pedal, not a bass, and stays
 * 'other', unless it is busier than quarter notes (`PEDAL_BASS_DENSITY`): a synth choir playing
 * eighths at F1 is the song's synth bass. Any other patch down there is a bass whatever the file
 * calls it (a "soprano sax" at A1 is a bass channel that changed program).
 */
function isLowRegister(program: number, st: TrackStats, density: number): boolean {
  if (PERCUSSIVE_PROGRAMS.has(program) || st.p90Pitch >= 50) return false;
  if (PEDAL_PROGRAMS.has(program) && density <= PEDAL_BASS_DENSITY) return false;
  return st.medianPitch < (GUITAR_PROGRAMS.has(program) ? 40 : 43);
}

interface Scored {
  entry: Part;
  st: TrackStats;
  role: TrackRole;
  vocal: boolean;
  nameVocal: boolean;
  /** Bars (from bar 0) in which the part sounds. */
  bars: Set<number>;
  score: number;
}

/**
 * The parts that carry the tune: the best-scoring line on its own, or a group of lines that take
 * turns and score better together. Two kinds of group: the parts of one channel when a singer's
 * channel switches patch per section (any patches), and lines on singer stand-in patches spread
 * over several channels (a sax for the verses, a horn for the chorus: each alone loses to a guitar
 * solo of the same length, together they are the sung line). Guitars and keyboards never join a
 * cross-channel group, and neither does a line far busier than the seed, so a solo or a riff that
 * takes turns with the singer stays a part of its own. An instrumental candidate must be present
 * through `MELODY_MIN_COVERAGE` of the song (a vocal part is exempt: a chorus-only vocal is the tune).
 */
function chooseMelody(scored: Scored[], totalBars: number): Scored[] {
  // A line the file mutes (CC 7 = 0, velocity 1) is a guide track no player would hear, unless it is the
  // sung line itself, which the compiler renders at the vocal floor; and a few notes are never the tune.
  const audible = (s: Scored) => s.nameVocal || isAudible(mixLevel(meanVelocity(s.entry.notes), s.entry.volume), s.entry.notes.length);
  const present = (s: Scored) => s.vocal || s.bars.size >= MELODY_MIN_COVERAGE * totalBars;
  const tunes = scored.filter((s) => s.score > 0 && s.role !== 'drums' && s.role !== 'bass' && s.role !== 'chords' && s.st.triadic <= MELODY_MAX_TRIADIC
    && !PERCUSSIVE_PROGRAMS.has(s.entry.program) && s.entry.notes.length >= STUB_NOTES && s.bars.size >= MELODY_MIN_BARS && audible(s) && present(s));
  let best: Scored[] = [], bestScore = 0;
  const consider = (group: Scored[], score: number) => { if (score > bestScore) { bestScore = score; best = group; } };
  for (const t of tunes) consider([t], t.score);
  const union = (group: Scored[]): number => {
    const notes = group.flatMap((t) => t.entry.notes).sort((a, b) => a.start - b.start || a.pitch - b.pitch);
    const bars = new Set(group.flatMap((t) => [...t.bars]));
    // The group takes the name of whichever section names the line best ("MELODY" for a verse of it),
    // as it takes any member's vocal name: the sections are one part of the arrangement.
    const name = [...group].sort((a, b) => tuneNameWeight(b.entry.name) - tuneNameWeight(a.entry.name))[0].entry.name;
    return melodyScore({ ...group[0].entry, name, notes }, stats(notes), group.some((t) => t.nameVocal), bars.size / totalBars);
  };
  const substantial = [...tunes].sort((a, b) => b.score - a.score);
  const byChannel = new Map<number, Scored[]>();
  for (const t of substantial) { const arr = byChannel.get(t.entry.channel) ?? []; arr.push(t); byChannel.set(t.entry.channel, arr); }
  for (const group of byChannel.values()) {
    if (group.length < 2) continue;
    // Only parts that take turns (a patch change per section), never parts that play together.
    let overlap = 0, total = 0;
    const seen = new Set<number>();
    for (const t of group) { total += t.bars.size; for (const b of t.bars) { if (seen.has(b)) overlap++; seen.add(b); } }
    if (overlap <= MELODY_MAX_OVERLAP * total) consider(group, union(group));
  }
  const standIns = substantial.filter((t) => (t.vocal || SINGER_STANDIN_PROGRAMS.has(t.entry.program)) && t.st.avgPitch >= VOCAL_RANGE[0] && t.st.avgPitch <= VOCAL_RANGE[1]);
  const density = (t: Scored) => t.entry.notes.length / t.bars.size;
  for (const seed of standIns) {
    const group = [seed];
    const covered = new Set(seed.bars);
    for (const t of standIns) {
      if (t === seed || t.bars.size < MELODY_SECTION_SHARE * seed.bars.size) continue;
      if (density(t) > MELODY_DENSITY_RATIO * density(seed) || density(seed) > MELODY_DENSITY_RATIO * density(t)) continue;
      let overlap = 0;
      for (const b of t.bars) if (covered.has(b)) overlap++;
      if (overlap > MELODY_MAX_OVERLAP * t.bars.size) continue;
      group.push(t);
      for (const b of t.bars) covered.add(b);
    }
    if (group.length > 1) consider(group, union(group));
  }
  return best;
}

// ---------- analysis steps ----------

interface Timing {
  ppq: number;
  endTicks: number;
  num: number;
  den: number;
  /** Quarter-note length of one bar of the dominant metre. */
  barLen: number;
  bpm: number;
  barOffset: number;
  toBeat: (ticks: number) => number;
  /** Bar number (from 1) at the given file ticks, for remarks. */
  barOf: (ticks: number) => number;
  remarks: string[];
}

/** Dominant tempo and metre, the beat map, the bar-line phase, and the remarks describing them. */
function readTiming(midi: MidiType, sourceTiming = false): Timing {
  const ppq = midi.header.ppq || 480;
  const endTicks = midi.durationTicks || 0;
  const meters = meterMap(midi);
  const [num, den] = dominant(meters, endTicks);
  const barLen = num * (4 / den);
  const seconds = (ticks: number) => midi.header.ticksToSeconds(ticks);
  const tempos = tempoMap(midi, barLen * ppq, endTicks);
  const bpm = dominant(tempos, endTicks, (a, b) => seconds(b) - seconds(a));
  // Snapped to a microbeat so float noise cannot push a downbeat into the previous bar.
  const beats = beatMap(midi.header.tempos, bpm, ppq, barLen);
  const toBeat = (ticks: number) => Math.round((sourceTiming ? seconds(ticks) * bpm / 60 : beatAt(beats, ticks, ppq)) * 1e6) / 1e6;
  const barOffset = barPhase(meters, endTicks, ppq, barLen, toBeat);
  const barOf = (ticks: number) => Math.floor((toBeat(ticks) - barOffset) / barLen) + 1;
  const remarks: string[] = [];
  if (tempos.length > 1) {
    const list = tempos.slice(0, 4).map((t) => `${t.value} bpm at bar ${barOf(t.ticks)}`);
    // Which of the listed tempos play at a snapped ratio (the beat-map region in force at their tick).
    const snapped = new Map<string, number>();
    for (const t of tempos) {
      if (t.value === bpm) continue;
      const r = beats.filter((b) => b.ticks <= t.ticks).pop() ?? beats[0];
      if (r.snapped) snapped.set(`${t.value} bpm`, r.ratio);
    }
    // A region's ratio is grid beats per file beat, so its speed relative to the dominant tempo is the inverse.
    const speed = (r: number) => (r <= 1 ? `${Math.round(100 / r) / 100}x` : `1/${Math.round(r)}`);
    const how = (k: string, r: number) => (r === 1 ? `${k} is played at ${bpm} bpm` : `${k} plays as exactly ${speed(r)} the dominant tempo (${Math.round(bpm / r)} bpm)`);
    const snapNote = snapped.size ? `; ${[...snapped].map(([k, r]) => how(k, r)).join(', ')} so its bars stay on the grid` : '';
    remarks.push(`tempo changes (${list.join(', ')}${tempos.length > 4 ? ', ...' : ''}) are rendered at the dominant ${bpm} bpm with note timing kept in real time, so the other sections are stretched across the grid${snapNote}`);
  }
  const prefix = beats.findIndex((r) => r.ratio === 1);
  const squeezed = beats[0].squeezed;
  if (prefix > 0 && squeezed !== undefined && Math.abs(squeezed - 1) > 0.002) {
    const bars = Math.round((beats[prefix].ticks / ppq / barLen) * 10) / 10;
    const pct = Math.round(Math.abs(squeezed - 1) * 1000) / 10;
    remarks.push(`the ${bars} bar${bars === 1 ? '' : 's'} at ${Math.round(beats[0].bpm)} bpm before the ${bpm} bpm section ${bars === 1 ? 'is' : 'are'} ${squeezed > 1 ? 'stretched' : 'squeezed'} by ${pct}% so the section's first downbeat lands on the cell grid`);
  }
  if (meters.length > 1) {
    const list = meters.slice(0, 4).map((m) => `${m.value[0]}/${m.value[1]} at bar ${barOf(m.ticks)}`);
    remarks.push(`metre changes (${list.join(', ')}${meters.length > 4 ? ', ...' : ''}) are rendered on a constant ${num}/${den} grid of one bar per cycle`);
  }
  if (sourceTiming) {
    remarks.splice(0, remarks.length, ...(tempos.length > 1 ? ['Tempo changes preserved in elapsed time; displayed bars use the dominant tempo.'] : []));
  }
  return { ppq, endTicks, num, den, barLen, bpm, barOffset, toBeat, barOf, remarks };
}

/**
 * Notes merged into parts per channel and program (many files split one part over several tracks,
 * and a channel can switch programs mid-song), every drum channel into one percussion part.
 */
function readParts(midi: MidiType, channels: Map<number, ChannelState>, time: Timing, maps: SoundMap, rhythm: Set<number>, names: Map<number, string>, song: SongName): { parts: Part[]; pitchBends: number } {
  const merged = new Map<string, Part>();
  let pitchBends = 0;
  for (const t of midi.tracks as ToneTrack[]) {
    if (!t.notes.length) continue;
    pitchBends += t.pitchBends.length;
    const st = channels.get(t.channel);
    // Channel 10 is always the kit; GS files can declare more rhythm parts by sysex, and XG files turn a channel into a drum kit with bank MSB 127.
    const xgKit = maps.xg && !maps.gs && !!st && bankAt(st, t.notes[0].ticks) === MT32_BANK;
    const percussion = t.instrument.percussion || t.channel === 9 || rhythm.has(t.channel) || xgKit;
    for (const n of t.notes) {
      const program = percussion ? -1 : st?.programs.length ? valueAt(st.programs, n.ticks, t.instrument.number) : t.instrument.number;
      const mt32 = !percussion && !maps.xg && !!st && bankAt(st, n.ticks) === MT32_BANK;
      const key = percussion ? 'drums' : `${t.channel}:${mt32 ? 'mt32' : 'gm'}:${program}`;
      let entry = merged.get(key);
      if (!entry) {
        entry = { name: partName(rawName(t.name), song) || partName(names.get(t.channel), song), program, channel: t.channel, percussion, ...(mt32 ? { mt32 } : {}), notes: [], ticks: [], remarks: [] };
        merged.set(key, entry);
      } else if (!entry.name && t.name) entry.name = partName(rawName(t.name), song);
      const transpose = percussion || !st ? 0 : valueAt(st.transpose, n.ticks, 0);
      const start = time.toBeat(n.ticks);
      entry.notes.push({
        pitch: Math.max(0, Math.min(127, n.midi + transpose)),
        start,
        duration: Math.min(MAX_NOTE_BARS * time.barLen, Math.max(time.toBeat(n.ticks + n.durationTicks) - start, 0.000001)),
        velocity: n.velocity,
        ...(st && (st.volume.length || st.expression.length) ? { volume: (valueAt(st.volume, n.ticks, 100) / 127) * (valueAt(st.expression, n.ticks, 127) / 127) } : {}),
        ...(st?.pan.length ? { pan: valueAt(st.pan, n.ticks, 64) / 127 } : {}),
      });
      entry.ticks.push(n.ticks);
    }
  }
  for (const e of merged.values()) {
    const order = e.notes.map((_, i) => i).sort((i, j) => e.notes[i].start - e.notes[j].start || e.notes[i].pitch - e.notes[j].pitch);
    e.notes = order.map((i) => e.notes[i]);
    e.ticks = order.map((i) => e.ticks[i]);
  }
  return { parts: [...merged.values()], pitchBends };
}

/**
 * Which patch table the file's programs belong to, and the parts read through it.
 *
 * Programs selected with bank MSB 127: on Roland GS devices that bank is the MT-32 map, and the
 * programs must be read through the MT-32 patch table (Stairway to Heaven's "a guitar" is MT-32
 * patch 59 "Guitar 1", which is a muted trumpet in General MIDI). Some General MIDI files carry a
 * stray 127 too, so the bank is trusted per file on the evidence of every part that uses it: a track
 * name that is one table's patch name and not the other's, or fits one table's family and not the
 * other's, a bass patch that sits in a bass register (or does not), an effects patch carrying a
 * real part; a GS reset adds a vote for the MT-32 map, which also wins a tie because the file asked
 * for it. XG files never get here: their bank 127 is a drum kit, handled in `readParts`.
 *
 * Files that never send a bank select can still be MT-32 files (authored on the device, before
 * General MIDI): their track names are then the MT-32 patch names at those program numbers ("Sq
 * Wave" on 47, "Doc Solo" on 44, "El Guitar" on 62), which read through the General MIDI table
 * come out as timpani, tremolo strings and synth brass. When at least `MT32_NAME_VOTES` channels
 * carry the MT-32 name of their program and not the General MIDI one, and they outnumber the
 * channels named the General MIDI way by more than two to one, the whole file is read through the
 * MT-32 table. Names that fit both tables (Flute on 73: "Flute 2" and "flute") count for neither.
 *
 * A bank-127 part whose name states an instrument family that neither reading satisfies ("Les Paul"
 * and "Overdrive Guitar" on 33: a bass in General MIDI, "Harmo Pan" on the MT-32) is played on the
 * named family's patch: the name is stronger evidence than a program number both tables disagree with.
 *
 * Plain General MIDI parts get the same hearing (`reconcileGm`): a name that states a definite
 * family the patch contradicts ("ORGAN - MELODY" on program 0, the piano every channel starts on;
 * "Guitar" on a piano; "Bass" on a guitar) is played on the named family's patch, with a remark.
 * A name that fits its patch (`nameFitsPatch`: the patch's own name, its family, a family that
 * stands in for it, or a synth asked for on a synth) is left alone, as is a channel that changes
 * family mid-song, an effects patch (dropped later anyway), a name that is the MT-32 patch name of
 * its program, and a vocal patch (see `reconcileGm` for those last two).
 *
 * Returns the remarks describing the decisions, if any.
 */
function resolveBanks(parts: Part[], maps: SoundMap): string[] {
  const pitched = parts.filter((p) => !p.percussion && p.notes.length);
  const banked = pitched.filter((p) => p.mt32);
  const remarks: string[] = [];
  const describe = (p: Part) => `ch ${p.channel + 1} ${p.name ? `"${p.name}" ` : ''}`;
  const reconciled: string[] = [];
  // A channel that switches between instrument families mid-song ("Str etc." on strings, then guitars) is
  // named for its first instrument only: its name overrules none of its parts.
  const familiesOf = (ch: number, useMt32: boolean) => new Set(pitched.filter((q) => q.channel === ch).map((q) => family(useMt32 ? MT32_TO_GM[q.program] : q.program)));
  const bassRegister = (p: Part) => median(p.notes.map((n) => n.pitch)) < BASS_PATCH_MAX_MEDIAN;
  /** Read `p` through the table chosen for it, unless its name overrules (see `reconcileName`). */
  const apply = (p: Part, useMt32: boolean, renamed: string[]) => {
    const gmProgram = p.program;
    if (useMt32 && MT32_TO_GM[gmProgram] !== gmProgram) renamed.push(`${describe(p)}${MT32_NAMES[gmProgram]} -> ${gmLabel(MT32_TO_GM[gmProgram])}`);
    const chosen = useMt32 ? MT32_TO_GM[gmProgram] : gmProgram;
    // A part named after the chosen table's own patch ("Warm Bell" on MT-32 38) is what the table says, whatever family the name suggests.
    const trusted = nameSaysPatch(p.name, useMt32 ? MT32_NAMES[gmProgram] : GM_INSTRUMENTS[gmProgram]) || familiesOf(p.channel, useMt32).size > 1 || nameFitsPatch(p.name, chosen);
    const r = trusted ? { program: chosen } : reconcileName(p.name, chosen, useMt32 ? gmProgram : MT32_TO_GM[gmProgram]);
    p.program = r.program;
    if (r.why) reconciled.push(`"${p.name}" ${r.why}`);
    delete p.mt32;
  };
  /**
   * Let the names of plain General MIDI parts overrule a patch of a family they contradict. Three
   * patches keep the program the file wrote whatever the name says:
   * - an effects patch (dropped from the arrangement anyway);
   * - a part whose name is the MT-32 patch name of its program and not the General MIDI one
   *   ("bass" on 64, the MT-32 "Acou Bass 1"): the file is speaking MT-32, not contradicting its
   *   own patch, and whether the file is read through that table is `mt32NameVote`'s decision for
   *   the file as a whole. Below its threshold the program stands as written and the part's
   *   register and role pick its sound (a "bass" at E2 on a sax plays on `BASS_FALLBACK_SOUND`);
   * - a vocal patch the name calls the bass, down in the bass register: the arrangement never plays
   *   a voice, and a voice patch there is already read as the bass and re-voiced onto a synth bass
   *   (`VOICE_BASS_SOUND`), which needs to see the voice the file wrote. Any other name overrules a
   *   vocal patch as it does any other ("Alto Saxophone" on choir aahs is a saxophone).
   */
  const reconcileGm = (list: Part[]) => {
    for (const p of list) {
      if (!p.name || FX_PROGRAMS.has(p.program) || familiesOf(p.channel, false).size > 1 || nameFitsPatch(p.name, p.program)) continue;
      if (tableForName(p.name, p.program) === 'mt32') continue;
      if (VOCAL_PROGRAMS.has(p.program) && nameSaysBass(p.name) && bassRegister(p)) continue;
      const r = reconcileName(p.name, p.program);
      if (!r.why) continue;
      reconciled.push(`ch ${p.channel + 1} "${p.name}" ${r.why}`);
      p.program = r.program;
    }
  };
  if (!banked.length) {
    const vote = mt32NameVote(pitched, maps);
    if (vote.mt32.length >= MT32_NAME_VOTES && vote.mt32.length > 2 * vote.gm.length) {
      const renamed: string[] = [];
      const named = vote.mt32.map((p) => `"${p.name}" on ${p.program}`).join(', ');
      for (const p of pitched) apply(p, true, renamed);
      remarks.push(`track names are the Roland MT-32 patch names at their program numbers (${named}), so with no bank select the whole file is read through the MT-32 patch table: ${renamed.join('; ')}`);
    } else reconcileGm(pitched);
    if (reconciled.length) remarks.push(reconciled.join('; '));
    mergeSameProgram(parts);
    return remarks;
  }
  let mt32 = maps.gs ? 1 : 0, gm = 0;
  for (const p of banked) {
    const table = tableForName(p.name, p.program);
    if (table === 'mt32') mt32 += 2; else if (table === 'gm') gm += 2;
    const gmFamily = family(p.program), mtFamily = family(MT32_TO_GM[p.program]);
    if (gmFamily === mtFamily) continue;
    const named = nameFamily(p.name);
    if (named && !table) { if (named === mtFamily) mt32 += 2; else if (named === gmFamily) gm += 2; }
    const low = bassRegister(p);
    if (gmFamily === 'bass') { if (low) gm++; else mt32++; }
    if (mtFamily === 'bass') { if (low) mt32++; else gm++; }
    if (gmFamily === 'fx' && mtFamily !== 'fx' && p.notes.length >= 4 * STUB_NOTES) mt32++;
    if (mtFamily === 'fx' && gmFamily !== 'fx' && p.notes.length >= 4 * STUB_NOTES) gm++;
  }
  const channels = [...new Set(banked.map((p) => p.channel + 1))].sort((a, b) => a - b).join(', ');
  const useMt32 = mt32 >= gm;
  const renamed: string[] = [];
  const unbanked = pitched.filter((p) => !p.mt32);
  for (const p of banked) apply(p, useMt32, renamed);
  if (useMt32) remarks.push(`bank select 127 (Roland MT-32 map) read through the MT-32 patch table: ${renamed.join('; ')}`);
  else remarks.push(`bank select 127 on channel${channels.includes(',') ? 's' : ''} ${channels} is ignored: the parts fit General MIDI, not the Roland MT-32 map it names`);
  reconcileGm(unbanked);
  if (reconciled.length) remarks.push(reconciled.join('; '));
  mergeSameProgram(parts);
  return remarks;
}

/**
 * The program a part plays once its name has its say: `chosen` is the reading of the table decided
 * for the file, `other` the other table's. A name that states a definite instrument family (see
 * `DEFINITE_FAMILIES`) is stronger evidence than a program number: when the chosen reading is not
 * that family but the other table's is, the other reading wins for this part ("Bass" on 34 in an
 * MT-32-named file is a bass, not the "Chorale"); when neither is, the family's own patch does
 * ("Les Paul" on bank-127 program 33: a bass in General MIDI, "Harmo Pan" on the MT-32, played on an
 * overdriven guitar). Without `other` (a plain General MIDI part) the one reading is the program
 * itself, and the family's patch wins when it is not that family ("Guitar" on the piano a channel
 * starts on). Returns the program and the reason, if the name changed anything.
 */
export function reconcileName(name: string, chosen: number, other: number = chosen): { program: number; why?: string } {
  const named = nameFamily(name);
  if (!named || !DEFINITE_FAMILIES.has(named) || family(chosen) === named) return { program: chosen };
  const label = named === 'strings' ? 'string part' : named;
  const as = `named as ${/^[aeiou]/.test(label) ? 'an' : 'a'} ${label}`;
  if (other !== chosen && family(other) === named) return { program: other, why: `${as}, played on ${gmLabel(other)} (the other patch table's reading)` };
  const program = programForName(name, named);
  const reason = other !== chosen ? 'neither patch table reads its program as one' : `its ${gmLabel(chosen)} patch is not one`;
  return { program, why: `${as}, played on ${gmLabel(program)} (${reason})` };
}

/** Channels named the MT-32 way needed before a bank-less file is read through the MT-32 table. */
export const MT32_NAME_VOTES = 2;

/**
 * The named pitched parts whose name is the MT-32 patch name of their program and not the General
 * MIDI label (`mt32`), and the reverse (`gm`), one per channel (a channel that changes program votes
 * by its first program). An XG or General MIDI reset says which table the file is for and settles it.
 */
function mt32NameVote(pitched: Part[], maps: SoundMap): { mt32: Part[]; gm: Part[] } {
  const out = { mt32: [] as Part[], gm: [] as Part[] };
  if (maps.xg || maps.gm) return out;
  const seen = new Set<number>();
  for (const p of pitched) {
    if (!p.name || seen.has(p.channel)) continue;
    seen.add(p.channel);
    const table = tableForName(p.name, p.program);
    if (table) out[table].push(p);
  }
  return out;
}

/**
 * Merge parts of one channel that ended up on the same program: a remap can land on the channel's
 * existing General MIDI part, and a stray bank select mid-track splits an unchanged program into a
 * banked and an unbanked part. Notes are re-sorted; a name is kept if either part has one.
 */
function mergeSameProgram(parts: Part[]): void {
  const byKey = new Map<string, Part>();
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p.percussion) continue;
    const key = `${p.channel}:${p.program}`;
    const host = byKey.get(key);
    if (!host) { byKey.set(key, p); continue; }
    const merged = host.notes.map((n, k) => ({ n, t: host.ticks[k] })).concat(p.notes.map((n, k) => ({ n, t: p.ticks[k] })));
    merged.sort((x, y) => x.n.start - y.n.start || x.n.pitch - y.n.pitch);
    host.notes = merged.map((x) => x.n);
    host.ticks = merged.map((x) => x.t);
    if (!host.name) host.name = p.name;
    parts.splice(i, 1);
  }
}

/** A controller that moves by at least this much (0-1) between the 10th and 90th percentile of a part's notes is noted. */
const CC_MOVES = 0.3;

/** A controller's value at each note onset, summarised: the median, the mean, and whether it moves (10th to 90th percentile, 0-1). */
function overNotes(values: number[]): { median: number; mean: number; low: number; high: number; varies: boolean } {
  const sorted = [...values].sort((a, b) => a - b);
  const low = percentile(sorted, 0.1), high = percentile(sorted, 0.9);
  return { median: median(values), mean: values.reduce((a, b) => a + b, 0) / Math.max(1, values.length), low, high, varies: high - low >= CC_MOVES };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * Mix, sustain and tuning from the channel controllers. The level (CC 7 x CC 11) is the median
 * over the part's notes so a fade-out does not set the level of the whole part; the pan is the
 * median too, or the mean when it moves (a line centred for the verse and hard left later sits
 * between, rather than hard left throughout); both movements are noted on the part.
 */
function applyControllers(parts: Part[], channels: Map<number, ChannelState>, time: Timing): string[] {
  let sustained = false;
  let transposed = false;
  for (const e of parts) {
    const st = channels.get(e.channel);
    if (!st) continue;
    if (st.volume.length || st.expression.length) {
      const level = overNotes(e.ticks.map((t) => (valueAt(st.volume, t, 100) / 127) * (valueAt(st.expression, t, 127) / 127)));
      e.volume = Math.round(level.median * 1000) / 1000;
      // Swell instruments can start every note almost silent, then raise expression while it is
      // held. Measuring only note-on levels can discard the entire song (e.g. Cathedral).
      if (e.volume < 0.05) {
        const ticks = [...new Set([...st.volume, ...st.expression].map(p => p.ticks))].sort((a, b) => a - b);
        const changes = ticks.map(t => ({ beat: time.toBeat(t), level: (valueAt(st.volume, t, 100) / 127) * (valueAt(st.expression, t, 127) / 127) }));
        const sustained = e.notes.map((n, i) => {
          const end = n.start + n.duration;
          let from = n.start, current = (valueAt(st.volume, e.ticks[i], 100) / 127) * (valueAt(st.expression, e.ticks[i], 127) / 127), sum = 0;
          for (const change of changes) {
            if (change.beat <= from) continue;
            if (change.beat >= end) break;
            sum += (change.beat - from) * current;
            from = change.beat;
            current = change.level;
          }
          return (sum + (end - from) * current) / n.duration;
        });
        const heldLevel = Math.round(median([...sustained].sort((a, b) => a - b)) * 1000) / 1000;
        if (heldLevel > e.volume && heldLevel >= 0.05) {
          e.volume = heldLevel;
          e.notes.forEach((n, i) => { n.volume = sustained[i]; });
          e.remarks.push('volume swells after note-on; mean controller level during held notes used');
        }
      }
      if (level.varies) e.remarks.push(`level moves ${pct(level.low)}-${pct(level.high)} (CC 7 x CC 11), median used`);
    }
    if (st.pan.length) {
      const pan = overNotes(e.ticks.map((t) => valueAt(st.pan, t, 64) / 127));
      const position = (p: number) => Math.round(Math.max(0, Math.min(1, 0.5 + (p * 127 - 64) / 127)) * 100) / 100;
      e.pan = position(pan.varies ? pan.mean : pan.median);
      if (pan.varies) e.remarks.push(`pan moves ${Math.round(pan.low * 127)}-${Math.round(pan.high * 127)} (CC 10), mean used`);
    }
    if (!e.percussion && st.sustain.length) {
      const pedal = st.sustain.map((p) => ({ beat: time.toBeat(p.ticks), down: p.value >= 64 }));
      const before = e.notes.reduce((a, n) => a + n.duration, 0);
      applySustain(e.notes, pedal, 2 * time.barLen);
      if (e.notes.reduce((a, n) => a + n.duration, 0) > before + 1e-9) sustained = true;
    }
    if (!e.percussion && st.transpose.some((p) => p.value !== 0)) transposed = true;
  }
  const remarks: string[] = [];
  if (sustained) remarks.push('sustain pedal (CC 64) lengthens the held notes');
  if (transposed) remarks.push('coarse tuning (RPN 2) transposes the affected channels');
  return remarks;
}

/** A doubled line whose median pitch is below this (A2) is a bass line: of two copies, the one on a bass patch is kept. */
const DOUBLE_BASS_MEDIAN = 45;

/**
 * Of two copies of the same line on different patches, the copy whose patch fits the register: the
 * bass patch for a low line (a bass doubled by a guitar or piano stays the bass, however loud the
 * double), the other patch for a tune above the bass register (a tune doubled on a bass patch is
 * not a bass). Undefined when neither or both are bass patches, or in between.
 */
function preferByRegister(a: Part, b: Part): Part | undefined {
  const bassA = BASS_PROGRAMS.has(a.program), bassB = BASS_PROGRAMS.has(b.program);
  if (bassA === bassB) return undefined;
  const med = median(a.notes.map((n) => n.pitch));
  if (med < DOUBLE_BASS_MEDIAN) return bassA ? a : b;
  if (med >= BASS_PATCH_MAX_MEDIAN) return bassA ? b : a;
  return undefined;
}

/** Drum-like melodic patches (timpani, tinkle bell, agogo, steel drums, woodblock, taiko, melodic tom, synth drum) on which a named single-pitch part is one drum of the kit. */
const DRUM_PATCH_PROGRAMS = new Set([112, 113, 114, 115, 116, 117, 118]);
/** What a drum part's name calls it, and the General MIDI kit key it is played on. */
const DRUM_NAME_KEYS: [RegExp, number][] = [
  [/snare/i, 38], [/kick|bass\s*drum/i, 36], [/\btom/i, 47], [/clap/i, 39], [/rim|stick/i, 37], [/cowbell|cow\s*bell/i, 56],
  [/tamb/i, 54], [/shaker|cabasa|maraca/i, 70], [/crash/i, 49], [/ride/i, 51], [/hi-?\s*hat|hihat/i, 42],
];

/**
 * Fold a pitched part that is really one drum into the kit: a part named "Snare Drum" on a
 * drum-like melodic patch (the MT-32's "Elec Perc" reads as a synth drum) struck on a single pitch
 * is the snare, not a synth drum hammering one note through the song. A file with no percussion
 * channel gets its kit from the first such part, and the others fold into it, so the song never
 * has two drum parts. Returns the remarks.
 */
export function foldDrumParts(parts: Part[]): string[] {
  const remarks: string[] = [];
  let kit = parts.find((p) => p.percussion);
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p.percussion || !DRUM_PATCH_PROGRAMS.has(p.program) || !p.notes.length || new Set(p.notes.map((n) => n.pitch)).size > 1) continue;
    const key = DRUM_NAME_KEYS.find(([re]) => re.test(p.name))?.[1];
    if (key === undefined) continue;
    const label = gmLabel(p.program);
    for (const n of p.notes) n.pitch = key;
    remarks.push(`ch ${p.channel + 1} "${p.name}" (${label} patch on one pitch) is played as the kit's ${drumWord(key)}`);
    const host = kit;
    if (host && host !== p) {
      const merged = host.notes.map((n, k) => ({ n, t: host.ticks[k] })).concat(p.notes.map((n, k) => ({ n, t: p.ticks[k] })));
      merged.sort((x, y) => x.n.start - y.n.start || x.n.pitch - y.n.pitch);
      host.notes = merged.map((x) => x.n);
      host.ticks = merged.map((x) => x.t);
      parts.splice(i, 1);
    } else {
      p.percussion = true;
      p.program = -1;
      kit = p;
    }
  }
  return remarks;
}

function drumWord(key: number): string {
  return { 38: 'snare', 36: 'kick', 47: 'tom', 39: 'clap', 37: 'rimshot', 56: 'cowbell', 54: 'tambourine', 70: 'shaker', 49: 'crash', 51: 'ride', 42: 'hi-hat' }[key] ?? 'drum';
}

/** Drop effects patches and stray events after the song, then duplicates, then fold stubs into their instrument. */
function cleanParts(parts: Part[], time: Timing): { parts: Part[]; remarks: string[] } {
  const remarks: string[] = [];
  remarks.push(...foldDrumParts(parts));
  const kept = parts.filter((e) => !(e.program >= 0 && FX_PROGRAMS.has(e.program)));
  const strays = dropTrailingStrays(kept, time.barLen);
  if (strays.dropped) remarks.push(`${strays.dropped} stray notes after a silence of more than ${STRAY_GAP_BARS} bars (from bar ${Math.floor((strays.atBeat - time.barOffset) / time.barLen) + 1}) are dropped`);
  const doubles: string[] = [];
  const describe = (p: Part) => `ch ${p.channel + 1} ${p.name ? `"${p.name}" ` : ''}${gmLabel(p.program)}`;
  // Doubles are compared on the file's own clock (ticks), so a delay of an eighth stays an eighth
  // through a tempo change.
  const deduped = dedupeParts(kept.filter((e) => e.notes.length), {
    maxOffset: Math.max(MAX_DOUBLE_DELAY.beats, MAX_DOUBLE_DELAY.seconds * time.bpm / 60),
    onsets: (p) => p.ticks.map((t) => t / time.ppq),
    prefer: preferByRegister,
    onDrop: (d, k, delay) => {
      const beats = Math.round(Math.abs(delay) * 1000) / 1000;
      doubles.push(`${describe(d)} (copy of ${describe(k)}${beats >= 0.02 ? `, ${beats} beats ${delay > 0 ? 'late' : 'early'}` : ''})`);
    },
  });
  if (doubles.length) remarks.push(`duplicate parts dropped: ${doubles.join('; ')}`);
  return { parts: foldStubs(deduped).filter((e) => e.notes.length), remarks };
}

/** Roles for the cleaned parts (`roleFor`, then the melody by `chooseMelody`), as song tracks. */
function assignRoles(candidates: Part[], time: Timing): Track[] {
  let songEnd = 0;
  for (const e of candidates) for (const n of e.notes) songEnd = Math.max(songEnd, n.start + n.duration);
  const totalBars = Math.max(1, Math.ceil((songEnd - time.barOffset) / time.barLen));
  const busiest = Math.max(0, ...candidates.filter((e) => !e.percussion).map((e) => e.notes.length));
  const scored: Scored[] = candidates.map((entry) => {
    const st = stats(entry.notes);
    const named = nameSaysVocal(entry.name);
    const vocal = !entry.percussion && (named || VOCAL_PROGRAMS.has(entry.program));
    const bars = barsOf(entry, time);
    // A part the file calls the bass, or a voice patch playing a bass line, is the bass, never a singer (see `soundFor`).
    const role = roleFor(entry, st, named, entry.notes.length / Math.max(1, bars.size * time.barLen));
    if (role === 'bass' && vocal) return { entry, st, role, vocal: false, nameVocal: false, bars, score: -1 };
    // The vocal name outranks every instrument only for a substantial part (see `VOCAL_NAME_MIN_NOTE_SHARE`).
    const nameVocal = named && (entry.notes.length >= VOCAL_NAME_MIN_NOTE_SHARE * busiest || bars.size >= VOCAL_NAME_MIN_COVERAGE * totalBars);
    const score = role === 'drums' || role === 'bass' ? -1 : melodyScore(entry, st, nameVocal, bars.size / totalBars);
    return { entry, st, role, vocal, nameVocal, bars, score };
  });
  capRegisterBasses(scored);
  const melody = chooseMelody(scored, totalBars);
  for (const w of melody) w.role = 'melody';
  // A melody in several parts that take turns is the sung line when the parts are what a
  // transcriber uses for a singer (a vocal part among them, or every part a singer stand-in: a sax
  // for the verse, a horn for the chorus); the compiler then plays all of it on the melody sound.
  // A channel that merely switches between a piano and a guitar per section is an instrumental
  // lead in sections and keeps its patches.
  const sung = melody.length > 1 && (melody.some((s) => s.vocal) || melody.every((s) => SINGER_STANDIN_PROGRAMS.has(s.entry.program)));
  if (sung) for (const w of melody) w.vocal = true;
  return scored.map((s) => ({
    name: s.entry.name,
    program: s.entry.program,
    role: s.role,
    notes: s.entry.notes,
    channel: s.entry.channel,
    ...(s.entry.volume !== undefined ? { volume: s.entry.volume } : {}),
    ...(s.entry.pan !== undefined ? { pan: s.entry.pan } : {}),
    ...(s.vocal ? { vocal: true } : {}),
    ...(melody.length > 1 && s.role === 'melody' ? { sungLine: true } : {}),
    ...(s.entry.remarks.length ? { remarks: s.entry.remarks } : {}),
  }));
}

/** The bars (from bar 0) in which a part sounds. */
function barsOf(entry: Part, time: Timing): Set<number> {
  return new Set(entry.notes.map((n) => Math.floor((n.start - time.barOffset) / time.barLen)));
}

/**
 * A song with a part on a bass patch (or named as the bass) keeps at most one more bass by register
 * alone: a low guitar or piano line doubling the bass is a doubling, not a second bass, and the rest
 * are labelled 'other' so the bass slot and the bass sound go to the real thing.
 */
function capRegisterBasses(scored: Scored[]): void {
  const isBass = (s: Scored) => s.role === 'bass';
  const declared = scored.filter((s) => isBass(s) && (BASS_PROGRAMS.has(s.entry.program) || nameSaysBass(s.entry.name)));
  if (!declared.length) return;
  const byRegister = scored.filter((s) => isBass(s) && !declared.includes(s)).sort((a, b) => b.entry.notes.length - a.entry.notes.length);
  for (const s of byRegister.slice(1)) s.role = 'other';
}

/** The key: a key signature when the file has a trustworthy one, otherwise estimated from the pitched notes. */
function detectKey(midi: MidiType, tracks: Track[]): { tonic?: string; mode?: 'major' | 'minor' } {
  const ks = midi.header.keySignatures[0];
  // A C major signature at tick 0 is the file-format default and usually means "unknown".
  if (ks && ks.key && !(ks.key === 'C' && ks.scale !== 'minor')) return { tonic: ks.key, mode: ks.scale === 'minor' ? 'minor' : 'major' };
  const hist = new Array(12).fill(0);
  for (const t of tracks) if (t.role !== 'drums') for (const n of t.notes) hist[n.pitch % 12] += n.duration;
  const k = estimateKey(hist);
  return k.confidence > 0.5 ? { tonic: pcName(k.tonic), mode: k.mode } : {};
}

// ---------- main ----------

export function songFromMidi(data: Uint8Array, identity: MidiIdentity, opts: { sourceTiming?: boolean } = {}): Song {
  const midi = new Midi(data);
  const time = readTiming(midi, opts.sourceTiming ?? true);
  const events = scanChannelEvents(data);
  const channels = channelStates(events);
  const maps = soundMap(events);
  const rhythm = new Set(events.filter((e) => e.kind === 'rhythm' && e.value > 0).map((e) => e.channel));
  const remarks = [...time.remarks];
  const { parts, pitchBends } = readParts(midi, channels, time, maps, rhythm, scanTrackNames(data), identity);
  if (pitchBends) remarks.push('pitch bends are ignored');
  remarks.push(...resolveBanks(parts, maps));
  remarks.push(...applyControllers(parts, channels, time));
  const cleaned = cleanParts(parts, time);
  remarks.push(...cleaned.remarks);
  const tracks = assignRoles(cleaned.parts, time);
  const meta: SongMeta = {
    id: identity.id,
    title: identity.title,
    artist: identity.artist,
    bpm: time.bpm,
    beatsPerBar: time.num,
    beatUnit: time.den,
    ...detectKey(midi, tracks),
    year: identity.year,
    sources: ['midi'],
    ...(time.barOffset ? { barOffset: time.barOffset } : {}),
    ...(remarks.length ? { remarks } : {}),
  };
  const song: Song = { meta, sections: [], tracks };
  song.sections = detectSectionsFromMidi(song);
  return song;
}

/** Quarter-note length of one bar. */
export function barLength(meta: SongMeta): number {
  return meta.beatsPerBar * (4 / meta.beatUnit);
}

/** Beat position of the downbeat of bar `i` (bar 0 may start before beat 0 when a pickup bar precedes it). */
export function barStart(meta: SongMeta, i: number): number {
  return (meta.barOffset ?? 0) + i * barLength(meta);
}

/** Index of the bar containing beat `beat`. */
export function barIndex(meta: SongMeta, beat: number): number {
  return Math.floor((beat - (meta.barOffset ?? 0)) / barLength(meta) + 1e-9);
}

/** Bars per minute, which is what Strudel's setcpm wants when one cycle is one bar. */
export function cyclesPerMinute(meta: SongMeta): number {
  return meta.bpm / barLength(meta);
}

/** Detect a chord per bar from the harmonic tracks and emit a single section. */
export function detectSectionsFromMidi(song: Song): Section[] {
  const bar = barLength(song.meta);
  const pitched = song.tracks.filter((t) => t.role !== 'drums');
  if (!pitched.length) return [];
  let end = 0;
  for (const t of pitched) for (const n of t.notes) end = Math.max(end, n.start + n.duration);
  const bars = barIndex(song.meta, end - 1e-6) + 1;
  const preferFlats = !!song.meta.tonic && song.meta.tonic.includes('b');
  const chords: ChordEvent[] = [];
  for (let b = 0; b < bars; b++) {
    const w = new Array(12).fill(0);
    const bassHist = new Array(12).fill(0);
    const b0 = barStart(song.meta, b), b1 = b0 + bar;
    for (const t of pitched) {
      for (const n of t.notes) {
        if (n.start >= b1 || n.start + n.duration <= b0) continue;
        const overlap = Math.min(b1, n.start + n.duration) - Math.max(b0, n.start);
        const weight = overlap * (t.role === 'melody' ? 0.5 : 1);
        w[n.pitch % 12] += weight;
        if (t.role === 'bass' || n.pitch < 50) bassHist[n.pitch % 12] += overlap;
      }
    }
    let bassPc: number | undefined;
    const bmax = Math.max(...bassHist);
    if (bmax > 0) bassPc = bassHist.indexOf(bmax);
    const symbol = detectChord(w, bassPc, preferFlats);
    const tail = chords[chords.length - 1];
    if (tail && tail.symbol === symbol) tail.beats += song.meta.beatsPerBar;
    else chords.push({ symbol, beats: song.meta.beatsPerBar });
  }
  return [{ label: 'song', raw: 'song', bars, chords }];
}
