/**
 * The Main loop: one phrase of the song, usually eight bars, chosen automatically; never unrelated
 * passages stitched together.
 *
 * Every bar gets a fingerprint per section of the band (bass, harmony, melody, drums: which pitch classes
 * sound and where the onsets fall), so two bars compare by how alike they sound, not by being identical.
 * Each phrase-length window is then scored on:
 * - how often the song plays it again (a chorus, a groove), counting near repeats;
 * - whether it recurs right after itself, so the loop's end leads back into its start as in the song;
 * - how much of the band plays through it (bass, drums, harmony, and the tune when the song has one);
 * - a crash cymbal on its first downbeat (a phrase starts there), and not sitting in the intro or the
 *   outro; very dense passages make long code and score a little lower.
 */
import type { Song, SongMeta, Track, NoteEvent } from './types.js';
import { barLength, barStart, cyclesPerMinute, detectSectionsFromMidi } from './midi.js';
import { barRange, EARLY_BEATS, type CompileOptions } from './strudel.js';
import { partLevels } from './arrangement.js';

export interface LoopSelection { song: Song; firstBar: number; bars: number; repeats: number; omittedTracks: number }

/** A loop of eight bars lasting less than this (seconds) takes sixteen; one lasting more than `LONGEST_SECONDS`, four. */
export const SHORTEST_SECONDS = 12;
export const LONGEST_SECONDS = 40;
/** Two windows this alike (mean bar similarity, 0-1) are the same passage played again. */
export const REPEAT_SIMILARITY = 0.8;
/** Most pitched parts and percussion sounds a loop keeps. */
const MAX_PITCHED = 4;
const MAX_DRUMS = 6;
/** The share of onsets a loop grid must place within `GRID_TOLERANCE` seconds (see `loopGrid`). */
const GRID_SHARE = 0.95;
const GRID_TOLERANCE = 0.035;

/** Bars in a loop: a phrase of eight, or sixteen / four when eight bars would be too short / too long to hear as a loop. */
export function loopLength(meta: SongMeta, totalBars: number): number {
  const eight = 8 * 60 / cyclesPerMinute(meta);
  const bars = eight < SHORTEST_SECONDS ? 16 : eight > LONGEST_SECONDS ? 4 : 8;
  return Math.max(1, Math.min(bars, totalBars));
}

