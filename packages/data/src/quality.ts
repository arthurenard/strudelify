import type { Song } from '@strudelify/core';

/** Structural quality, not a claim of recording fidelity. Saturating counts avoid rewarding ornamentation. */
export function transcriptionScore(song: Song): number {
  const instrumental = song.tracks.filter(t => !t.vocal && t.notes.length >= 8);
  const pitched = instrumental.filter(t => t.role !== 'drums');
  if (!pitched.length) return -1;
  const end = instrumental.reduce((end, t) => t.notes.reduce((end, n) => Math.max(end, n.start + n.duration), end), 0);
  const seconds = end * 60 / song.meta.bpm;
  const notes = pitched.reduce((n, t) => n + t.notes.length, 0);
  const named = pitched.filter(t => t.name.trim()).length / pitched.length;
  return Math.min(120, seconds) * 10 + Math.min(notes, 1500) / 10
    + (instrumental.some(t => t.role === 'bass') ? 250 : 0)
    + (instrumental.some(t => t.role === 'drums') ? 250 : 0)
    + named * 200 + (song.tracks.some(t => t.vocal) ? 100 : 0);
}
