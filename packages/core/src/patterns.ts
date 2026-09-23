/**
 * Editable Strudel for the Main loop and the Full arrangement: every part is plain mini-notation on the
 * grid its notes were quantised to (`SongMeta.grid`), with no number on any note.
 *
 * - A note lasts its steps (`c3@3` is three steps long) and rests fill the gaps (`c3 ~ e3`).
 * - Notes struck together for the same length are a chord (`[c3,e3,g3]`). A note still sounding when
 *   the next one starts goes to another voice (`c3@4, ~ e3 g3 ~`), and one held across a bar line
 *   makes a riff of several bars (`[...]/2`), so every note keeps its length: the soundfonts stop a
 *   note dead when it ends. Only a note that overlaps the next one or the bar line by no more than
 *   `OVERLAP_BEATS` is trimmed (a legato bass note is not a second voice), and past `MAX_VOICES`
 *   voices or `MAX_RIFF_BARS` bars a note is cut where it would need one more.
 * - A short part is one sequence of bars (`note("<[c3 e3] [g3 b3]!3>")`). A longer one names each
 *   distinct bar once (riffs A, B, C...) and plays them in order with `pickRestart`, so editing a riff
 *   changes every repeat.
 * - Drums are one part per sound, its rhythm a step grid given with `struct`
 *   (`s("bd").struct("x ~@2 x!2 ~@3")`): a sample plays to its end whatever the step, so only the onsets
 *   are written.
 * - Each part has one level (`gain`, velocity included); notes at a second, softer level (a loop's
 *   ghost notes) are a separate `_soft` part.
 */
import type { Song, Track, NoteEvent } from './types.js';
import { barLength, partName } from './midi.js';
import { gmName, gmLabel, drumName, percName, percTrim, PERC_SAMPLES, NOMINAL_VOLUME } from './gm.js';
import { ACOUSTIC_DRUMS } from './acoustic-drums.js';
import { detectChord } from './detect.js';
import { pcName } from './chords.js';
import { barRange, capTracks, noteName, soundFor, spellsFlats, uniqueNames, type CompileOptions } from './strudel.js';

/** Line length the generated code wraps at; a riff is never split, so a dense one can run longer. */
const WIDTH = 120;
/** A part with more runs of bars than this, or with a riff longer than a bar, names its riffs. */
const INLINE_RUNS = 8;
/** A note may run this far (beats) into the next note or bar, and no more than a third of its length, and be trimmed rather than need a voice or a longer riff. */
export const OVERLAP_BEATS = 1 / 4;
/** Longest riff (bars) that held notes make; a note held past it is cut at its end. */
export const MAX_RIFF_BARS = 8;
/** Most voices a riff is written in; a note that would need another cuts the voice that frees first. */
export const MAX_VOICES = 5;
/** Grid of a song prepared without one (steps per bar). */
const DEFAULT_GRID = 48;

/** One part as the code shows it: its hits on the grid, and how it sounds. */
interface Layer {
  name: string;
  comment: string;
  /** A drum part's sample (its hits are written `x`); none for a pitched part. */
  drum?: string;
  hits: Hit[];
  /** `.s(...)`, `.gain(...)`, `.pan(...)`. */
  tail: string;
}
/** A note or drum hit: start and length in grid steps from the first bar, and its mini-notation token. */
interface Hit { at: number; length: number; token: string; pitch: number }
/** A span of whole bars and its voices' mini-notation, each as one line of tokens per bar they start in (no voice: a rest). */
interface Unit { bars: number; voices: string[][] }
interface Frame {
  grid: number;
  bars: number;
  /** Steps a note may overlap the next note or bar and be trimmed (see `OVERLAP_BEATS`). */
  tolerance: number;
  /** Notation the parts use, for the legend. */
  seen: { chords: boolean; voices: boolean; long: boolean };
  /** The key is spelled with flats: notes (`bb3`) and chord names (`Bb`) follow it. */
  flats: boolean;
}