export function selectLoop(source: Song, opts: CompileOptions = {}): LoopSelection {
  const originalMeter = `${source.meta.beatsPerBar}/${source.meta.beatUnit}`;
  const regrouped = barLength(source.meta) > 16 || source.meta.beatsPerBar > 32;
  // Extreme source metres can turn two bars into minutes of music. Keep elapsed quarter-note
  // positions, but use an explicitly disclosed four-beat editing grid for these sketches.
  if (regrouped && source.tracks.length) source = { ...source, meta: { ...source.meta, beatsPerBar: 4, beatUnit: 4, barOffset: 0 } };
  if (!source.tracks.length && source.sections.length) return chartLoop(source);
  const range = barRange(source, Number.MAX_SAFE_INTEGER);
  if (!range || !source.tracks.length) return { song: source, firstBar: 0, bars: 0, repeats: 0, omittedTracks: 0 };
  const length = barLength(source.meta), origin = barStart(source.meta, range.firstBar);
  const tracks = source.tracks.filter(t => !t.vocal && (opts.melody !== false || t.role !== 'melody'));
  if (!tracks.length) return { song: source, firstBar: range.firstBar, bars: range.totalBars, repeats: 0, omittedTracks: 0 };

  const bars = loopLength(source.meta, range.totalBars);
  const best = chooseWindow(fingerprints(tracks, range.totalBars, origin, length), bars);
  const start = origin + best.first * length, end = start + bars * length;

  // The notes sounding in the window: a note held into it from before starts on its first beat.
  const excerpt = tracks.map(t => ({ ...t, notes: t.notes.filter(n => n.start < end - 0.002 && n.start + n.duration > start + 0.002).map(n => {
    const at = Math.max(0, n.start - start), stop = Math.min(end, n.start + n.duration) - start;
    return { ...n, start: at, duration: Math.max(0.000001, stop - at) };
  }) })).filter(t => t.notes.length);
  const weight = (t: Track) => (t.role === 'bass' ? 1000 : t.role === 'melody' ? 500 : 0)
    + Math.min(100, t.notes.reduce((n, e) => n + e.duration * e.velocity * (e.volume ?? t.volume ?? 0.8), 0));
  const cap = Math.max(1, Math.min(MAX_PITCHED, opts.maxTracks ?? MAX_PITCHED));
  const pitched = excerpt.filter(t => t.role !== 'drums').sort((a, b) => weight(b) - weight(a)).slice(0, cap);
  const selected = [...pitched, ...excerpt.filter(t => t.role === 'drums')];
  const drumWeights = new Map<number, number>();
  for (const t of selected.filter(t => t.role === 'drums')) for (const n of t.notes) drumWeights.set(n.pitch, (drumWeights.get(n.pitch) ?? 0) + n.velocity);
  const drumPriority = (pitch: number) => [35, 36, 38, 40, 42, 44, 46].includes(pitch) ? 1000 : 0;
  const drumVoices = [...drumWeights.keys()].sort((a, b) => drumPriority(b) - drumPriority(a) || drumWeights.get(b)! - drumWeights.get(a)!).slice(0, MAX_DRUMS);
  for (const t of selected.filter(t => t.role === 'drums')) t.notes = t.notes.filter(n => drumVoices.includes(n.pitch));

  // A compact loop is a musical sketch: one shared rhythmic grid and stable channel controls.
  const grid = loopGrid(selected.flatMap(t => t.notes.map(n => n.start)), length, source.meta.bpm);
  const step = length / grid, span = bars * grid;
  let ghosts = false;
  for (const track of selected) {
    track.volume = median(track.notes.map(n => n.volume ?? track.volume ?? 0.8));
    track.pan = Math.round(median(track.notes.map(n => n.pan ?? track.pan ?? 0.5)) * 10) / 10;
    const { level, ghosts: soft } = partLevels(track);
    ghosts ||= soft;
    const attacks = new Map<string, NoteEvent>();
    for (const note of track.notes) {
      const cell = Math.max(0, Math.round(note.start / step));
      // A note struck a hair before the loop's end and still sounding there is the next downbeat's, played early:
      // the loop's own start has it (held in from before the window).
      if (cell >= span || (bars * length - note.start <= EARLY_BEATS && note.start + note.duration >= bars * length - 1e-6)) continue;
      const duration = Math.min(span - cell, Math.max(1, Math.round(note.duration / step))) * step;
      const velocity = level(note);
      const key = `${cell}:${note.pitch}`;
      const prior = attacks.get(key);
      if (!prior || prior.velocity < velocity) attacks.set(key, { pitch: note.pitch, start: cell * step, duration, velocity });
    }
    track.notes = [...attacks.values()].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  }
  const kept = selected.filter(t => t.notes.length);
  const omittedTracks = excerpt.length - selected.length;
  const omittedDrums = drumWeights.size - drumVoices.length;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const song: Song = { meta: { ...source.meta, barOffset: 0, grid, loopBars: bars, loopFrom: best.first, remarks: [
    `Main loop: bars ${best.first + 1}–${best.first + bars} of the song${best.repeats > 1 ? `, a passage it plays ${best.repeats} times` : ''}. An excerpt, not the full song.`,
    ...(source.meta.remarks ?? []).filter(r => r.startsWith('Transcription provider:')),
    ...(regrouped ? [`Source metre ${originalMeter} regrouped on a 4/4 editing grid for this short excerpt.`] : []),
    `Notes on a ${grid}-step grid, each part at one level${ghosts ? '; ghost notes are separate "_soft" parts' : ''}.`,
    ...(omittedTracks ? [`${plural(omittedTracks, 'quieter instrumental part')} left out of the loop.`] : []),
    ...(omittedDrums ? [`${plural(omittedDrums, 'rarer percussion sound')} left out of the loop.`] : []),
  ] }, tracks: kept, sections: [] };
  song.sections = detectSectionsFromMidi(song);
  return { song, firstBar: range.firstBar + best.first, bars, repeats: best.repeats, omittedTracks };
}

