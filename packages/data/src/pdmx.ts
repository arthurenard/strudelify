/** Incremental, reproducible PDMX import through Zenodo's public record API. */
import fs from 'node:fs';
import { validTranscription } from './quality.js';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { songFromMidi, compile, timeline, type IndexEntry } from '@strudelify/core';
import { cleanArtist, cleanTitle } from './metadata.js';
import { words, readIds, writeIds, assignIds, scoreKey } from './ids.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'raw/pdmx');
const DB = path.resolve(process.argv.find(x => x.startsWith('--db='))?.slice(5) ?? path.join(ROOT, 'public/db'));
const RECORD = 'https://zenodo.org/api/records/15571083';
/** Every song's id, with the artist and title it names: scores are named like the rest of the catalogue (see ids.ts). */
const IDS = path.join(ROOT, 'catalogue-ids.tsv');
const SOURCES: Record<string, string> = { 'PDMX.csv': '30392ccf38bb63ce70e7afae70f9c88c', 'mid.tar.gz': 'd920a21b2fcd99a56d9c381b39debbb2' };
async function md5(file: string) {
  const hash = crypto.createHash('md5'); for await (const chunk of fs.createReadStream(file)) hash.update(chunk); return hash.digest('hex');
}
async function main() {
  const limit = Number(process.argv.find(x => x.startsWith('--limit='))?.split('=')[1] ?? 5000);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw Error('--limit must be between 1 and 10000');
  if (!fs.existsSync(path.join(DB, 'index.json'))) throw Error('Build the base database first; this command preserves and extends it.');
  fs.mkdirSync(RAW, { recursive: true });
  let record: { files: { key: string; checksum: string; links: { self: string } }[] } | undefined;
  for (const [name, checksum] of Object.entries(SOURCES)) {
    const file = path.join(RAW, name);
    if (fs.existsSync(file) && await md5(file) === checksum) continue;
    if (!record) {
      record = JSON.parse(execFileSync('curl', ['--fail', '--silent', '--show-error', '--location', '--retry', '2', RECORD], { encoding: 'utf8', maxBuffer: 2_000_000 })) as NonNullable<typeof record>;
    }
    const remote = record.files.find(f => f.key === name && f.checksum === `md5:${checksum}`);
    if (!remote || new URL(remote.links.self).hostname !== 'zenodo.org') throw Error(`Upstream file identity changed: ${name}`);
    console.log(`Downloading ${name}`);
    execFileSync('curl', ['--fail', '--silent', '--show-error', '--location', '--retry', '2', remote.links.self, '-o', file + '.part'], { stdio: 'inherit' });
    if (await md5(file + '.part') !== checksum) throw Error(`Checksum mismatch: ${name}`);
    fs.renameSync(file + '.part', file);
  }
  // Candidates are extracted to a staging directory that is removed once the import is over, whatever its outcome.
  const stage = fs.mkdtempSync(path.join(RAW, 'import-'));
  try {
    await importFrom(stage, limit);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

async function importFrom(stage: string, limit: number) {
  execFileSync('python3', [path.join(ROOT, 'scripts/select_pdmx.py'), path.join(RAW, 'PDMX.csv'), path.join(RAW, 'mid.tar.gz'), stage, String(limit)], { stdio: 'inherit' });
  const candidates: { file: string; title: string; artist: string; rating: number; ratings: number; license: string; scoreId: string }[] = JSON.parse(fs.readFileSync(path.join(stage, 'manifest.json'), 'utf8'));
  const entries: IndexEntry[] = JSON.parse(fs.readFileSync(path.join(DB, 'index.json'), 'utf8'));
  // Search popularity counts independent transcriptions, not score-review votes.
  for (const entry of entries) if (entry.provenance?.provider === 'pdmx') entry.popularity = 1;
  // A score already in the catalogue, whatever it is called now.
  const imported = new Set(entries.map(e => e.provenance?.url).filter(Boolean));
  const identity = (e: { artist: string; title: string }) => `${words(e.artist).join(' ')}::${words(e.title).join(' ')}`;
  const identities = new Set(entries.map(identity));
  const additions: { entry: IndexEntry; data: Buffer }[] = [];
  const { validatePattern } = await import(new URL('../../../tools/strudel-runtime.mjs', import.meta.url).href);
  const rejected: { title: string; reason: string }[] = [];
  for (const found of candidates) {
    // Named once it is admitted, with the others (see below); until then it is known by its score.
    const id = `pdmx--${found.scoreId}`, url = `https://musescore.com/score/${found.scoreId}`;
    // Uploaders' credit blocks and misdecoded text become a name the catalogue can show (see metadata.ts).
    const item = { ...found, title: cleanTitle(found.title), artist: cleanArtist(found.artist) };
    if (!item.title || !item.artist) { rejected.push({ title: found.title, reason: `No usable ${item.title ? 'artist' : 'title'}` }); continue; }
    if (imported.has(url) || identities.has(identity(item))) continue;
    try {
      const data = fs.readFileSync(path.join(stage, item.file));
      const song = songFromMidi(data, { id, title: item.title, artist: item.artist });
      const instrumental = song.tracks.filter(t => !t.vocal && t.role !== 'drums');
      if (!instrumental.length || instrumental.reduce((n, t) => n + t.notes.length, 0) < 32) throw Error('Insufficient instrumental notes');
      if (!validTranscription(song)) throw new Error('Invalid decoded MIDI events');
      const code = compile(song, { timing: 'patterns', form: 'loop' });
      if (/\b(?:NaN|Infinity|undefined)\b/.test(code.split('\n').filter(l => !l.startsWith('//')).join('\n'))) throw Error('Non-finite output');
      if (code.length > 20000) throw Error('Main-loop code exceeds readability limit');
      validatePattern(code, timeline(song, { form: 'loop', timing: 'patterns' }).bars);
      const entry: IndexEntry = { id, title: item.title, artist: item.artist, sources: ['midi'], bpm: song.meta.bpm,
        key: song.meta.tonic ? `${song.meta.tonic} ${song.meta.mode ?? ''}`.trim() : undefined,
        popularity: 1, files: { midi: `songs/${id}.mid` },
        provenance: { provider: 'pdmx', url, license: item.license, rating: item.rating, ratings: item.ratings } };
      additions.push({ entry, data }); imported.add(url); identities.add(identity(item));
    } catch (e) { rejected.push({ title: item.title, reason: (e as Error).message }); }
  }
  // Named `artist--title` like every song (`billie-eilish--bad-guy`), the name recorded in catalogue-ids.tsv so that
  // a rebuild gives the score the same address.
  const known = readIds(IDS);
  const keyOf = (e: IndexEntry) => scoreKey(e.artist, e.title, e.provenance!.url.replace(/^.*\//, ''));
  for (const [entry, id] of assignIds(additions.map(a => a.entry), known, keyOf)) {
    known.set(keyOf(entry), id);
    Object.assign(entry, { id, files: { midi: `songs/${id}.mid` } });
  }
  const report = { provider: 'PDMX', record: RECORD, candidates: candidates.length, added: additions.length, rejected, before: entries.length, after: entries.length + additions.length, dryRun: process.argv.includes('--dry-run') };
  fs.writeFileSync(path.join(RAW, 'import-report.json'), JSON.stringify(report, null, 2));
  if (!report.dryRun) {
    writeIds(IDS, known);
    for (const { entry, data } of additions) {
      const dest = path.join(DB, entry.files.midi!);
      if (fs.existsSync(dest)) { if (!fs.readFileSync(dest).equals(data)) throw Error(`Conflicting existing source: ${entry.id}`); }
      else fs.writeFileSync(dest, data, { flag: 'wx' });
    }
    const next = [...entries, ...additions.map(a => a.entry)].sort((a, b) => a.artist.localeCompare(b.artist, 'en') || a.title.localeCompare(b.title, 'en'));
    fs.writeFileSync(path.join(DB, 'index.json.next'), JSON.stringify(next));
    fs.renameSync(path.join(DB, 'index.json.next'), path.join(DB, 'index.json'));
  }
  console.log(JSON.stringify({ ...report, rejected: rejected.length }, null, 2));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
