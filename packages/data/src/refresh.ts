/**
 * Bring an existing database up to date with the current analysis, without the raw datasets: each
 * entry's tempo and key are read again from its own source files (exactly as the song page reads
 * them, see `loadSong`), and imported score titles and artists are cleaned again (see metadata.ts).
 * An imported score whose title or artist names nothing is removed with its file. Song choice and
 * ids are left alone; a full rebuild (build.ts) is what re-selects sources.
 * Usage: node dist/refresh.js [--dry-run] [--db=/absolute/path]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSong, type IndexEntry } from '@strudelify/core';
import { cleanArtist, cleanTitle } from './metadata.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = path.resolve(process.argv.find((x) => x.startsWith('--db='))?.slice(5) ?? path.join(ROOT, 'public/db'));
const dryRun = process.argv.includes('--dry-run');

async function main() {
  const file = path.join(DB, 'index.json');
  if (!fs.existsSync(file)) throw new Error(`No database at ${DB}.`);
  const entries: IndexEntry[] = JSON.parse(fs.readFileSync(file, 'utf8'));
  const read = async (p: string) => new Uint8Array(fs.readFileSync(path.join(DB, p)));
  const changes = { bpm: 0, key: 0, title: 0, artist: 0 };
  const removed: IndexEntry[] = [], failed: { id: string; error: string }[] = [];
  const kept: IndexEntry[] = [];
  for (const entry of entries) {
    if (entry.provenance?.provider === 'pdmx') {
      const title = cleanTitle(entry.title), artist = cleanArtist(entry.artist);
      if (!title || !artist) { removed.push(entry); continue; }
      if (title !== entry.title) { changes.title++; entry.title = title; }
      if (artist !== entry.artist) { changes.artist++; entry.artist = artist; }
    }
    try {
      const song = await loadSong(entry, read);
      const key = song.meta.tonic ? `${song.meta.tonic} ${song.meta.mode ?? ''}`.trim() : undefined;
      if (song.meta.bpm !== entry.bpm) { changes.bpm++; entry.bpm = song.meta.bpm; }
      if (key !== entry.key) { changes.key++; if (key) entry.key = key; else delete entry.key; }
    } catch (e) {
      failed.push({ id: entry.id, error: (e as Error).message });
    }
    kept.push(entry);
  }
  console.log(JSON.stringify({ entries: entries.length, changed: changes, removed: removed.map((e) => e.id), failed, dryRun }, null, 2));
  if (failed.length) throw new Error(`${failed.length} entries could not be read; nothing was written.`);
  if (dryRun) return;
  kept.sort((a, b) => a.artist.localeCompare(b.artist, 'en') || a.title.localeCompare(b.title, 'en'));
  fs.writeFileSync(`${file}.next`, JSON.stringify(kept));
  fs.renameSync(`${file}.next`, file);
  // Files go only once the index no longer names them.
  for (const entry of removed) for (const source of Object.values(entry.files)) if (source) fs.rmSync(path.join(DB, source), { force: true });
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; });
