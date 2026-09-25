/**
 * Compile a share of the catalogue for the song pages (see the prerender plugin in vite.config.ts): each song's
 * code as the app first shows it, the Full arrangement of the whole song without its lead (unless the lead is all
 * the song has), with the app's options (song.ts).
 */
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadSong, compile, hasBacking } from '@strudelify/core';

const { db, entries } = workerData;
const codes = [];
for (const entry of entries) {
  try {
    const song = await loadSong(entry, (file) => fs.readFile(path.join(db, file)));
    codes.push([entry.id, compile(song, { form: 'song', timing: 'patterns', melody: !hasBacking(song), maxTracks: Number.MAX_SAFE_INTEGER, maxBars: 1_000_000 })]);
  } catch {
    codes.push([entry.id, null]); // the page is still written, without code; the app reports the error when it opens
  }
}
parentPort.postMessage(codes);
