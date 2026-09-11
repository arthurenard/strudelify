/** Template-matching chord detection from pitch-class weights (durations) within a bar. */
import { pcName } from './chords.js';

const TEMPLATES: { suffix: string; tones: number[]; bonus: number }[] = [
  { suffix: '', tones: [0, 4, 7], bonus: 0.1 },
  { suffix: 'm', tones: [0, 3, 7], bonus: 0.1 },
  { suffix: '7', tones: [0, 4, 7, 10], bonus: 0 },
  { suffix: 'm7', tones: [0, 3, 7, 10], bonus: 0 },
  { suffix: '^7', tones: [0, 4, 7, 11], bonus: 0 },
  { suffix: 'dim', tones: [0, 3, 6], bonus: -0.05 },
  { suffix: 'm7b5', tones: [0, 3, 6, 10], bonus: -0.05 },
  { suffix: 'sus4', tones: [0, 5, 7], bonus: -0.12 },
  { suffix: 'sus2', tones: [0, 2, 7], bonus: -0.12 },
  { suffix: '5', tones: [0, 7], bonus: -0.15 },
  { suffix: 'aug', tones: [0, 4, 8], bonus: -0.1 },
];

export function detectChord(weights: number[], bassPc?: number, preferFlats = false): string | null {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  let best: { score: number; root: number; suffix: string } | null = null;
  for (let root = 0; root < 12; root++) {
    for (const t of TEMPLATES) {
      let inChord = 0;
      for (const iv of t.tones) inChord += weights[(root + iv) % 12];
      const out = total - inChord;
      // Each chord tone should be present: penalise missing tones.
      let missing = 0;
      for (const iv of t.tones) if (weights[(root + iv) % 12] < total * 0.05) missing++;
      let score = inChord / total - (out / total) * 0.8 - missing * 0.25 + t.bonus;
      if (bassPc !== undefined && bassPc === root) score += 0.15;
      if (!best || score > best.score) best = { score, root, suffix: t.suffix };
    }
  }
  if (!best || best.score < 0.2) return null;
  const root = pcName(best.root, preferFlats);
  let sym = `${root}${best.suffix}`;
  if (bassPc !== undefined && bassPc !== best.root) {
    const iv = (bassPc - best.root + 12) % 12;
    if ([3, 4, 7, 10, 11].includes(iv)) sym += `/${pcName(bassPc, preferFlats)}`;
  }
  return sym;
}
