/**
 * Song -> Strudel code. Source-performance rendering is the default (performance.ts):
 * exact note onsets, independent releases, per-note velocity and onset controller state.
 * Detected vocals are excluded from both rendering modes. The optional `timing: 'grid'`
 * path below produces shorter, quantised notation with the historical mixing heuristics.
 * Chord-only material remains explicitly generated accompaniment.
 */
import { compilePerformance } from './performance.js';
import type { Song, Track, NoteEvent, Section, SongMeta } from './types.js';
import { barLength, barStart, barIndex, cyclesPerMinute, STUB_NOTES, meanVelocity, median, percentile, partName } from './midi.js';
import { gmName, gmLabel, drumName, percName, percTrim, percTrimDb, percShare, PERC_SAMPLES, BASS_PROGRAMS, BASS_CAPABLE_PROGRAMS, BASS_FALLBACK_SOUND, BASS_PATCH_TOP, BASS_LEAD_SOUND, VOICE_BASS_SOUND, VOCAL_PROGRAMS, AUDIBLE_LEVEL, mixLevel, isAudible, isMuted } from './gm.js';
import { pitchClass, voicingSafe } from './chords.js';

export interface CompileOptions {
  /** Source note timing (default), or compact quantised notation. Vocals are always omitted. */
  timing?: 'source' | 'grid';
  /** Include instrumental melody parts. Detected vocals are always excluded. Default true. */
  melody?: boolean;
  /** @deprecated Retained for API compatibility; vocal tracks are always omitted. */
  melodySound?: string;
  /** Maximum number of pitched tracks rendered from MIDI. Default 12. */
  maxTracks?: number;
  /**
   * Cap on the length rendered, in bars of 4/4 (so 200 means 800 beats: 400 bars of 2/4, 266 of
   * 3/4). Default 200. Truncation is announced in a header comment.
   */
  maxBars?: number;
}

export const DEFAULT_MELODY_SOUND = 'gm_lead_2_sawtooth';
/** Sound for a block of vocal harmony (choir chords): a synth pad, not a voice. */
export const VOCAL_PAD_SOUND = 'gm_pad_choir';
export const DEFAULT_MAX_TRACKS = 12;
export const DEFAULT_MAX_BARS = 200;