/** A chord chart's loop: its chorus (or first section of four bars or more), up to a loop's length. */
function chartLoop(source: Song): LoopSelection {
  const chorus = source.sections.find(s => /chorus|refrain/i.test(s.label));
  const section = chorus ?? source.sections.find(s => s.bars >= 4) ?? source.sections[0];
  const firstBar = source.sections.slice(0, source.sections.indexOf(section)).reduce((n, s) => n + s.bars, 0);
  const bars = loopLength(source.meta, section.bars);
  let remaining = bars * source.meta.beatsPerBar;
  const chords = section.chords.flatMap(c => {
    if (remaining <= 0) return [];
    const beats = Math.min(remaining, c.beats); remaining -= beats; return [{ ...c, beats }];
  });
  const song = { ...source, meta: { ...source.meta, loopBars: bars, loopFrom: firstBar, remarks: [`Main loop: generated accompaniment from ${section.label}, source bars ${firstBar + 1}–${firstBar + bars}. This is a chord-chart excerpt.`] }, sections: [{ ...section, bars, chords }] };
  return { song, firstBar, bars, repeats: 1, omittedTracks: 0 };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

/**
 * The coarsest musical grid (steps per bar) that places `GRID_SHARE` of the onsets within
 * `GRID_TOLERANCE` seconds, so a slightly loose performance still reads on sixteenths or triplets.
 */
export function loopGrid(onsets: number[], length: number, bpm: number): number {
  return [8, 12, 16, 24, 32, 48].find(g => onsets.filter(at => Math.abs(Math.round(at / length * g) / g * length - at) * 60 / bpm <= GRID_TOLERANCE).length >= onsets.length * GRID_SHARE) ?? 48;
}

// ---------- choosing the window ----------

/** The band's sections, each fingerprinted separately. */
const GROUPS = ['bass', 'harmony', 'melody', 'drums'] as const;
type Group = typeof GROUPS[number];
const groupOf = (t: Track): Group => (t.role === 'bass' || t.role === 'drums' || t.role === 'melody' ? t.role : 'harmony');
/** Crash, china and splash cymbals: one on a downbeat usually starts a phrase. */
const CRASHES = new Set([49, 52, 55, 57]);

interface Bar {
  /** Per group: which pitch classes sound (drums: which sounds) and on which sixteenth, counted; absent when the group rests. */
  vectors: Partial<Record<Group, Map<string, number>>>;
  notes: number;
  crash: boolean;
}
interface Prints { bars: Bar[]; groups: Set<Group> }

/** Each bar's fingerprint. A note played just ahead of a downbeat belongs to that bar (see `EARLY_BEATS`). */
function fingerprints(tracks: Track[], total: number, origin: number, length: number): Prints {
  const bars: Bar[] = Array.from({ length: total }, () => ({ vectors: {}, notes: 0, crash: false }));
  const groups = new Set<Group>();
  for (const t of tracks) {
    const g = groupOf(t);
    for (const n of t.notes) {
      const at = (n.start - origin + EARLY_BEATS) / length;
      const b = Math.floor(at);
      if (b < 0 || b >= total) continue;
      const bar = bars[b];
      const pos = Math.min(15, Math.floor((at - b) * 16));
      const what = g === 'drums' ? `d${drumClass(n.pitch)}` : `p${n.pitch % 12}`;
      const v = bar.vectors[g] ?? (bar.vectors[g] = new Map());
      for (const key of [what, `${what}@${pos}`]) v.set(key, (v.get(key) ?? 0) + 1);
      bar.notes++;
      groups.add(g);
      if (g === 'drums' && CRASHES.has(n.pitch) && at - b < 0.25) bar.crash = true;
    }
  }
  return { bars, groups };
}
/** Drum sounds that fill the same role compare as one: kick, snare, hi-hat, cymbal, toms and the rest. */
function drumClass(pitch: number): number {
  if (pitch === 35 || pitch === 36) return 0;
  if (pitch === 37 || pitch === 38 || pitch === 39 || pitch === 40) return 1;
  if (pitch === 42 || pitch === 44 || pitch === 46) return 2;
  if (CRASHES.has(pitch) || pitch === 51 || pitch === 53 || pitch === 59) return 3;
  if (pitch >= 41 && pitch <= 50) return 4;
  return 5;
}
function cosine(a: Map<string, number> | undefined, b: Map<string, number> | undefined): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  let dot = 0, na = 0, nb = 0;
  for (const [k, x] of a) { na += x * x; dot += x * (b.get(k) ?? 0); }
  for (const x of b.values()) nb += x * x;
  return dot / Math.sqrt(na * nb);
}
/** How alike two bars sound (0-1): the mean over the band's sections of how alike each plays. */
function barSimilarity(a: Bar, b: Bar, groups: Set<Group>): number {
  let sum = 0;
  for (const g of groups) sum += cosine(a.vectors[g], b.vectors[g]);
  return groups.size ? sum / groups.size : 1;
}

