/** Reproducible catalogue-wide readability measurements, without starting audio. */
import fs from 'node:fs';
import { loadSong, compile } from '../packages/core/dist/index.js';
const db = new URL('../packages/data/public/db/', import.meta.url);
const entries = JSON.parse(fs.readFileSync(new URL('index.json', db), 'utf8'));
const rows = [];
for (const entry of entries) {
  const song = await loadSong(entry, async file => fs.readFileSync(new URL(file, db)));
  const code = compile(song, { form: 'loop', timing: 'patterns' });
  rows.push({ id: entry.id, chars: code.length, lines: code.split('\n').length });
}
const percentile = (key, p) => [...rows].sort((a, b) => a[key] - b[key])[Math.ceil(rows.length * p) - 1][key];
console.log(JSON.stringify({ entries: rows.length, chars: { median: percentile('chars', .5), p95: percentile('chars', .95), max: percentile('chars', 1) }, lines: { median: percentile('lines', .5), p95: percentile('lines', .95), max: percentile('lines', 1) }, largest: rows.sort((a, b) => b.chars - a.chars).slice(0, 20) }, null, 2));