const NOTE_NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
export function noteName(midi: number): string {
  return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

/** Straight and triplet grids (cells per bar) for the metre: 4/4 -> 16 or 24, 6/8 -> 12 or 18, 3/4 -> 12 or 18. */
export function gridCandidates(meta: SongMeta): { straight: number; triplet: number } {
  const { beatsPerBar, beatUnit } = meta;
  const per = beatUnit === 8 ? [2, 3] : beatUnit === 2 ? [8, 12] : [4, 6];
  const cap = (g: number) => { while (g > 48) g /= 2; return Math.max(1, Math.round(g)); };
  return { straight: cap(beatsPerBar * per[0]), triplet: cap(beatsPerBar * per[1]) };
}

/** Mean distance (beats) between note onsets and the nearest cell of a `grid`-cells-per-bar grid. */
function quantisationError(notes: NoteEvent[], meta: SongMeta, grid: number): number {
  if (!notes.length) return 0;
  const cell = barLength(meta) / grid;
  const offset = meta.barOffset ?? 0;
  let sum = 0;
  for (const n of notes) {
    const x = (n.start - offset) / cell;
    sum += Math.abs(x - Math.round(x)) * cell;
  }
  return sum / notes.length;
}

/** The triplet grid has to cut the straight grid's onset error by more than this factor to count as evidence (and vice versa). */
const GRID_EVIDENCE = 0.4;
/** The losing grid's error must be at least this (beats) for a part to leave the song's grid: a few ticks of difference is not swing. */
const GRID_OVERRIDE_ERROR = 0.02;

/**
 * Pick the grid for a set of notes: the straight subdivision unless the triplet grid explains the
 * onsets clearly better (swing or shuffle feel, triplet fills). Humanised timing alone lowers the
 * error by about a third on the finer grid (mean error scales with the cell size), so the triplet
 * grid has to cut it by more than half (`GRID_EVIDENCE`) before it counts as evidence. Given the
 * song's grid (`songGrid`), a part follows it unless its own onsets are overwhelming evidence for
 * the other grid (the same ratio, and a real error on the song's grid), so the drums and the bass
 * of a shuffle do not end up on different grids over a few straight fills.
 */
export function chooseGrid(notes: NoteEvent[], meta: SongMeta, base?: number): number {
  const { straight, triplet } = gridCandidates(meta);
  if (notes.length < 12) return base ?? straight; // too little evidence to leave the default
  const es = quantisationError(notes, meta, straight);
  const et = quantisationError(notes, meta, triplet);
  if (base === undefined) return et < GRID_EVIDENCE * es ? triplet : straight;
  if (base === triplet) return es < GRID_EVIDENCE * et && et >= GRID_OVERRIDE_ERROR ? straight : triplet;
  return et < GRID_EVIDENCE * es && es >= GRID_OVERRIDE_ERROR ? triplet : straight;
}

/**
 * The song's grid, decided once from the rhythm section (drums, bass and chord parts together; every
 * part when there is no rhythm section), so all parts of a shuffle share the triplet grid.
 */
export function songGrid(tracks: Track[], meta: SongMeta): number {
  const rhythm = tracks.filter((t) => t.role === 'drums' || t.role === 'bass' || t.role === 'chords');
  const pool = (rhythm.length ? rhythm : tracks).flatMap((t) => t.notes);
  return chooseGrid(pool, meta);
}

/** Render one bar of notes as a mini-notation string whose weights sum to `grid`. */
function barToMini(allNotes: NoteEvent[], b0: number, bar: number, grid: number, label: (n: NoteEvent) => string | null): string {
  const cell = bar / grid;
  const notes = allNotes.filter((n) => label(n) !== null);
  // Bucket notes by start cell.
  const starts = new Map<number, NoteEvent[]>();
  for (const n of notes) {
    const c = Math.max(0, Math.min(grid - 1, Math.round((n.start - b0) / cell)));
    let arr = starts.get(c);
    if (!arr) starts.set(c, (arr = []));
    arr.push(n);
  }
  if (!starts.size) return '~';
  const onsets = [...starts.keys()].sort((a, b) => a - b);
  const tokens: string[] = [];
  let pos = 0;
  const names = (group: NoteEvent[]) => {
    const uniq = [...new Set(group.map((n) => label(n) as string))];
    return uniq.length === 1 ? uniq[0] : `[${uniq.join(',')}]`;
  };
  for (let i = 0; i < onsets.length; i++) {
    const c = onsets[i];
    if (c > pos) tokens.push(pos + 1 === c ? '~' : `~@${c - pos}`);
    const inCell = starts.get(c)!.sort((a, b) => a.start - b.start);
    const longest = Math.max(...inCell.map((n) => n.duration));
    let len = Math.max(1, Math.round(longest / cell));
    const next = i + 1 < onsets.length ? onsets[i + 1] : grid;
    len = Math.min(len, next - c);
    // Notes that round to the same cell but start apart (a grace note before the beat, a fast run)
    // become a sub-sequence inside the cell instead of a chord; strikes within a fifth of a cell
    // (a strummed chord, a flam) stay a chord.
    const groups: NoteEvent[][] = [];
    for (const n of inCell) {
      const g = groups[groups.length - 1];
      if (g && n.start - g[0].start <= 0.2 * cell) g.push(n); else groups.push([n]);
    }
    let body: string;
    if (groups.length === 1) body = len === 1 ? names(groups[0]) : `${names(groups[0])}@${len}`;
    else {
      const lastWeight = Math.max(1, len - (groups.length - 1));
      const inner = groups.map((g, k) => (k === groups.length - 1 && lastWeight > 1 ? `${names(g)}@${lastWeight}` : names(g)));
      body = `[${inner.join(' ')}]${len === 1 ? '' : `@${len}`}`;
    }
    tokens.push(body);
    pos = c + len;
  }
  if (pos < grid) tokens.push(grid - pos === 1 ? '~' : `~@${grid - pos}`);
  // A weight on an unwrapped token in <...> stretches the whole bar (c4@16 becomes
  // sixteen cycles). A single token already fills its bar and needs no weight.
  return tokens.length === 1 ? tokens[0].replace(/@\d+$/, '') : `[${tokens.join(' ')}]`;
}

/** Collapse consecutive duplicates with `!n` and wrap in `<>`. */
function sequence(bars: string[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < bars.length) {
    let j = i;
    while (j + 1 < bars.length && bars[j + 1] === bars[i]) j++;
    const n = j - i + 1;
    out.push(n > 1 ? `${bars[i]}!${n}` : bars[i]);
    i = j + 1;
  }
  return `<${out.join(' ')}>`;
}

function trackBars(notes: NoteEvent[], meta: SongMeta, firstBar: number, nBars: number, grid: number, label: (n: NoteEvent) => string | null): string[] {
  const bar = barLength(meta);
  const bars: string[] = [];
  let idx = 0;
  for (let b = 0; b < nBars; b++) {
    const b0 = barStart(meta, firstBar + b);
    const b1 = b0 + bar;
    while (idx < notes.length && notes[idx].start < b0) idx++;
    const inBar: NoteEvent[] = [];
    for (let k = idx; k < notes.length && notes[k].start < b1; k++) inBar.push(notes[k]);
    bars.push(barToMini(inBar, b0, bar, grid, label));
  }
  return bars;
}

// ---------- mix ----------

/** Gain given to a part with nominal volume and a mean velocity of 0.75 (when nothing is louder). */
const NOMINAL_GAIN = 0.8;
const MIN_GAIN = 0.15;
const MAX_GAIN = 1;
/** Above this sum of gains sounding at once the whole mix is scaled down so a dense moment does not clip. */
const HEADROOM_SUM = 7;
/** A part with fewer notes than `STUB_NOTES` and less than this share of the heaviest part's weight is noise. */
const STUB_WEIGHT_SHARE = 0.01;
/** A single note is only a part (a drone) when it carries this share of the heaviest part's weight. */
const SINGLE_NOTE_SHARE = 0.1;

/** A lead vocal is lifted to at least this share of the loudest major accompaniment part's level. */
export const VOCAL_LEAD_FLOOR = 0.9;
/**
 * A melody on an instrument is lifted to at least this share of the loudest major accompaniment
 * part: the file's mix is otherwise kept, but the tune is what the product exists to play, and no
 * record buries its vocal line (which is what such a part usually is) under the rhythm guitar.
 */
export const INSTRUMENT_LEAD_FLOOR = 0.75;
/** An instrumental lead is lifted to its floor only when the lead sounds in this share of the bars where anything sounds. */
export const LEAD_FLOOR_MIN_COVERAGE = 1 / 3;
/** A part that sounds in this share of the lead's bars (or in half of its own bars under the lead) plays under the lead and counts as the band it is levelled against. */
export const LEAD_OVERLAP_SHARE = 0.25;
/** Backing vocals are held to at most this share of the lead's level. */
export const BACKING_VOCAL_RATIO = 0.7;

/**
 * A part sets the mix's level only when it carries this share of the heaviest part's weight and
 * sounds in this share of the bars; a loud eight-bar stab is clipped at the maximum gain instead.
 */
export const MAJOR_WEIGHT_SHARE = 0.1;
export const MAJOR_COVERAGE = 0.25;

/**
 * Turn part levels into gains. Levels map so that a nominal part gets 0.8; when the loudest part would
 * exceed 1 (files that run every channel at CC 7 = 127) everything is scaled down together so the
 * balance between parts survives instead of being clipped away. Only `major` parts set that scale
 * (see `mixParts`; every part is major by default): a loud brass stab that plays for eight bars is
 * clipped at the maximum gain instead of pulling the whole song down. The floor keeps a quiet but
 * audible part hearable; inaudible parts never get this far (see `AUDIBLE_LEVEL`).
 */
export function gainsFor(levels: number[], major: boolean[] = []): number[] {
  const setters = levels.filter((_, i) => major[i] ?? true);
  const max = Math.max(0, ...(setters.length ? setters : levels));
  const k = Math.min(NOMINAL_GAIN / 0.75, max > 0 ? MAX_GAIN / max : Infinity);
  return levels.map((l) => Math.round(Math.max(MIN_GAIN, Math.min(MAX_GAIN, l * k)) * 100) / 100);
}

function percentileVelocity(notes: NoteEvent[], q: number): number {
  if (!notes.length) return 0.75;
  return percentile(notes.map((n) => n.velocity).sort((a, b) => a - b), q);
}

/** How much a part is heard: sum of duration x velocity, scaled by its mix level. */
export function musicalWeight(t: Track): number {
  const heard = t.notes.reduce((a, n) => a + n.duration * n.velocity, 0);
  return heard * mixLevel(1, t.volume);
}

/**
 * Stereo width applied to CC 10: hard-panned MIDI parts are unpleasant on headphones, so positions
 * are pulled 20% towards the centre, and the lead (which no real mix pans hard) 50%.
 */
export const PAN_WIDTH = 0.8;
export const PAN_WIDTH_LEAD = 0.5;

/** Strudel pan (0-1) for a track, or undefined when it sits in the centre. */
export function panFor(pan: number | undefined, width = PAN_WIDTH): number | undefined {
  if (pan === undefined || Math.abs(pan - 0.5) <= 0.04) return undefined;
  return Math.round((0.5 + (pan - 0.5) * width) * 100) / 100;
}

/** Longest identifier made from a track name: the leading words that fit, so "Electric Guitar (Distortion) Rhythm" is `electric_guitar`. */
const IDENT_MAX = 24;

/**
 * A JavaScript identifier for a part: the leading words of its name that fit `IDENT_MAX`, minus
 * the ordinal or count a name may open with ("1st Guitar" and "12 String" are `guitar` and
 * `string`); when no word survives (a name in another script, punctuation) the patch's label
 * (`fallback`) names the part instead, so no part is ever `t_` or `t_1946`.
 */
const RESERVED_NAMES = new Set(('await break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield arguments eval note s chord arrange stack silence setcpm mini m pure timecat gain undefined infinity nan').split(' '));

export function ident(s: string, fallback = 'part'): string {
  const words = s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  while (words.length && /^\d/.test(words[0])) words.shift();
  const kept: string[] = [];
  for (const w of words) { if (kept.length && [...kept, w].join('_').length > IDENT_MAX) break; kept.push(w); }
  const base = kept.join('_').slice(0, IDENT_MAX).replace(/_+$/, '');
  if (base) return RESERVED_NAMES.has(base) ? `part_${base}` : base;
  return fallback !== s ? ident(fallback) : 'part';
}

export function compile(song: Song, opts: CompileOptions = {}): string {
  const melody = opts.melody ?? true;
  const melodySound = opts.melodySound ?? DEFAULT_MELODY_SOUND;
  const maxTracks = opts.maxTracks ?? DEFAULT_MAX_TRACKS;
  const maxBars = opts.maxBars ?? DEFAULT_MAX_BARS;
  const { meta } = song;
  const cpm = cyclesPerMinute(meta);
  const key = meta.tonic ? `${meta.tonic} ${meta.mode ?? ''}`.trim() : 'unknown';
  const remarks = [...(meta.remarks ?? [])];
  const range = song.tracks.length ? barRange(song, maxBars) : null;
  if (range && range.nBars < range.totalBars) remarks.push(`rendering stops at bar ${range.nBars} of ${range.totalBars} (max bars ${maxBars})`);
  const header = [
    `// ${meta.title} — ${meta.artist}`,
    `// ${meta.bpm} bpm, ${meta.beatsPerBar}/${meta.beatUnit}, key ${key}. Source: ${meta.sources.join(' + ')}.`,
    `// Generated by strudelify. One cycle = one bar.`,
    ...remarks.map((r) => `// note: ${r}`),
    `setcpm(${cpm.toFixed(8).replace(/0{1,6}$/, '')})`,
    '',
  ];
  if (song.tracks.length) return header.concat((opts.timing === 'grid' ? compileTracks : compilePerformance)(song, { melody, melodySound, maxTracks, maxBars, timing: opts.timing ?? 'source' })).join('\n');
  return header.concat(compileSections(song)).join('\n');
}

interface RenderedPart {
  name: string;
  /** Comment bits before the gain/pan, e.g. role and instrument. */
  comment: string;
  pattern: string;
  sound: string | null;
  /** Linear mix level (see `mixLevel`); turned into a gain once all parts are known. */
  level: number;
  /** Musical weight (see `musicalWeight`); 0 for the drums, which never set the mix's level. */
  weight?: number;
  /** Strudel pan, already narrowed (see `panFor`). */
  pan?: number;
  /** Extra comment bits after the gain (grid, ghost-note details, controller movements). */
  extra: string[];
  /** Which rendered bars the part sounds in, for the headroom check. */
  active: boolean[];
  /** The lead (melody role), for the vocal levelling. */
  lead?: boolean;
  /** A singer re-sounded on a synth (see `Track.vocal`). */
  vocal?: boolean;
  /** Levelled by velocity alone (a singer re-sounded from a voice patch), said in the comment unless the level was lifted anyway. */
  velocityOnly?: boolean;
  /** How the file keeps a sung line down (muted outright, inaudible, or merely quiet), said in the comment; the lead is rendered at the vocal floor regardless. */
  quiet?: string;
  /** An instrumental lead left at the file's level because it plays in too few bars to be floored (see `LEAD_FLOOR_MIN_COVERAGE`). */
  unlifted?: boolean;
  /** Multiplier applied to the emitted gain only: a hand-percussion layer whose samples are quieter than the kit's (see `percTrim`). The mix sees the untrimmed gain. */
  trim?: number;
  /** Share of the gain that counts towards the headroom: a hand-percussion layer is brought to a level under the kit's (see `percShare`). Default 1. */
  share?: number;
}

/** Bounded preference for harmony parts when weights are otherwise similar. */
const CHORDS_BONUS = 1.25;

/**
 * Pitched tracks to render, up to `max`: the melody parts (one, or several when a singer's channel
 * changes patch per section) and the main bass are guaranteed, the other slots go to the parts
 * heard most (duration x velocity x channel level, with a bounded bonus for harmony). Parts
 * inaudible in the file (`isAudible`), stubs of a few notes that carry no weight, and single
 * notes that are not a drone are left out first.
 */
export function selectTracks(song: Song, max: number, melody: boolean): Track[] {
  const pitched = song.tracks.filter((t) => !t.vocal && t.role !== 'drums' && (melody || t.role !== 'melody'));
  const weights = new Map(pitched.map((t) => [t, musicalWeight(t)]));
  const heaviest = Math.max(0, ...weights.values());
  // (A sung line the file mutes, a guide vocal, is kept: `renderPitched` lifts it to the vocal floor.)
  const audible = pitched.filter((t) => (isAudible(mixLevel(meanVelocity(t.notes), t.volume), t.notes.length) || (t.role === 'melody' && t.vocal))
    && !(t.notes.length < STUB_NOTES && weights.get(t)! < STUB_WEIGHT_SHARE * heaviest)
    && !(t.notes.length === 1 && weights.get(t)! < SINGLE_NOTE_SHARE * heaviest));
  const byWeight = (a: Track, b: Track) => weights.get(b)! - weights.get(a)!;
  // Melody parts in the order they enter, so a singer's sections read in song order.
  const guaranteed: Track[] = audible.filter((t) => t.role === 'melody').sort((a, b) => (a.notes[0]?.start ?? 0) - (b.notes[0]?.start ?? 0));
  const bass = audible.filter((t) => t.role === 'bass').sort(byWeight)[0];
  if (bass) guaranteed.push(bass);
  const rest = audible.filter((t) => !guaranteed.includes(t))
    .sort((a, b) => weights.get(b)! * (b.role === 'chords' ? CHORDS_BONUS : 1) - weights.get(a)! * (a.role === 'chords' ? CHORDS_BONUS : 1));
  return guaranteed.concat(rest).slice(0, Math.max(0, max));
}

interface Frame { meta: SongMeta; firstBar: number; nBars: number }

function gridNote(grid: number, meta: SongMeta): string | undefined {
  return grid !== gridCandidates(meta).straight ? `${grid}-cell triplet grid` : undefined;
}

/**
 * The sound a pitched part plays on, and the reason spelled out for the code comment. Every part
 * keeps its General MIDI soundfont except a singer (never a voice: a sung line goes to the melody
 * sound, vocal harmony to a synth choir pad) and a bass on a patch that cannot play one (a voice
 * patch in the bass register goes to a synth bass, any other to `BASS_FALLBACK_SOUND`).
 */
export function soundFor(t: Track, melodySound: string): { sound: string; why: string } {
  const instrument = gmName(t.program);
  const named = partName(t.name) ? `"${partName(t.name)}"` : '';
  const patch = gmLabel(t.program);
  if (t.vocal) {
    const what = t.role === 'melody' ? (t.sungLine ? 'sung line, one section of it' : 'vocal line') : t.role === 'chords' ? 'vocal harmony' : 'backing vocal';
    const sound = t.role === 'chords' ? VOCAL_PAD_SOUND : melodySound;
    return { sound, why: `${what} (${named ? `${named}, ` : ''}${patch}${t.sungLine ? ' in the file, takes turns with the other melody parts' : ''}) on ${sound}, never a voice` };
  }
  if (t.role === 'bass' && VOCAL_PROGRAMS.has(t.program)) {
    return { sound: VOICE_BASS_SOUND, why: `${named ? `${named} · ` : ''}${patch} in the file (a voice patch in the bass register), played on ${VOICE_BASS_SOUND}, never a voice` };
  }
  if (t.role === 'bass' && !BASS_CAPABLE_PROGRAMS.has(t.program)) {
    return { sound: BASS_FALLBACK_SOUND, why: `${named ? `${named} · ` : ''}${patch} in the file, played on ${BASS_FALLBACK_SOUND}` };
  }
  // A bass patch playing where no bass does (see `BASS_PATCH_TOP`): a line goes to the synth made for both registers, chords keep the patch.
  const lead = t.role === 'melody' ? `${t.sungLine ? 'instrumental lead, one section of a lead whose channel changes patch per section' : 'instrumental lead'}, ` : '';
  if (t.role !== 'bass' && BASS_PROGRAMS.has(t.program) && t.notes.length) {
    const med = median(t.notes.map((n) => n.pitch));
    if (med >= BASS_PATCH_TOP) {
      const where = `${patch} in the file, above a bass's last fret (median ${noteName(med)})`;
      if (t.role !== 'chords') return { sound: BASS_LEAD_SOUND, why: `${named ? `${named} · ` : ''}${lead}${where}, played on ${BASS_LEAD_SOUND}, the synth patch made for both registers` };
      return { sound: instrument, why: `${named ? `${named} · ` : ''}${instrument} · chords on a ${where}, kept` };
    }
  }
  if (t.role === 'melody') return { sound: instrument, why: `${named ? `${named} · ` : ''}${instrument} · ${lead}keeps its own instrument` };
  return { sound: instrument, why: `${named ? `${named} · ` : ''}${instrument}` };
}

function renderPitched(t: Track, f: Frame, melodySound: string, name: string, grid: number): RenderedPart {
  const bar = barLength(f.meta);
  const cell = bar / grid;
  // Mini-notation weights describe the spacing of onsets. They cannot by themselves preserve
  // a note ringing past the next onset or bar line, or chord tones with different releases.
  const explicitDurations = t.notes.some((n, i) => {
    const end = n.start + n.duration;
    if (end > barStart(f.meta, barIndex(f.meta, n.start) + 1) + cell / 2) return true;
    for (let j = i + 1; j < t.notes.length; j++) {
      const next = t.notes[j];
      if (next.start - n.start <= cell * 0.2) {
        if (Math.abs(next.duration - n.duration) > cell / 2) return true;
      } else return end > next.start + cell / 2;
    }
    return false;
  });
  const renderEnd = barStart(f.meta, f.firstBar + f.nBars);
  const bars = trackBars(t.notes, f.meta, f.firstBar, f.nBars, grid, (n) => {
    const pitch = noteName(n.pitch);
    if (!explicitDurations) return pitch;
    const duration = Math.max(0.000001, Math.min(n.duration, renderEnd - n.start) / bar);
    return `${pitch}:${Number(duration.toFixed(6))}`;
  });
  const active = bars.map(b => b !== '~');
  if (explicitDurations) for (const n of t.notes) {
    const from = Math.max(0, barIndex(f.meta, n.start) - f.firstBar);
    const to = Math.min(f.nBars - 1, barIndex(f.meta, n.start + n.duration - 1e-6) - f.firstBar);
    for (let b = from; b <= to; b++) active[b] = true;
  }
  const { sound, why } = soundFor(t, melodySound);
  const lead = t.role === 'melody';
  const extra = [gridNote(grid, f.meta), ...(t.remarks ?? []), ...(explicitDurations ? ['note durations preserved across overlapping notes and bar lines'] : [])].filter((x): x is string => !!x);
  // A singer re-sounded from a voice patch is levelled by velocity alone: the file's channel volume
  // compensated for that patch. A singer named on a real instrument keeps its channel volume.
  const voicePatch = !!t.vocal && VOCAL_PROGRAMS.has(t.program);
  let level = mixLevel(meanVelocity(t.notes), voicePatch ? undefined : t.volume);
  // A sung line the file keeps down is still the tune: `levelVocals` lifts it to the floor. Muted (CC 7 = 0,
  // velocity 1) it is a guide track; inaudible or merely quiet (a vocal at CC 7 = 36) it is said as such.
  let quiet: string | undefined;
  if (lead && t.vocal) {
    const fileLevel = mixLevel(meanVelocity(t.notes), t.volume);
    const how = `level ${Math.round(fileLevel * 100)}% (velocity ${Math.round(meanVelocity(t.notes) * 100)}%${t.volume === undefined ? '' : `, CC 7 x CC 11 ${Math.round(t.volume * 127)}`})`;
    if (isMuted(t.volume, meanVelocity(t.notes))) { quiet = 'muted guide line in the file'; level = 0; }
    else if (!isAudible(fileLevel, t.notes.length)) { quiet = `inaudible in the file, ${how}`; level = 0; }
    else if (!voicePatch && fileLevel < AUDIBLE_LEVEL) quiet = `quiet in the file, ${how}`;
  }
  return {
    name,
    comment: `${t.role} · ${why}`,
    pattern: explicitDurations ? `mini('${sequence(bars)}').as(['note', 'duration'])` : `note(${JSON.stringify(sequence(bars))})`,
    sound,
    level,
    weight: musicalWeight(t),
    pan: panFor(t.pan, lead ? PAN_WIDTH_LEAD : PAN_WIDTH),
    extra,
    active,
    lead,
    vocal: t.vocal,
    velocityOnly: voicePatch,
    quiet,
  };
}

/**
 * Level the leads against the band (see the module notes): a lead vocal at least
 * `VOCAL_LEAD_FLOOR` and an instrumental melody (when present through `LEAD_FLOOR_MIN_COVERAGE` of
 * the song) at least `INSTRUMENT_LEAD_FLOOR` of the loudest major accompaniment part, backing
 * vocals at most `BACKING_VOCAL_RATIO` of the lead. Returns the parts whose level changed, for the
 * comments.
 */
export function levelVocals(parts: RenderedPart[]): { changed: Set<RenderedPart>; leadCoverage: number } {
  const changed = new Set<RenderedPart>();
  const major = majorParts(parts);
  // The band: the major accompaniment parts, plus any part that plays under the lead for a fair share
  // of the lead's bars or of its own (a loud guitar solo over the last chorus buries the singer as
  // surely as the rhythm guitar does; one that only takes turns with it does not).
  const leadBars = new Set<number>();
  for (const p of parts) if (p.lead) p.active.forEach((on, b) => { if (on) leadBars.add(b); });
  const heaviest = Math.max(0, ...parts.map((p) => p.weight ?? 0));
  const underLead = (p: RenderedPart) => {
    if (!leadBars.size) return false;
    const own = p.active.filter(Boolean).length;
    const shared = p.active.filter((on, b) => on && leadBars.has(b)).length;
    // (A part playing mostly under the lead counts only when it carries real weight: a two-bar stab does not set the singer's level.)
    return shared >= LEAD_OVERLAP_SHARE * leadBars.size || (own > 0 && shared >= 0.5 * own && (p.weight ?? 0) >= MAJOR_WEIGHT_SHARE * heaviest);
  };
  const band = Math.max(0, ...parts.filter((p, i) => !p.vocal && !p.lead && (p.weight ?? 1) > 0 && (major[i] || underLead(p))).map((p) => p.level));
  // An instrumental lead present in only a fraction of the song is a fill, not the tune to be pushed forward.
  const sounding = new Set<number>();
  for (const p of parts) p.active.forEach((on, b) => { if (on) sounding.add(b); });
  const leadCoverage = sounding.size ? leadBars.size / sounding.size : 0;
  const present = leadCoverage >= LEAD_FLOOR_MIN_COVERAGE;
  for (const p of parts) {
    if (!p.lead) continue;
    const floor = (p.vocal ? VOCAL_LEAD_FLOOR : INSTRUMENT_LEAD_FLOOR) * band;
    if (p.level >= floor) continue;
    if (p.vocal || present) { p.level = floor; changed.add(p); } else p.unlifted = true;
  }
  const lead = Math.max(0, ...parts.filter((p) => p.lead).map((p) => p.level));
  for (const p of parts) {
    if (p.vocal && !p.lead && lead > 0 && p.level > BACKING_VOCAL_RATIO * lead) { p.level = BACKING_VOCAL_RATIO * lead; changed.add(p); }
  }
  return { changed, leadCoverage };
}

/**
 * The kit, plus a second quieter layer for ghost notes when there are enough of them: hits well
 * below the kit's typical velocity (80th percentile) go there at 40% of the kit's level. Keys the
 * default kit cannot play but the VCSL bank can (`percName`) become one more layer per instrument
 * (congas, bongos, agogo bells...), named after it, at the kit's level once the sample's own
 * quietness is trimmed away (`percTrim`); a hand-percussion layer is not split for ghost notes.
 * A kit with no playable key yields no kit layer.
 */
function renderDrums(kit: Track, f: Frame, name: (base: string) => string, grid: number): RenderedPart[] {
  const all = [...kit.notes].sort((a, b) => a.start - b.start);
  const { volume, pan } = kit;
  const kitNotes = all.filter((n) => drumName(n.pitch) !== null);
  const extra = [gridNote(grid, f.meta), ...(kit.remarks ?? [])].filter((x): x is string => !!x);
  const layer = (notes: NoteEvent[], label: (n: NoteEvent) => string | null) => trackBars(notes, f.meta, f.firstBar, f.nBars, grid, label);
  const out: RenderedPart[] = [];
  if (kitNotes.length) {
    const ref = percentileVelocity(kitNotes, 0.8);
    const ghosts = kitNotes.filter((n) => n.velocity < 0.55 * ref);
    const split = ghosts.length >= Math.max(8, 0.05 * kitNotes.length);
    const main = split ? kitNotes.filter((n) => n.velocity >= 0.55 * ref) : kitNotes;
    const level = mixLevel(ref, volume);
    const mainBars = layer(main, (n) => drumName(n.pitch));
    out.push({
      name: name('drums'),
      comment: `drums · ${split ? 'main hits' : 'kit'}`,
      pattern: `s(${JSON.stringify(sequence(mainBars))})`,
      sound: null,
      level,
      weight: 0, // the kit's samples are not calibrated against the soundfonts: a hot kit clips at 1 rather than pulling every pitched part down
      pan: panFor(pan),
      extra,
      active: mainBars.map((b) => b !== '~'),
    });
    if (split) {
      const ghostBars = layer(ghosts, (n) => drumName(n.pitch));
      out.push({
        name: name('drums_ghost'),
        comment: `drums · ghost notes (${ghosts.length} hits under ${Math.round(55 * ref)}% velocity, at 40% of the kit's level)`,
        pattern: `s(${JSON.stringify(sequence(ghostBars))})`,
        sound: null,
        level: level * 0.4,
        weight: 0,
        pan: panFor(pan),
        extra,
        active: ghostBars.map((b) => b !== '~'),
      });
    }
  }
  const bySample = new Map<string, NoteEvent[]>();
  for (const n of all) {
    const p = percName(n.pitch);
    if (!p) continue;
    let arr = bySample.get(p.sample);
    if (!arr) bySample.set(p.sample, (arr = []));
    arr.push(n);
  }
  for (const [sample, notes] of bySample) {
    const info = PERC_SAMPLES[sample];
    const keys = [...new Set(notes.map((n) => n.pitch))].sort((a, b) => a - b);
    const bars = layer(notes, (n) => percName(n.pitch)!.token);
    const trim = percTrim(sample);
    out.push({
      name: name(info.label),
      comment: `drums · ${info.label} · VCSL ${sample} sample${keys.length > 1 ? 's' : ''} (GM key${keys.length > 1 ? 's' : ''} ${keys.join(', ')}), trimmed +${percTrimDb(sample)} dB (x${trim}) to the kit's level`,
      pattern: `s(${JSON.stringify(sequence(bars))})`,
      sound: null,
      level: mixLevel(percentileVelocity(notes, 0.8), volume),
      weight: 0,
      pan: panFor(pan),
      extra,
      active: bars.map((b) => b !== '~'),
      trim,
      share: percShare(sample),
    });
  }
  return out;
}

/**
 * Gains for the parts, scaled down together when the loudest moment (the bar where the most gain
 * sounds at once) exceeds the headroom. The level of the mix is set by the major parts: those that
 * carry `MAJOR_WEIGHT_SHARE` of the heaviest weight and sound in `MAJOR_COVERAGE` of the bars where
 * anything sounds (a part without a weight is major; the drums pass 0 and never set the level, so
 * a kit at full velocity and CC 7 = 127 clips at the maximum gain instead of pulling every pitched
 * part down to half). A part counts towards the loudest moment at its `share` of its gain (a
 * hand-percussion layer sits under the kit's level, see `percShare`). Returns the gains and a mix
 * remark, if any; a peak that would scale the gains by a factor rounding to 1.00 leaves them, and
 * the code, alone.
 */
export function mixParts(parts: { level: number; weight?: number; active: boolean[]; share?: number }[]): { gains: number[]; remark?: string } {
  const gains = gainsFor(parts.map((p) => p.level), majorParts(parts));
  const nBars = Math.max(0, ...parts.map((p) => p.active.length));
  let peak = 0, peakParts = 0;
  for (let b = 0; b < nBars; b++) {
    let sum = 0, count = 0;
    parts.forEach((p, i) => { if (p.active[b]) { sum += gains[i] * (p.share ?? 1); count++; } });
    if (sum > peak) { peak = sum; peakParts = count; }
  }
  // A peak just over the headroom scales by a factor that rounds to 1.00: the gains would not change, so neither does the code.
  const scale = Math.round((HEADROOM_SUM / peak) * 100) / 100;
  if (peak <= HEADROOM_SUM || scale >= 1) return { gains };
  return {
    gains: gains.map((g) => Math.round(g * scale * 100) / 100),
    remark: `mix: up to ${peakParts} parts sound at once (gains summing to ${peak.toFixed(1)}), all gains scaled by ${scale.toFixed(2)} for headroom`,
  };
}

/** Which parts set the mix's level (see `mixParts`): a part without a weight, or one with enough weight and coverage. */
function majorParts(parts: { weight?: number; active: boolean[] }[]): boolean[] {
  const heaviest = Math.max(0, ...parts.map((p) => p.weight ?? 0));
  const sounding = new Set<number>();
  for (const p of parts) p.active.forEach((on, b) => { if (on) sounding.add(b); });
  return parts.map((p) => p.weight === undefined
    || (p.weight > 0 && p.weight >= MAJOR_WEIGHT_SHARE * heaviest && p.active.filter(Boolean).length >= MAJOR_COVERAGE * sounding.size));
}

function compileTracks(song: Song, o: Required<CompileOptions>): string[] {
  const range = barRange(song, o.maxBars);
  if (!range) return ['silence'];
  const frame: Frame = { meta: song.meta, firstBar: range.firstBar, nBars: range.nBars };

  const used = new Set<string>();
  const uniqueName = (base: string, fallback?: string) => {
    const root = ident(base, fallback);
    let name = root;
    for (let k = 2; used.has(name); k++) name = `${root}_${k}`;
    used.add(name);
    return name;
  };
  const grid = songGrid(song.tracks, song.meta);
  const parts: RenderedPart[] = [];
  for (const t of selectTracks(song, o.maxTracks, o.melody)) {
    const patch = gmName(t.program).replace(/^gm_/, '');
    const base = t.role === 'melody' ? 'melody' : t.role === 'bass' ? 'bass' : partName(t.name) || patch;
    parts.push(renderPitched(t, frame, o.melodySound, uniqueName(base, patch), chooseGrid(t.notes, song.meta, grid)));
  }
  // Percussion is one track: `songFromMidi` merges every drum channel into it.
  const kit = song.tracks.find((t) => t.role === 'drums');
  if (kit) parts.push(...renderDrums(kit, frame, uniqueName, chooseGrid(kit.notes, song.meta, grid)));

  const lines: string[] = [];
  const chordLine = chordSummary(song.structure ?? song.sections);
  if (chordLine) lines.push(`// chords: ${chordLine}`, '');
  if (grid !== gridCandidates(song.meta).straight) lines.push(`// swing: the rhythm section's onsets fit a ${grid}-cell triplet grid, used for every part unless its own onsets clearly play straight`, '');
  const { changed: levelled, leadCoverage } = levelVocals(parts);
  const { gains, remark } = mixParts(parts);
  if (remark) lines.push(`// ${remark}`, '');
  parts.forEach((p, i) => {
    const gain = p.trim ? Math.round(gains[i] * p.trim * 100) / 100 : gains[i];
    const bits = [p.comment, `gain ${gain}`];
    if (p.pan !== undefined) bits.push(`pan ${p.pan}`);
    if (p.quiet) bits.push(levelled.has(p) ? `${p.quiet}, lifted to the band` : p.quiet);
    else if (levelled.has(p)) bits.push(p.lead ? 'lifted to the band' : 'held under the lead');
    else if (p.unlifted) bits.push(`plays in ${Math.round(leadCoverage * 100)}% of the bars, so it keeps the file's level rather than being lifted to the band`);
    else if (p.velocityOnly) bits.push('level from velocity');
    bits.push(...p.extra);
    lines.push(`// ${bits.join(' · ')}`);
    lines.push(`const ${p.name} = ${p.pattern}`);
    lines.push(`  ${p.sound ? `.s("${p.sound}")` : ''}.gain(${gain})${p.pan === undefined ? '' : `.pan(${p.pan})`}`);
    lines.push('');
  });
  lines.push(`stack(${parts.map((p) => p.name).join(', ')})`);
  return lines;
}

/**
 * The `// chords:` summary of a list of sections: consecutive repeats collapse, sections are separated by `|`,
 * at most forty symbols per section and 400 characters in all. Exported so the web app can rewrite the line
 * with the chords read from the notes when the annotated chart cannot be laid on them.
 */
export function chordSummary(sections: readonly Section[]): string {
  const parts: string[] = [];
  for (const s of sections) {
    const syms = s.chords.map((c) => c.symbol ?? 'N');
    const compact: string[] = [];
    for (const sym of syms) if (compact[compact.length - 1] !== sym) compact.push(sym);
    parts.push(compact.slice(0, 40).join(' '));
  }
  return parts.join(' | ').slice(0, 400);
}

/** Chords-only rendering, used when there is no note-level material (McGill songs). */
function compileSections(song: Song): string[] {
  const { meta } = song;
  const bpb = meta.beatsPerBar;
  const lines: string[] = [];
  const chordRows: string[] = [];
  const bassRows: string[] = [];
  for (const s of song.sections) {
    // Strudel's voicing() rejects slash chords, so the chord layer gets root+quality
    // and the bass layer gets the actual bass note (slash bass or root).
    const chordBars = sectionBars(s, bpb, (sym) => voicingSafe(splitSlash(sym).chord));
    const bassBars = sectionBars(s, bpb, (sym) => bassNoteName(splitSlash(sym).bass));
    if (!chordBars.length) continue;
    chordRows.push(`  // ${s.raw ?? s.label} (${chordBars.length} bars)`);
    chordRows.push(`  [${chordBars.length}, ${JSON.stringify(sequence(chordBars))}],`);
    bassRows.push(`  [${bassBars.length}, ${JSON.stringify(sequence(bassBars))}],`);
  }
  lines.push('const chords = arrange(');
  lines.push(...chordRows);
  lines.push(')');
  lines.push('const bassline = arrange(');
  lines.push(...bassRows);
  lines.push(')');
  lines.push('');
  const groove = grooveFor(meta.beatsPerBar, meta.beatUnit);
  lines.push('// chords · gm_piano');
  lines.push('const keys = chord(chords).voicing().s("gm_piano").gain(0.8)');
  lines.push('// bass · gm_electric_bass_finger');
  lines.push('const bass = note(bassline).s("gm_electric_bass_finger").gain(0.9)');
  lines.push('// drums');
  lines.push(`const drums = s(${JSON.stringify(groove)}).gain(0.8)`);
  lines.push('');
  lines.push('stack(keys, bass, drums)');
  return lines;
}

/** Split `Am7/G` into { chord: 'Am7', bass: 'G' }; a plain chord's bass is its root. */
export function splitSlash(symbol: string): { chord: string; bass: string } {
  const m = /^([A-G][b#]?)([^/]*)(?:\/([A-G][b#]?))?$/.exec(symbol);
  if (!m) return { chord: symbol, bass: symbol };
  return { chord: `${m[1]}${m[2]}`, bass: m[3] ?? m[1] };
}

/** Pitch-class name -> Strudel note name in octave 2, e.g. `Bb` -> `a#2`. */
export function bassNoteName(pc: string): string {
  return `${noteName(pitchClass(pc) + 36)}`;
}

/** Split a section's chord events into per-bar mini-notation strings. */
function sectionBars(s: Section, beatsPerBar: number, map: (symbol: string) => string): string[] {
  const bars: string[] = [];
  let cur: { sym: string; beats: number }[] = [];
  let filled = 0;
  const flush = () => {
    if (!cur.length) return;
    // Keep a partial final bar on the same one-cycle grid as the timeline. A lone
    // "Gm7@2" inside <...> would otherwise stretch it to two whole cycles.
    if (filled < beatsPerBar - 1e-9) cur.push({ sym: '~', beats: beatsPerBar - filled });
    const tokens = cur.map((c) => (c.beats === beatsPerBar || c.beats === 1 ? c.sym : `${c.sym}@${trim(c.beats)}`));
    bars.push(tokens.length === 1 ? tokens[0] : `[${tokens.join(' ')}]`);
    cur = [];
    filled = 0;
  };
  for (const c of s.chords) {
    let remaining = c.beats;
    const sym = c.symbol ? map(c.symbol) : '~';
    while (remaining > 1e-9) {
      const take = Math.min(remaining, beatsPerBar - filled);
      const tail = cur[cur.length - 1];
      if (tail && tail.sym === sym) tail.beats += take; else cur.push({ sym, beats: take });
      filled += take;
      remaining -= take;
      if (filled >= beatsPerBar - 1e-9) flush();
    }
  }
  flush();
  return bars;
}

function trim(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function grooveFor(beatsPerBar: number, beatUnit: number): string {
  if (beatUnit === 8 && beatsPerBar % 3 === 0) {
    const groups = beatsPerBar / 3;
    return Array.from({ length: groups }, (_, i) => (i % 2 === 0 ? '[bd hh hh]' : '[sd hh hh]')).join(' ');
  }
  if (beatsPerBar === 3) return 'bd hh [sd hh]';
  if (beatsPerBar === 2) return 'bd sd';
  const beats: string[] = [];
  for (let i = 0; i < beatsPerBar; i++) beats.push(i % 2 === 0 ? '[bd hh]' : '[sd hh]');
  return beats.join(' ');
}

/**
 * First rendered bar, number of rendered bars and the song's total bars for a MIDI song (leading
 * silence trimmed). `maxBars` counts bars of 4/4, so the cap is a length in beats whatever the metre.
 */
export function barRange(song: Song, maxBars = DEFAULT_MAX_BARS): { firstBar: number; nBars: number; totalBars: number } | null {
  let first = Infinity, last = 0;
  for (const t of song.tracks) for (const n of t.notes) { first = Math.min(first, n.start); last = Math.max(last, n.start + n.duration); }
  if (!isFinite(first)) return null;
  const firstBar = barIndex(song.meta, first);
  const lastBar = barIndex(song.meta, last - 1e-6); // a note ending exactly on a bar line does not open a new bar
  const totalBars = lastBar - firstBar + 1;
  const cap = Math.max(1, Math.round(maxBars * 4 / barLength(song.meta)));
  // A song that barely exceeds the cap is rendered whole rather than losing its last bars.
  const tolerance = Math.max(2, Math.round(cap * 0.05));
  return { firstBar, nBars: totalBars <= cap + tolerance ? totalBars : cap, totalBars };
}

export interface TimelineSection { label: string; startBar: number; bars: number }
export interface Timeline {
  /** Number of bars the generated code loops over. */
  bars: number;
  /** Bars per minute, i.e. Strudel cycles per minute. */
  cpm: number;
  secondsPerBar: number;
  /** Chord symbol at the start of each rendered bar (null = none). */
  chords: (string | null)[];
  /** Section markers when a human-annotated structure exists for the rendered bars. */
  sections: TimelineSection[];
}

/** Everything a UI needs to draw a seekable timeline that matches `compile()`'s output. */
export function timeline(song: Song, opts: CompileOptions = {}): Timeline {
  const cpm = cyclesPerMinute(song.meta);
  const secondsPerBar = 60 / cpm;
  const bpb = song.meta.beatsPerBar;
  if (song.tracks.length) {
    const range = barRange(song, opts.maxBars ?? DEFAULT_MAX_BARS);
    const bars = range?.nBars ?? 0;
    const firstBar = range?.firstBar ?? 0;
    const perBar = chordsPerBar(song.sections, bpb);
    const chords = Array.from({ length: bars }, (_, i) => perBar[firstBar + i] ?? null);
    return { bars, cpm, secondsPerBar, chords, sections: [] };
  }
  const chords: (string | null)[] = [];
  const sections: TimelineSection[] = [];
  for (const sec of song.sections) {
    const per = chordsPerBar([sec], bpb);
    if (!per.length) continue;
    sections.push({ label: sec.raw ?? sec.label, startBar: chords.length, bars: per.length });
    chords.push(...per);
  }
  return { bars: chords.length, cpm, secondsPerBar, chords, sections };
}

/** The chord sounding at the start of each bar, across the given sections in order. */
function chordsPerBar(sections: Section[], beatsPerBar: number): (string | null)[] {
  const out: (string | null)[] = [];
  let pos = 0; // beats
  for (const s of sections) {
    for (const c of s.chords) {
      const end = pos + c.beats;
      while (pos < end - 1e-9) {
        const barIndex = Math.floor(pos / beatsPerBar + 1e-9);
        if (out[barIndex] === undefined) out[barIndex] = c.symbol;
        pos = Math.min(end, (barIndex + 1) * beatsPerBar);
      }
    }
  }
  for (let i = 0; i < out.length; i++) if (out[i] === undefined) out[i] = null;
  return out;
}