export function compilePatterns(song: Song, opts: Required<CompileOptions>): string[] {
  const range = barRange(song, opts.maxBars);
  if (!range) return ['silence'];
  const grid = song.meta.grid ?? DEFAULT_GRID;
  const step = barLength(song.meta) / grid;
  const flats = spellsFlats(song.meta);
  const frame: Frame = { grid, bars: range.nBars, tolerance: Math.max(1, Math.floor(OVERLAP_BEATS / step + 1e-9)), seen: { chords: false, voices: false, long: false }, flats };
  const name = uniqueNames();
  const selected = song.tracks.filter((t) => !t.vocal && (opts.melody || t.role !== 'melody'));
  const layers: Layer[] = [];
  for (const t of capTracks(selected.filter((t) => t.role !== 'drums'), opts.maxTracks)) {
    const patch = gmName(t.program).replace(/^gm_/, '');
    const base = t.role === 'bass' ? 'bass' : patch;
    const named = partName(t.name);
    const comment = `${t.role} · ${gmLabel(t.program)}${named && named.toLowerCase() !== gmLabel(t.program) ? ` · "${named}"` : ''}`;
    const sound = `.s("${soundFor(t, opts.melodySound).sound}")`;
    levels(t.notes).forEach((notes, i) => layers.push({
      name: name(i ? `${base}_soft` : base, patch),
      comment: i ? `${comment} · soft notes` : comment,
      hits: hits(notes, step, frame, (n) => noteName(n.pitch, flats)),
      tail: `${sound}${mix(notes[0].velocity, t)}`,
    }));
  }
  for (const t of selected.filter((t) => t.role === 'drums')) {
    // GM keys that play the very same sample are one sound in the editable mix.
    const sounds = new Map<string, { voice: DrumVoice; notes: NoteEvent[] }>();
    for (const n of [...t.notes].sort((a, b) => a.pitch - b.pitch)) {
      const voice = drumVoice(n.pitch, song.meta.drumKit);
      if (!voice) continue;
      const key = `${voice.token}:${voice.trim}`;
      (sounds.get(key) ?? sounds.set(key, { voice, notes: [] }).get(key)!).notes.push(n);
    }
    for (const { voice, notes } of sounds.values()) {
      levels(notes).forEach((ns, i) => layers.push({
        name: name(i ? `${voice.name}_soft` : voice.name),
        comment: `drums · ${voice.name.replace(/_/g, ' ')}${i ? ' · soft notes' : ''}`,
        drum: voice.token,
        hits: hits(ns, step, frame, () => 'x'),
        tail: mix(ns[0].velocity, t, voice.trim),
      }));
    }
  }
  const parts = layers.map((l) => {
    let units = l.drum ? drumUnits(l.hits, frame) : noteUnits(l.hits, frame, MAX_RIFF_BARS);
    // A loop is a few bars: when a note is held over its bar line, the whole loop is one riff, a line per bar.
    if (opts.form === 'loop' && units.some((u) => u.bars > 1)) units = noteUnits(l.hits, frame, frame.bars);
    return { layer: l, units };
  }).filter((p) => p.units.some((u) => u.voices.length));
  if (!parts.length) return ['// No separate instrumental parts remain with these options.', 'silence'];
  const code = parts.map((p) => partCode(p.layer, p.units, frame.flats));
  const lines = [`// ${legend(frame.seen)}`];
  if (code.some((c) => c.some((line) => line.includes('.pickRestart(')))) lines.push('// A part\'s distinct bars are riffs (A, B, C...) played in order: edit a riff to change every repeat.');
  lines.push('');
  for (const c of code) lines.push(...c, '');
  const names = parts.map((p) => p.layer.name);
  const stack = `stack(${names.join(', ')})`;
  lines.push(...(stack.length <= WIDTH ? [stack] : ['stack(', ...wrap(names.map((n, i) => (i < names.length - 1 ? `${n},` : n)), '  '), ')']));
  return lines;
}

/** The notation the code uses, explained in one comment line: steps and rests, then chords, voices and long riffs when present. */
function legend(seen: Frame['seen']): string {
  const bits = ['c3@3 lasts 3 steps', '~ is a rest'];
  if (seen.chords) bits.push('[c3,e3] is a chord');
  if (seen.voices) bits.push('"a, b" plays two voices at once');
  if (seen.long) bits.push('[...]/2 spreads a riff over 2 bars');
  return `Notation: ${bits.join(' · ')}.`;
}

// ---------- levels and mix ----------

