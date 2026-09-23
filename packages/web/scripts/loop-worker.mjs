/** Compile the Main loop of a share of the catalogue for the song pages (see the prerender plugin in vite.config.ts). */
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadSong, compile } from '@strudelify/core';

const { db, entries } = workerData;
const codes = [];
for (const entry of entries) {
  try {
    const song = await loadSong(entry, (file) => fs.readFile(path.join(db, file)));
    codes.push([entry.id, compile(song, { form: 'loop', timing: 'patterns' })]);
  } catch {
    codes.push([entry.id, null]); // the page is still written, without code; the app reports the error when it opens
  }
}
parentPort.postMessage(codes);
