/** Clean an entire transcription for editing without cropping its form or repeating a short excerpt. */
import type { Song, Track, NoteEvent } from './types.js';
import { barLength, barStart, detectSectionsFromMidi } from './midi.js';
import { drumName, percName } from './gm.js';
import { fitGrid } from './grid.js';
import { barRange } from './strudel.js';

/** A note played this much softer than its part's typical velocity is a ghost note. */
export const GHOST_RATIO = 0.65;
/** A part keeps a soft level when this share of its notes, and at least `GHOST_MIN` of them, are ghost notes. */
export const GHOST_SHARE = 0.05;
const GHOST_MIN = 4;
const middle = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0.8;

/** The level each note plays at, and whether any note plays at a second, softer level. */
export interface Levels { level: (n: NoteEvent) => number; ghosts: boolean }

/**
 * Dynamics as at most two levels, each rounded to a tenth: the typical velocity (the median) and, when
 * ghost notes are common enough to be a feature of the part (snare ghost notes, soft pickups), their own
 * median.
 */
function dynamicLevels(velocities: number[]): { level: (velocity: number) => number; ghosts: boolean } {
  const round = (v: number) => Math.min(1, Math.max(0.1, Math.round(v * 10) / 10));
  const typical = middle(velocities);
  const ghosts = velocities.filter((v) => v < typical * GHOST_RATIO);
  const soft = ghosts.length >= Math.max(GHOST_MIN, GHOST_SHARE * velocities.length) ? round(middle(ghosts)) : undefined;
  return { level: (v) => (soft !== undefined && v < typical * GHOST_RATIO ? soft : round(typical)), ghosts: soft !== undefined && soft !== round(typical) };
}

/** A part's dynamic levels (see `dynamicLevels`); a drum kit's per sound, as the snare's ghost notes are not the kick's. */
export function partLevels(t: Track): Levels {
  if (t.role !== 'drums') {
    const d = dynamicLevels(t.notes.map((n) => n.velocity));
    return { level: (n) => d.level(n.velocity), ghosts: d.ghosts };
  }
  const sound = (pitch: number) => drumName(pitch) ?? percName(pitch)?.sample ?? String(pitch);
  const bySound = new Map<string, number[]>();
  for (const n of t.notes) (bySound.get(sound(n.pitch)) ?? bySound.set(sound(n.pitch), []).get(sound(n.pitch))!).push(n.velocity);
  const levels = new Map([...bySound].map(([k, vs]) => [k, dynamicLevels(vs)]));
  return { level: (n) => levels.get(sound(n.pitch))!.level(n.velocity), ghosts: [...levels.values()].some((d) => d.ghosts) };
}

/** A remark when the grid follows a transcription that plays off the beat throughout (see grid.ts), from 10 ms. */
export function shiftNote(shift: number, bpm: number): string[] {
  const ms = Math.round(Math.abs(shift) * 60000 / bpm);
  return ms >= 10 ? [`The whole transcription plays ${ms} ms ${shift < 0 ? 'ahead of' : 'behind'} the beat; the grid follows it, so its parts stay together.`] : [];
}