/** A part's notes by velocity, loudest first: one level in a Full arrangement, a second for a loop's ghost notes. */
function levels(notes: NoteEvent[]): NoteEvent[][] {
  const by = new Map<number, NoteEvent[]>();
  for (const n of notes) (by.get(n.velocity) ?? by.set(n.velocity, []).get(n.velocity)!).push(n);
  return [...by.entries()].sort((a, b) => b[0] - a[0]).map(([, ns]) => ns);
}

/** `.gain(...)` (velocity x channel level x `trim`, which the audio engine multiplies anyway) and `.pan(...)` off centre. */
function mix(velocity: number, t: Track, trim = 1): string {
  const gain = velocity * (t.volume ?? NOMINAL_VOLUME) ** 2 * 0.8 * trim;
  const pan = t.pan ?? 0.5;
  return `.gain(${round(gain)})${Math.abs(pan - 0.5) >= 0.05 ? `.pan(${round(pan)})` : ''}`;
}
const round = (x: number) => String(Math.round(x * 100) / 100);

// ---------- drums ----------

interface DrumVoice { token: string; trim: number; name: string }
/** Part names for General MIDI percussion keys; hand percussion is named after its VCSL sample. */
const KEY_NAMES: Record<number, string> = {
  35: 'kick', 36: 'kick', 37: 'rim', 38: 'snare', 39: 'clap', 40: 'snare', 41: 'low_tom', 42: 'hihat', 43: 'low_tom', 44: 'pedal_hat',
  45: 'mid_tom', 46: 'open_hat', 47: 'mid_tom', 48: 'high_tom', 49: 'crash', 50: 'high_tom', 51: 'ride', 52: 'china', 53: 'ride_bell',
  54: 'tambourine', 55: 'splash', 56: 'cowbell', 57: 'crash', 59: 'ride', 70: 'shaker', 82: 'shaker',
};
/** The sample a percussion key plays (reviewed acoustic kit, VCSL hand percussion or the default kit), or null. */
function drumVoice(pitch: number, kit: Song['meta']['drumKit']): DrumVoice | null {
  const acoustic = kit === 'acoustic' ? ACOUSTIC_DRUMS[pitch] : undefined;
  if (acoustic) return { token: `${acoustic.sample}:${acoustic.index}`, trim: acoustic.gain, name: KEY_NAMES[pitch] ?? acoustic.sample };
  const perc = percName(pitch);
  if (perc) return { token: perc.token, trim: percTrim(perc.sample), name: PERC_SAMPLES[perc.sample].label.replace(/\W+/g, '_') };
  const sample = drumName(pitch);
  return sample ? { token: sample, trim: 1, name: KEY_NAMES[pitch] ?? sample } : null;
}

// ---------- notes on the grid ----------

/** Notes as hits on the grid, inside the rendered bars. */
function hits(notes: NoteEvent[], step: number, f: Frame, token: (n: NoteEvent) => string): Hit[] {
  const end = f.bars * f.grid;
  const out: Hit[] = [];
  for (const n of notes) {
    const at = Math.max(0, Math.round(n.start / step));
    if (at >= end) continue;
    out.push({ at, length: Math.min(end - at, Math.max(1, Math.round(n.duration / step))), token: token(n), pitch: n.pitch });
  }
  return out.sort((a, b) => a.at - b.at || a.pitch - b.pitch);
}

/** May a note of `length` steps lose `excess` steps (it overlaps the next note or bar by no more than that)? */
const trimmable = (excess: number, length: number, f: Frame) => excess <= f.tolerance && excess * 3 <= length;

/** A pitched part as units of whole bars: one bar, or several while notes are held across bar lines (up to `longest`). */
function noteUnits(all: Hit[], f: Frame, longest: number): Unit[] {
  const byBar = Array.from({ length: f.bars }, () => [] as Hit[]);
  for (const h of all) byBar[Math.floor(h.at / f.grid)].push(h);
  const units: Unit[] = [];
  for (let b = 0; b < f.bars;) {
    let end = b + 1;
    for (let i = b; i < end; i++) {
      for (const h of byBar[i]) {
        const over = h.at + h.length - end * f.grid;
        if (over > 0 && !trimmable(over, h.length, f)) end = Math.min(f.bars, b + longest, Math.ceil((h.at + h.length) / f.grid));
      }
    }
    // Notes still held past the longest riff: end it at the bar line where cutting them loses least.
    const cut = (e: number) => byBar.slice(b, e).flat().reduce((sum, h) => sum + Math.max(0, h.at + h.length - e * f.grid), 0);
    if (end === b + longest && cut(end) > 0) {
      for (let e = end - 1; e > b; e--) if (cut(e) < cut(end)) end = e;
    }
    const span = (end - b) * f.grid;
    const inside = byBar.slice(b, end).flat().map((h) => ({ ...h, at: h.at - b * f.grid, length: Math.min(h.length, span - (h.at - b * f.grid)) }));
    const voiced = voices(inside, span, f).map((v) => sequence(v, span, f.grid));
    if (voiced.length > 1) f.seen.voices = true;
    if (end - b > 1) f.seen.long = true;
    units.push({ bars: end - b, voices: voiced });
    b = end;
  }
  return units;
}

