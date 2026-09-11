/**
 * Download the open datasets into packages/data/raw.
 *   - McGill Billboard index + SALAMI chord annotations (Dropbox mirrors used by mirdata)
 *   - Lakh MIDI "Clean MIDI subset" (Columbia mirror)
 * Usage: node dist/download.js [--skip-midi]
 */
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RAW = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'raw');
const FILES = [
  { name: 'billboard-2.0-index.csv', url: 'https://www.dropbox.com/s/o0olz0uwl9z9stb/billboard-2.0-index.csv?dl=1' },
  { name: 'billboard-2.0-salami_chords.tar.gz', url: 'https://www.dropbox.com/s/2lvny9ves8kns4o/billboard-2.0-salami_chords.tar.gz?dl=1', extract: true },
  { name: 'clean_midi.tar.gz', url: 'http://hog.ee.columbia.edu/craffel/lmd/clean_midi.tar.gz', extract: true, midi: true },
];

async function download(url: string, dest: string) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(dest));
}

async function main() {
  const skipMidi = process.argv.includes('--skip-midi');
  fs.mkdirSync(RAW, { recursive: true });
  for (const f of FILES) {
    if (f.midi && skipMidi) continue;
    const dest = path.join(RAW, f.name);
    if (fs.existsSync(dest)) { console.log(`skip ${f.name} (exists)`); }
    else { console.log(`download ${f.name}`); await download(f.url, dest); }
    if (f.extract) {
      console.log(`extract ${f.name}`);
      execFileSync('tar', ['xzf', dest, '-C', RAW], { stdio: 'inherit' });
    }
  }
  console.log('done');
}
main().catch((e) => { console.error(e); process.exit(1); });
