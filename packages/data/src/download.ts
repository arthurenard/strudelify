/**
 * Download the open datasets into packages/data/raw.
 *   - McGill Billboard index + SALAMI chord annotations (Dropbox mirrors used by mirdata)
 *   - Lakh MIDI "Clean MIDI subset" (Columbia mirror, served over plain HTTP only)
 * Usage: node dist/download.js [--skip-midi]
 *
 * Every file is fetched to `<name>.part` and renamed only once it has the pinned size (and the
 * pinned SHA-256 where one is known) and, for an archive, its gzip checksum verifies: an
 * interrupted download or an HTML error page served with status 200 is never taken for the data.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform, Writable } from 'node:stream';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RAW = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'raw');

export interface Source {
  name: string;
  url: string;
  /** Exact size in bytes. */
  bytes: number;
  sha256?: string;
  /** The directory the archive unpacks to (a `.tar.gz` is unpacked into raw/). */
  extractsTo?: string;
  midi?: boolean;
}

const FILES: Source[] = [
  { name: 'billboard-2.0-index.csv', url: 'https://www.dropbox.com/s/o0olz0uwl9z9stb/billboard-2.0-index.csv?dl=1', bytes: 61_542, sha256: 'fc39435098814f1a4f1dd5c95c72aff399b648b78f33a59682924dfb9b5280fb' },
  { name: 'billboard-2.0-salami_chords.tar.gz', url: 'https://www.dropbox.com/s/2lvny9ves8kns4o/billboard-2.0-salami_chords.tar.gz?dl=1', bytes: 340_263, extractsTo: 'McGill-Billboard' },
  // The mirror has no HTTPS; the pinned size and the gzip checksum catch a truncated or damaged download.
  { name: 'clean_midi.tar.gz', url: 'http://hog.ee.columbia.edu/craffel/lmd/clean_midi.tar.gz', bytes: 234_283_029, extractsTo: 'clean_midi', midi: true },
];

/** Give up on a download that receives nothing for this long. */
export const STALL_MS = 60_000;

async function sha256(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Why `file` is not the pinned source, or null when it is. */
export async function problem(file: string, f: Source): Promise<string | null> {
  const size = fs.statSync(file).size;
  if (size !== f.bytes) return `${size} bytes instead of ${f.bytes}`;
  if (f.sha256 && (await sha256(file)) !== f.sha256) return 'SHA-256 mismatch';
  if (f.extractsTo) {
    // Decompressing checks the gzip CRC and length: a damaged or cut archive fails here, before tar sees it.
    const discard = new Writable({ write(_chunk, _enc, done) { done(); } });
    try { await pipeline(fs.createReadStream(file), zlib.createGunzip(), discard); } catch { return 'damaged gzip archive'; }
  }
  return null;
}

/** Fetch `f` to `dest` through `<dest>.part`, keeping it only when it verifies (see `problem`). */
export async function download(f: Source, dest: string, stallMs = STALL_MS) {
  const part = `${dest}.part`;
  const abort = new AbortController();
  let timer = setTimeout(() => abort.abort(), stallMs);
  const watchdog = new Transform({
    transform(chunk, _enc, done) { clearTimeout(timer); timer = setTimeout(() => abort.abort(), stallMs); done(null, chunk); },
  });
  try {
    const res = await fetch(f.url, { redirect: 'follow', signal: abort.signal });
    if (!res.ok || !res.body) throw new Error(`${f.url}: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body as never), watchdog, fs.createWriteStream(part));
  } catch (e) {
    fs.rmSync(part, { force: true });
    throw abort.signal.aborted ? new Error(`${f.url}: no data for ${stallMs / 1000} s, giving up`) : e;
  } finally {
    clearTimeout(timer);
  }
  const wrong = await problem(part, f);
  if (wrong) { fs.rmSync(part, { force: true }); throw new Error(`${f.name}: ${wrong}. The source may have changed; nothing was kept.`); }
  fs.renameSync(part, dest);
}

async function main() {
  const skipMidi = process.argv.includes('--skip-midi');
  fs.mkdirSync(RAW, { recursive: true });
  for (const f of FILES) {
    if (f.midi && skipMidi) continue;
    const dest = path.join(RAW, f.name);
    const wrong = fs.existsSync(dest) ? await problem(dest, f) : 'missing';
    if (!wrong) console.log(`skip ${f.name} (verified)`);
    else {
      if (wrong !== 'missing') { console.log(`replace ${f.name} (${wrong})`); fs.rmSync(dest); }
      console.log(`download ${f.name}`);
      await download(f, dest);
    }
    if (f.extractsTo) {
      // A link to a directory that no longer exists (a moved or cleaned-up data folder) would receive the files.
      const target = path.join(RAW, f.extractsTo);
      if (fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink() && !fs.existsSync(target)) {
        console.log(`remove ${f.extractsTo} (a link to ${fs.readlinkSync(target)}, which no longer exists)`);
        fs.unlinkSync(target);
      }
      console.log(`extract ${f.name}`);
      execFileSync('tar', ['xzf', dest, '-C', RAW], { stdio: 'inherit' });
    }
  }
  console.log('done');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