/**
 * A drum sound as one unit per bar, a step grid: each hit one step of the bar's finest spacing, rests
 * between (`x ~ x x`). A sample plays to its end whatever the step, so only the onsets matter.
 */
function drumUnits(all: Hit[], f: Frame): Unit[] {
  const byBar = Array.from({ length: f.bars }, () => new Set<number>());
  for (const h of all) byBar[Math.floor(h.at / f.grid)].add(h.at % f.grid);
  return byBar.map((bar) => {
    const at = [...bar].sort((a, b) => a - b);
    const step = at.reduce(gcd, f.grid);
    return { bars: 1, voices: at.length ? [sequence(at.map((x) => ({ at: x, length: step, token: 'x' })), f.grid, f.grid)] : [] };
  });
}

interface Item { at: number; length: number; tones: Map<string, number> }
/** An item's mini-notation: its note, or its notes as a chord from the lowest up. */
function token(tones: Map<string, number>): string {
  const names = [...tones].sort((a, b) => a[1] - b[1]).map(([n]) => n);
  return names.length > 1 ? `[${names.join(',')}]` : names[0];
}
const lowest = (it: Item) => Math.min(...it.tones.values());

/**
 * A unit's notes as voices that never overlap. Notes struck together for the same length (or within the
 * overlap tolerance of the longest, which the chord takes) are one chord item. The items that end by the
 * next onset (trimmed by up to the tolerance) are the main line, one voice; the items still sounding
 * then are held notes, each in the other voice nearest in pitch that is free, or a new one. With
 * `MAX_VOICES` open, a held note cuts the voice that frees first, or joins its chord when both start
 * together.
 */
function voices(notes: Hit[], span: number, f: Frame): { at: number; length: number; token: string }[][] {
  const byStart = new Map<number, Hit[]>();
  for (const n of notes) (byStart.get(n.at) ?? byStart.set(n.at, []).get(n.at)!).push(n);
  const onsets = [...byStart.keys()].sort((a, b) => a - b);
  const line: Item[] = [], held: Item[] = [];
  onsets.forEach((at, k) => {
    const next = onsets[k + 1] ?? span;
    const chords: Item[] = [];
    for (const n of [...byStart.get(at)!].sort((a, b) => b.length - a.length || a.pitch - b.pitch)) {
      const c = chords.find((c) => trimmable(c.length - n.length, c.length, f));
      if (c) c.tones.set(n.token, n.pitch);
      else chords.push({ at, length: Math.min(n.length, span - at), tones: new Map([[n.token, n.pitch]]) });
    }
    for (const c of chords) if (c.length > next - at && trimmable(c.length - (next - at), c.length, f)) c.length = next - at;
    // The main line takes the fullest chord that ends by the next onset; the rest are held notes.
    const ends = chords.filter((c) => c.length <= next - at).sort((a, b) => b.tones.size - a.tones.size || b.length - a.length);
    if (ends.length) line.push(ends[0]);
    held.push(...chords.filter((c) => c !== ends[0]));
  });
  const out: Item[][] = line.length ? [line] : [];
  const end = (v: Item[]) => v[v.length - 1].at + v[v.length - 1].length;
  const others = () => out.filter((v) => v !== line);
  for (const item of held) {
    const free = others().filter((v) => end(v) <= item.at);
    const distance = (v: Item[]) => Math.abs(lowest(v[v.length - 1]) - lowest(item));
    const pick = free.length ? free.reduce((a, b) => (distance(b) < distance(a) ? b : a))
      : others().find((v) => trimmable(end(v) - item.at, v[v.length - 1].length, f))
      ?? (out.length >= MAX_VOICES && others().length ? others().reduce((a, b) => (end(b) < end(a) ? b : a)) : undefined);
    if (!pick) { out.push([item]); continue; }
    const last = pick[pick.length - 1];
    if (last.at === item.at) {
      for (const [n, pitch] of item.tones) last.tones.set(n, pitch);
      last.length = Math.max(last.length, item.length);
      continue;
    }
    if (end(pick) > item.at) last.length = item.at - last.at;
    pick.push(item);
  }
  if (out.some((v) => v.some((it) => it.tones.size > 1))) f.seen.chords = true;
  return out.map((v) => v.map((it) => ({ at: it.at, length: it.length, token: token(it.tones) })));
}

