/** Clean an entire transcription for editing without cropping its form or repeating a short excerpt. */
import type { Song, Track, NoteEvent } from './types.js';
import { barLength, barStart, detectSectionsFromMidi } from './midi.js';
import { barRange } from './strudel.js';

export function prepareArrangement(source: Song): Song {
  const range = barRange(source, Number.MAX_SAFE_INTEGER);
  if (!range || !source.tracks.length) return source;
  const length = barLength(source.meta), origin = barStart(source.meta, range.firstBar);
  const end = range.totalBars * length;
  const instrumental = source.tracks.filter(t => !t.vocal);
  if (!instrumental.length) return source;
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? .8;
  const attacks = instrumental.flatMap(t => t.notes.map(n => (n.start - origin) / length));
  // Prefer a shared musical grid; source-detail mode retains microtiming and expressive controls.
  const grid = [16, 24, 32, 48].find(g => attacks.filter(at => Math.abs(Math.round(at * g) / g - at) * length * 60 / source.meta.bpm <= .035).length >= attacks.length * .9) ?? 32;
  const step = length / grid;
  const tracks: Track[] = instrumental.map(t => {
    const velocity = Math.min(1, Math.max(.1, Math.round(median(t.notes.map(n => n.velocity)) * 10) / 10));
    const volumes = t.notes.map(n => n.volume ?? t.volume ?? .8);
    const volume = median(volumes.filter(v => v > 0));
    const pan = Math.round(median(t.notes.map(n => n.pan ?? t.pan ?? .5)) * 10) / 10;
    const groups = new Map<string, NoteEvent>();
    for (const n of t.notes) {
      if (n.duration <= 0 || n.velocity <= 0 || (n.volume ?? t.volume ?? .8) <= 0) continue;
      const start = Math.min(end - step, Math.max(0, Math.round((n.start - origin) / step) * step));
      const duration = Math.min(end - start, Math.max(step, Math.round(n.duration / step) * step));
      const key = `${start}:${n.pitch}`, previous = groups.get(key);
      if (previous) previous.duration = Math.max(previous.duration, duration);
      else groups.set(key, { pitch: n.pitch, start, duration, velocity });
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
    `Full arrangement: all ${range.totalBars} bars on a ${grid}-step grid, one level per part, drums with their natural decay. Source detail keeps the original performance.`,
    ...(omitted.length ? [`Guitar parts that double another keep only their own notes (fills, solos): ${omitted.join(', ')}.`] : []),
  ] }, tracks: kept, sections: [] };
  song.sections = detectSectionsFromMidi(song);
  return song;
}