/**
 * The best window of `bars` bars (see the module notes). Windows start on any bar; how alike two windows
 * are is the mean similarity of their bars, one to one.
 */
function chooseWindow(p: Prints, bars: number): { first: number; repeats: number } {
  const total = p.bars.length, starts = total - bars + 1;
  if (starts <= 1) return { first: 0, repeats: 1 };
  // Bar-to-bar similarity summed along each diagonal, so any two windows compare in constant time.
  const memo = new Map<number, Float64Array>();
  const diagonal = (d: number) => {
    let row = memo.get(d);
    if (!row) {
      row = new Float64Array(total - d + 1);
      for (let a = 0; a + d < total; a++) row[a + 1] = row[a] + barSimilarity(p.bars[a], p.bars[a + d], p.groups);
      memo.set(d, row);
    }
    return row;
  };
  const alike = (a: number, b: number) => {
    const x = Math.min(a, b), row = diagonal(Math.abs(a - b));
    return (row[x + bars] - row[x]) / bars;
  };
  const band = GROUPS.filter(g => p.groups.has(g));
  const meanNotes = p.bars.reduce((n, b) => n + b.notes, 0) / total;
  let best = { first: 0, repeats: 1, score: -Infinity };
  for (let a = 0; a < starts; a++) {
    // How often the song plays this passage (itself included), counting windows that do not overlap.
    let repeats = 1;
    for (let b = 0, last = -Infinity; b < starts; b++) {
      if (Math.abs(b - a) < bars || b - last < bars) continue;
      if (alike(a, b) >= REPEAT_SIMILARITY) { repeats++; last = b; }
    }
    const seam = Math.max(a + 2 * bars <= total ? alike(a, a + bars) : 0, a >= bars ? alike(a, a - bars) : 0);
    let playing = 0, notes = 0;
    for (let b = a; b < a + bars; b++) {
      playing += band.filter(g => p.bars[b].vectors[g]).length / band.length;
      notes += p.bars[b].notes;
    }
    const edge = a < 0.08 * total || a + bars > 0.94 * total;
    const score = 3 * Math.log2(repeats) + 2 * seam + 5 * playing / bars + (p.bars[a].crash ? 1 : 0) - (edge ? 1 : 0)
      - Math.max(0, notes / bars / Math.max(1, meanNotes) - 1.5);
    if (score > best.score) best = { first: a, repeats, score };
  }
  return best;
}
