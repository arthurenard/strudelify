/** Incremental, reproducible PDMX import through Zenodo's public record API. */
import fs from 'node:fs';
import { validTranscription } from './quality.js';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { songFromMidi, compile, timeline, normaliseText, type IndexEntry } from '@strudelify/core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'raw/pdmx');
const DB = path.resolve(process.argv.find(x => x.startsWith('--db='))?.slice(5) ?? path.join(ROOT, 'public/db'));
const RECORD = 'https://zenodo.org/api/records/15571083';
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
  const stage = fs.mkdtempSync(path.join(RAW, 'import-'));
  execFileSync('python3', [path.join(ROOT, 'scripts/select_pdmx.py'), path.join(RAW, 'PDMX.csv'), path.join(RAW, 'mid.tar.gz'), stage, String(limit)], { stdio: 'inherit' });
  const candidates: { file: string; title: string; artist: string; rating: number; ratings: number; license: string; scoreId: string }[] = JSON.parse(fs.readFileSync(path.join(stage, 'manifest.json'), 'utf8'));
  const entries: IndexEntry[] = JSON.parse(fs.readFileSync(path.join(DB, 'index.json'), 'utf8'));
  // Search popularity counts independent transcriptions, not score-review votes.
  for (const entry of entries) if (entry.provenance?.provider === 'pdmx') entry.popularity = 1;
  const ids = new Set(entries.map(e => e.id));
  const identity = (e: { artist: string; title: string }) => `${normaliseText(e.artist)}::${normaliseText(e.title)}`;
  const identities = new Set(entries.map(identity));
  const additions: { entry: IndexEntry; data: Buffer }[] = [];
  const { validatePattern } = await import(new URL('../../../tools/strudel-runtime.mjs', import.meta.url).href);
  const rejected: { title: string; reason: string }[] = [];
  for (const item of candidates) {
    const id = `pdmx--${item.scoreId}`;
    if (ids.has(id) || identities.has(identity(item))) continue;
    try {
      const data = fs.readFileSync(path.join(stage, item.file));
      const song = songFromMidi(data, { id, title: item.title, artist: item.artist });
      const instrumental = song.tracks.filter(t => !t.vocal && t.role !== 'drums');
      if (!instrumental.length || instrumental.reduce((n, t) => n + t.notes.length, 0) < 32) throw Error('Insufficient instrumental notes');
      if (!validTranscription(song)) throw new Error('Invalid decoded MIDI events');
      const code = compile(song, { timing: 'patterns', form: 'loop' });
      if (/\b(?:NaN|Infinity|undefined)\b/.test(code.split('\n').filter(l => !l.startsWith('//')).join('\n'))) throw Error('Non-finite output');
      if (code.length > 12000) throw Error('Main-loop code exceeds readability limit');
      validatePattern(code, timeline(song, { form: 'loop', timing: 'patterns' }).bars);
      const entry: IndexEntry = { id, title: item.title, artist: item.artist, sources: ['midi'], bpm: song.meta.bpm,
        key: song.meta.tonic ? `${song.meta.tonic} ${song.meta.mode ?? ''}`.trim() : undefined,
        popularity: 1, files: { midi: `songs/${id}.mid` },
        provenance: { provider: 'pdmx', url: `https://musescore.com/score/${item.scoreId}`, license: item.license, rating: item.rating, ratings: item.ratings } };
      additions.push({ entry, data }); ids.add(id); identities.add(identity(item));
    } catch (e) { rejected.push({ title: item.title, reason: (e as Error).message }); }
  }
  const report = { provider: 'PDMX', record: RECORD, candidates: candidates.length, added: additions.length, rejected, before: entries.length, after: entries.length + additions.length, dryRun: process.argv.includes('--dry-run') };
  fs.writeFileSync(path.join(RAW, 'import-report.json'), JSON.stringify(report, null, 2));
  if (!report.dryRun) {
    for (const { entry, data } of additions) {
      const dest = path.join(DB, entry.files.midi!);
      if (fs.existsSync(dest)) { if (!fs.readFileSync(dest).equals(data)) throw Error(`Conflicting existing source: ${entry.id}`); }
      else fs.writeFileSync(dest, data, { flag: 'wx' });
    }
    const next = [...entries, ...additions.map(a => a.entry)].sort((a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title));
    fs.writeFileSync(path.join(DB, 'index.json.next'), JSON.stringify(next));
    fs.renameSync(path.join(DB, 'index.json.next'), path.join(DB, 'index.json'));
  }
  console.log(JSON.stringify({ ...report, rejected: rejected.length }, null, 2));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