export function prepareArrangement(source: Song): Song {
  const range = barRange(source, Number.MAX_SAFE_INTEGER);
  if (!range || !source.tracks.length) return source;
  const length = barLength(source.meta), origin = barStart(source.meta, range.firstBar);
  const end = range.totalBars * length;
  const instrumental = source.tracks.filter(t => !t.vocal);
  if (!instrumental.length) return source;
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? .8;
  // One musical grid for all the parts, started where the band plays (see grid.ts); source-detail mode retains
  // microtiming and expressive controls.
  const { grid, shift } = fitGrid(instrumental.flatMap(t => t.notes.map(n => n.start - origin)), length, source.meta.bpm, [16, 24, 32, 48], 32, .9, .035);
  const zero = origin + shift, step = length / grid;
  let ghosts = false;
  const tracks: Track[] = instrumental.map(t => {
    const { level, ghosts: soft } = partLevels(t);
    ghosts ||= soft;
    const volumes = t.notes.map(n => n.volume ?? t.volume ?? .8);
    const volume = median(volumes.filter(v => v > 0));
    const pan = Math.round(median(t.notes.map(n => n.pan ?? t.pan ?? .5)) * 10) / 10;
    const groups = new Map<string, NoteEvent>();
    for (const n of t.notes) {
      if (n.duration <= 0 || n.velocity <= 0 || (n.volume ?? t.volume ?? .8) <= 0) continue;
      const start = Math.min(end - step, Math.max(0, Math.round((n.start - zero) / step) * step));
      const duration = Math.min(end - start, Math.max(step, Math.round(n.duration / step) * step));
      const key = `${start}:${n.pitch}`, previous = groups.get(key), velocity = level(n);
      if (previous) { previous.duration = Math.max(previous.duration, duration); previous.velocity = Math.max(previous.velocity, velocity); }
      else groups.set(key, { pitch: n.pitch, start, duration, velocity, played: { start: n.start - zero, duration: n.duration } });
    }
    const notes = [...groups.values()].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
    // A repeated attack replaces an overlapping release of that same pitch.
    const last = new Map<number, NoteEvent>();
    for (const n of notes) {
      const previous = last.get(n.pitch);
      if (previous) previous.duration = Math.min(previous.duration, n.start - previous.start);
      last.set(n.pitch, n);
    }
    if (t.program >= 24 && t.program <= 31) {
      const chords = new Map<number, NoteEvent[]>();
      for (const n of notes) { const chord = chords.get(n.start) ?? []; chord.push(n); chords.set(n.start, chord); }
      for (const chord of chords.values()) if (chord.length > 1 && Math.max(...chord.map(n => n.duration)) - Math.min(...chord.map(n => n.duration)) <= step + 1e-6) {
        const gate = median(chord.map(n => n.duration));
        for (const n of chord) n.duration = gate;
      }
    }
    return { ...t, notes, volume, pan };
  });
  const omitted: string[] = [];
  const guitarKeys = new Map(tracks.filter(t => t.program >= 24 && t.program <= 31).map(t => [t, new Set(t.notes.map(n => `${Math.round(n.start / step)}:${n.pitch % 12}`))]));
  const kept = tracks.flatMap(t => {
    if (!guitarKeys.has(t)) return [t];
    const duplicate = tracks.find(other => other !== t && other.notes.length > t.notes.length && guitarKeys.has(other)
      && t.notes.filter(n => guitarKeys.get(other)!.has(`${Math.round(n.start / step)}:${n.pitch % 12}`)).length >= t.notes.length * .8);
    if (!duplicate) return [t];
    // Keep unique fills and solos from a doubled track; dropping the whole track loses musical content.
    const notes = t.notes.filter(n => !guitarKeys.get(duplicate)!.has(`${Math.round(n.start / step)}:${n.pitch % 12}`));
    omitted.push(t.name || `guitar program ${t.program}`);
    return notes.length ? [{ ...t, notes }] : [];
  });
  const song: Song = { ...source, meta: { ...source.meta, barOffset: 0, arrangementBars: range.totalBars, grid, remarks: [
    ...(source.meta.remarks ?? []),
    `Full arrangement: all ${range.totalBars} bars on a ${grid}-step grid, each part at one level${ghosts ? '; ghost notes are separate "_soft" parts' : ''}. Source detail keeps the original performance.`,
    ...(omitted.length ? [`Guitar parts that double another keep only their own notes (fills, solos): ${omitted.join(', ')}.`] : []),
    ...(shiftNote(shift, source.meta.bpm)),
  ] }, tracks: kept, sections: [] };
  song.sections = detectSectionsFromMidi(song);
  return song;
}
