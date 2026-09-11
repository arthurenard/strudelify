#!/usr/bin/env node
/** Audit source files and execute generated code through the actual Strudel runtime. */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import os from 'node:os';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadSong, compile, timeline, barRange, normaliseText } from '../packages/core/dist/index.js';
import { evaluatePattern } from './strudel-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = path.join(root, 'packages/data/public/db');
const allEntries = JSON.parse(fs.readFileSync(path.join(db, 'index.json'), 'utf8'));
const workerCount = Number(process.argv.find(arg => arg.startsWith('--workers='))?.split('=')[1] ?? 1);
if (!Number.isInteger(workerCount) || workerCount < 1 || workerCount > 8) throw new Error('--workers must be between 1 and 8');
if (workerCount > 1) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'strudelify-audit-'));
  const codes = await Promise.all(Array.from({ length: workerCount }, (_, shard) => new Promise(resolve => {
    const child = fork(fileURLToPath(import.meta.url), [`--shard=${shard}/${workerCount}`, `--output=${path.join(temp, `${shard}.json`)}`], { stdio: 'inherit' });
    child.on('error', error => { console.error(error); resolve(1); });
    child.on('exit', code => resolve(code ?? 1));
  })));
  const combined = { entries: 0, midi: 0, chordsOnly: 0, both: 0, checked: 0, patterns: 0, failures: [], truncated: [], empty: [], unavailableInstrumentals: [], duplicateGroups: [], remarks: {}, orphans: [] };
  for (let shard = 0; shard < workerCount; shard++) {
    const report = JSON.parse(fs.readFileSync(path.join(temp, `${shard}.json`), 'utf8'));
    for (const key of ['entries', 'midi', 'chordsOnly', 'both', 'checked', 'patterns']) combined[key] += report[key];
    for (const key of ['failures', 'truncated', 'empty', 'unavailableInstrumentals']) combined[key].push(...report[key]);
    for (const [remark, count] of Object.entries(report.remarks)) combined.remarks[remark] = (combined.remarks[remark] ?? 0) + count;
    combined.orphans = report.orphans;
  }
  const groups = new Map();
  for (const e of allEntries) {
    const key = `${normaliseText(e.artist)}::${normaliseText(e.title)}`;
    groups.set(key, [...(groups.get(key) ?? []), e.id]);
  }
  combined.duplicateGroups = [...groups.values()].filter(group => group.length > 1);
  if (new Set(allEntries.map(e => e.id)).size !== allEntries.length) combined.failures.push({ error: 'Duplicate catalogue IDs' });
  fs.writeFileSync(path.join(root, 'tools/library-report.json'), JSON.stringify(combined, null, 2) + '\n');
  console.log(JSON.stringify({ ...combined, remarks: undefined, truncated: combined.truncated.length, duplicateGroups: combined.duplicateGroups.length }, null, 2));
  process.exit(codes.some(code => code !== 0) || combined.failures.length ? 1 : 0);
}
const [shard, shards] = (process.argv.find(arg => arg.startsWith('--shard='))?.split('=')[1] ?? '0/1').split('/').map(Number);
const onlyIds = process.argv.find(arg => arg.startsWith('--ids='))?.slice('--ids='.length).split(',');
const entries = allEntries.filter((entry, i) => i % shards === shard && (!onlyIds || onlyIds.includes(entry.id)));
const report = { entries: entries.length, midi: 0, chordsOnly: 0, both: 0, checked: 0, patterns: 0,
  failures: [], truncated: [], empty: [], unavailableInstrumentals: [], duplicateGroups: [], remarks: {} };
const ids = new Set(), files = new Set(), identities = new Map();
for (const entry of entries) {
  try {
    if (ids.has(entry.id)) throw new Error('Duplicate ID');
    ids.add(entry.id);
    for (const file of Object.values(entry.files)) {
      if (!fs.statSync(path.join(db, file)).size) throw new Error(`Empty source: ${file}`);
      files.add(file);
    }
    const key = `${normaliseText(entry.artist)}::${normaliseText(entry.title)}`;
    identities.set(key, [...(identities.get(key) ?? []), entry.id]);
    if (entry.files.midi) report.midi++; else report.chordsOnly++;
    if (entry.files.midi && entry.files.mcgill) report.both++;
    const song = await loadSong(entry, async (file) => fs.readFileSync(path.join(db, file)));
    const code = compile(song);
    new vm.Script(code);
    const tl = timeline(song);
    if (!(tl.bars > 0 && Number.isFinite(tl.bars) && tl.cpm > 0 && Number.isFinite(tl.cpm))) throw new Error('Invalid timeline');
    if (/\b(?:NaN|Infinity|undefined)\b/.test(code.split('\n').filter(l => !l.startsWith('//')).join('\n'))) throw new Error('Non-finite generated code');
    const pattern = evaluatePattern(code);
    report.patterns += [...code.matchAll(/(?:note\(|mini\(|s\(|\[\d+,\s*)(["'])(?:[^"'\\]|\\.)*\1/g)].length;
    const snapshot = (bar) => pattern.queryArc(bar, bar + 1).map(event => {
      for (const key of ['duration', 'gain', 'pan']) if (typeof event.value[key] === 'number' && !Number.isFinite(event.value[key])) throw new Error(`Invalid runtime ${key}`);
      return { value: event.value, start: Number((Number((event.whole?.begin ?? event.part.begin).sub(bar))).toFixed(6)), end: Number((Number((event.whole?.end ?? event.part.end).sub(bar))).toFixed(6)) };
    });
    const first = snapshot(0);
    snapshot(Math.floor(tl.bars / 2));
    snapshot(tl.bars - 1);
    const repeated = snapshot(tl.bars);
    if (JSON.stringify(first) !== JSON.stringify(repeated)) {
      throw new Error('Generated pattern does not repeat at the timeline boundary');
    }
    if (/stack\(\)|^silence$/m.test(code)) {
      if (song.tracks.length && song.tracks.every(t => t.vocal)) report.unavailableInstrumentals.push(entry.id);
      else report.empty.push(entry.id);
    }
    const range = barRange(song);
    if (range && range.nBars < range.totalBars) report.truncated.push({ id: entry.id, ...range });
    for (const remark of song.meta.remarks ?? []) report.remarks[remark] = (report.remarks[remark] ?? 0) + 1;
    report.checked++;
  } catch (error) {
    report.failures.push({ id: entry.id, error: String(error) });
    console.log(`FAIL ${entry.id}: ${String(error).slice(0, 250)}`);
  }
  if ((report.checked + report.failures.length) % 250 === 0) console.log(`worker ${shard + 1}: ${report.checked + report.failures.length}/${entries.length}, ${report.failures.length} failures`);
}
report.duplicateGroups = [...identities.values()].filter(group => group.length > 1);
const allFiles = new Set(allEntries.flatMap(e => Object.values(e.files)));
report.orphans = fs.readdirSync(path.join(db, 'songs')).filter(file => !allFiles.has(`songs/${file}`));
const output = process.argv.find(arg => arg.startsWith('--output='))?.slice('--output='.length) ?? path.join(root, 'tools/library-report.json');
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, failures: report.failures.slice(0,30), failureCount: report.failures.length, duplicateGroups: report.duplicateGroups.length, truncated: report.truncated.length, remarks: undefined }, null, 2));
console.log(`Report: ${output}`);
if (report.failures.length || report.empty.length || report.orphans.length) process.exitCode = 1;