/**
 * One voice over `span` steps: each item for its length, rests in the gaps, weights in the largest whole
 * step. Returned as one line of tokens per bar they start in (a note at the end of a line may be held
 * into the next bar).
 */
function sequence(items: { at: number; length: number; token: string }[], span: number, grid: number): string[] {
  const steps: { token: string; at: number; w: number }[] = [];
  let pos = 0;
  for (const it of items) {
    if (it.at > pos) steps.push({ token: '~', at: pos, w: it.at - pos });
    steps.push({ token: it.token, at: it.at, w: it.length });
    pos = it.at + it.length;
  }
  if (pos < span) steps.push({ token: '~', at: pos, w: span - pos });
  if (steps.length === 1) return [steps[0].token];
  const unit = steps.reduce((g, st) => gcd(g, st.w), 0);
  const bars: string[][] = [];
  for (let i = 0; i < steps.length;) {
    const { token, at, w } = steps[i];
    const bar = Math.floor(at / grid);
    let j = i + 1;
    while (w === unit && j < steps.length && steps[j].token === token && steps[j].w === unit && Math.floor(steps[j].at / grid) === bar) j++;
    (bars[bar] ??= []).push(j - i > 1 ? `${token}!${j - i}` : w === unit ? token : `${token}@${w / unit}`);
    i = j;
  }
  return bars.filter(Boolean).map((tokens) => tokens.join(' '));
}
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

// ---------- layout ----------

/** Riff labels: A..Z, then AA, AB... (never a note name). */
export function riffLabel(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s;
  return s;
}

/** A unit's mini-notation on one line: its voices (`a, b`), spread over its bars (`[...]/2`); a rest is `~`. */
function mini(u: Unit): string {
  if (!u.voices.length) return '~';
  const body = u.voices.map((v) => v.join(' ')).join(', ');
  if (u.bars === 1) return body;
  return /^\[?[^\s[\]]+\]?$/.test(body) ? `${body}/${u.bars}` : `[${body}]/${u.bars}`;
}

