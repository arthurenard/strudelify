import { it, expect } from 'vitest';
import { transcriptionScore } from '../src/quality.js';
import type { Song } from '@strudelify/core';
import fs from 'node:fs';
import crypto from 'node:crypto';
const meta = { id: 's', title: 'Song', artist: 'Artist', bpm: 120, beatsPerBar: 4, beatUnit: 4, sources: ['midi'] as const };
it('prefers a complete named instrumental arrangement over a brief note-dense excerpt', () => {
  const notes = (count: number, end: number) => Array.from({ length: count }, (_, i) => ({ pitch: 60, start: i * end / count, duration: 0.2, velocity: 0.8 }));
  const make = (count: number, end: number): Song => ({ meta: { ...meta, sources: ['midi'] }, sections: [], tracks: [{ name: 'Guitar', program: 27, role: 'chords', notes: notes(count, end) }] });
  expect(transcriptionScore(make(500, 280))).toBeGreaterThan(transcriptionScore(make(5000, 60)));
});
it('pins reviewed sources by checksum', () => {
  const root = new URL('../curated/', import.meta.url);
  const manifest = JSON.parse(fs.readFileSync(new URL('manifest.json', root), 'utf8'));
  for (const entry of manifest.entries) expect(crypto.createHash('sha256').update(fs.readFileSync(new URL(entry.file, root))).digest('hex')).toBe(entry.sha256);
});
