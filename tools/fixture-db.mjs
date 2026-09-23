#!/usr/bin/env node
/**
 * A two-song database from the curated sources (packages/data/curated), for building and checking the website
 * where the real catalogue is not available (CI, a fresh clone). Refuses to touch an existing database.
 *   node tools/fixture-db.mjs [--db=/absolute/path]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSong } from '../packages/core/dist/index.js'; // run `npm run build` first

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = path.resolve(process.argv.find((a) => a.startsWith('--db='))?.slice(5) ?? path.join(root, 'packages/data/public/db'));
if (fs.existsSync(path.join(db, 'index.json'))) {
  console.error(`${db} already holds a database; the fixture never replaces one.`);
  process.exit(1);
}
const curated = JSON.parse(fs.readFileSync(path.join(root, 'packages/data/curated/manifest.json'), 'utf8')).entries;
const names = {
  'the-beatles--love-me-do': { title: 'Love Me Do', artist: 'The Beatles', year: 1962 },
  'nirvana--smells-like-teen-spirit': { title: 'Smells Like Teen Spirit', artist: 'Nirvana', year: 1991 },
};
fs.mkdirSync(path.join(db, 'songs'), { recursive: true });
const entries = [];
for (const c of curated) {
  const file = path.join(db, 'songs', `${c.id}.mid`);
  fs.copyFileSync(path.join(root, 'packages/data/curated', c.file), file);
  const entry = { id: c.id, ...names[c.id], sources: ['midi'], popularity: 1, files: { midi: `songs/${c.id}.mid` } };
  for (const k of ['drumKit', 'vocalChannels', 'beatScale', 'sourceNote']) if (c[k] !== undefined) entry[k] = c[k];
  // Tempo and key as the song page reads them.
  const song = await loadSong(entry, async (p) => new Uint8Array(fs.readFileSync(path.join(db, p))));
  entries.push({ ...entry, bpm: song.meta.bpm, ...(song.meta.tonic ? { key: `${song.meta.tonic} ${song.meta.mode ?? ''}`.trim() } : {}) });
}
fs.writeFileSync(path.join(db, 'index.json'), JSON.stringify(entries));
console.log(`fixture database with ${entries.length} songs -> ${db}`);