/** Most chord names a comment lists. */
const MAX_CHORD_NAMES = 8;
const LETTERS: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
/** MIDI number of a note name the writer made (`c#4`, `bb3`). */
const midiOf = (name: string) => {
  const m = /^([a-g])(#|b)?(-?\d+)$/.exec(name)!;
  return (Number(m[3]) + 1) * 12 + LETTERS[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
};
/**
 * The chords a unit strikes, in order, named from their own notes (`[a3,d4,f4]` is Dm), a name once
 * while it repeats. Single notes are not chords; a voicing no template fits has no name.
 */
function chordNames(u: Unit, flats: boolean): string[] {
  const names: string[] = [];
  for (const m of mini(u).matchAll(/\[([a-g][#b]?-?\d+(?:,[a-g][#b]?-?\d+)+)\]/g)) {
    const pitches = m[1].split(',').map(midiOf);
    const classes = [...new Set(pitches.map((p) => p % 12))];
    const weights = new Array<number>(12).fill(0);
    for (const pc of classes) weights[pc] = 1;
    const bass = Math.min(...pitches) % 12;
    // A root and its fifth alone (either way up) is a power chord (F5), not the major triad a template would
    // guess; an inversion is named by its root, as the bass part plays the bass.
    const fifth = classes.length === 2 ? classes.find((pc) => classes.includes((pc + 7) % 12)) : undefined;
    const name = fifth !== undefined ? `${pcName(fifth, flats)}5`
      : detectChord(weights, bass, flats)?.replace(/\/.*$/, '').replace('^7', 'maj7');
    if (name && names[names.length - 1] !== name) names.push(name);
  }
  return names;
}
const listChords = (names: string[]) => (names.length > MAX_CHORD_NAMES ? [...names.slice(0, MAX_CHORD_NAMES), '…'] : names).join(' ');

/**
 * A part's code. One unit throughout: that unit, on one line or (spanning bars) a line per bar. A few
 * runs of single bars: one sequence of bars. Otherwise the distinct units are riffs picked in order. The
 * chords are named in comments: after each riff that has a line of its own, or, for a part written
 * without riffs, in its heading.
 */
function partCode(layer: Layer, units: Unit[], flats: boolean): string[] {
  const runs: { unit: Unit; count: number }[] = [];
  for (const u of units) {
    const last = runs[runs.length - 1];
    if (last && mini(last.unit) === mini(u)) last.count++; else runs.push({ unit: u, count: 1 });
  }
  const progression: string[] = [];
  for (const { unit } of runs) for (const c of chordNames(unit, flats)) if (progression[progression.length - 1] !== c) progression.push(c);
  const head = `// ${layer.comment}${progression.length ? ` · ${listChords(progression)}` : ''}`;
  const call = `const ${layer.name} = ${layer.drum ? `s("${layer.drum}").struct` : 'note'}(`;
  if (runs.length === 1) {
    const [u] = units;
    const line = `${call}"${mini(u)}")`;
    if (u.bars === 1 || line.length <= WIDTH) return [head, ...fit(line, layer.tail)];
    const body = u.voices.flatMap((v, i) => v.map((bar, k) => `  ${bar}${k === v.length - 1 && i < u.voices.length - 1 ? ',' : ''}`));
    return [head, `${call}\`[`, ...body, `]/${u.bars}\`)${layer.tail}`];
  }
  if (runs.length <= INLINE_RUNS && units.every((u) => u.bars === 1)) {
    const steps = runs.map(({ unit, count }) => {
      if (!unit.voices.length) return count > 1 ? `~@${count}` : '~';
      const one = /^[\w#:.-]+$/.test(mini(unit)) ? mini(unit) : `[${mini(unit)}]`; // `f#3!8` is eight notes in a bar, not eight bars
      return count > 1 ? `${one}!${count}` : one;
    });
    const line = `${call}"<${steps.join(' ')}>")`;
    if (line.length <= WIDTH) return [head, ...fit(line, layer.tail)];
    return [head, `${call}\`<`, ...steps.map((st) => `  ${st}`), `>\`)${layer.tail}`];
  }
  const labels = new Map<string, string>();
  for (const u of units) if (u.voices.length && !labels.has(mini(u))) labels.set(mini(u), riffLabel(labels.size));
  const order = runs.map(({ unit, count }) => {
    const label = unit.voices.length ? labels.get(mini(unit))! : '~';
    const cycles = count * unit.bars;
    return cycles > 1 ? `${label}@${cycles}` : label;
  });
  const oneLine = `${call}"<${order.join(' ')}>".pickRestart({`;
  const lines = [`// ${layer.comment}`, ...(oneLine.length <= WIDTH ? [oneLine] : [`${call}\`<`, ...wrap(order, '  '), '>`.pickRestart({'])];
  // Short riffs pack several to a line; a riff on a line of its own names the chords it strikes after it.
  const chords = new Map([...labels].map(([body, label]) => [`${label}: "${body}",`, chordNames(units.find((u) => mini(u) === body)!, flats)]));
  for (const line of wrap([...chords.keys()], '  ')) {
    const names = chords.get(line.trim());
    lines.push(names?.length ? `${line} // ${listChords(names)}` : line);
  }
  lines.push(`}))${layer.tail}`);
  return lines;
}

/** `code` with `tail` appended, on its own line when both do not fit. */
function fit(code: string, tail: string): string[] {
  return `${code}${tail}`.length <= WIDTH ? [`${code}${tail}`] : [code, `  ${tail}`];
}

/** Items joined by spaces into lines of at most `WIDTH` characters, each starting with `indent`. */
function wrap(items: string[], indent: string): string[] {
  const lines: string[] = [];
  let line = '';
  for (const item of items) {
    if (line && indent.length + line.length + 1 + item.length > WIDTH) { lines.push(indent + line); line = item; }
    else line = line ? `${line} ${item}` : item;
  }
  if (line) lines.push(indent + line);
  return lines;
}
