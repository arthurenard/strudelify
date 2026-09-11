/**
 * Build the song database from raw datasets:
 *   public/db/index.json           searchable index (one row per song)
 *   public/db/songs/<id>.mid|.txt  source files, parsed on demand by core
 *
 * McGill Billboard rows and Clean MIDI files describing the same song are merged
 * into a single entry that carries both files.
 */
import fs from 'node:fs';
import { transcriptionScore } from './quality.js';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { songFromMidi, parseMcgill, normaliseText, type IndexEntry } from '@strudelify/core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RAW = path.resolve(HERE, '..', 'raw');
const OUT = path.resolve(HERE, '..', 'public', 'db');
const SONGS = path.join(OUT, 'songs');

function slug(s: string): string {
  return normaliseText(s).replace(/ /g, '-').slice(0, 60) || 'untitled';
}
function matchKey(title: string, artist: string): string {
  const t = normaliseText(title).replace(/^the /, '');
  const a = normaliseText(artist.split(/,|&| and | feat/i)[0]).replace(/^the /, '');
  return `${t}::${a}`;
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = splitCsv(lines[0]);
  return lines.slice(1).map((l) => Object.fromEntries(splitCsv(l).map((v, i) => [header[i], v])));
}
function splitCsv(line: string): string[] {
  const out: string[] = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

interface Draft { title: string; artist: string; year?: number; mcgill?: string; midi?: string; midiScore: number; bpm?: number; key?: string; variants: number }

function main() {
  // Fail before touching a working database if the downloaded source trees are absent/empty.
  const midiRootCheck = path.join(RAW, 'clean_midi');
  if (!fs.existsSync(midiRootCheck) || !fs.readdirSync(midiRootCheck).some(a => {
    const p = path.join(midiRootCheck, a);
    return fs.statSync(p).isDirectory() && fs.readdirSync(p).some(f => /\.mid$/i.test(f));
  })) throw new Error('MIDI source files are missing. Run the downloader before rebuilding.');
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(SONGS, { recursive: true });
  const drafts = new Map<string, Draft>();

  // McGill
  const index = parseCsv(fs.readFileSync(path.join(RAW, 'billboard-2.0-index.csv'), 'utf8'));
  let mcgillCount = 0;
  for (const row of index) {
    const id = String(row.id).padStart(4, '0');
    const file = path.join(RAW, 'McGill-Billboard', id, 'salami_chords.txt');
    if (!fs.existsSync(file) || !row.title) continue;
    const key = matchKey(row.title, row.artist);
    if (drafts.has(key)) continue; // duplicate annotation of the same song
    const song = parseMcgill(fs.readFileSync(file, 'utf8'), id);
    drafts.set(key, {
      title: row.title, artist: row.artist, year: row.chart_date ? Number(row.chart_date.slice(0, 4)) : undefined,
      mcgill: file, midiScore: -1, variants: 0, bpm: song.meta.bpm, key: song.meta.tonic ? `${song.meta.tonic} ${song.meta.mode ?? ''}`.trim() : undefined,
    });
    mcgillCount++;
  }
  console.log(`mcgill: ${mcgillCount} songs`);

  // Clean MIDI: pick the best variant per (artist, title).
  const midiRoot = path.join(RAW, 'clean_midi');
  let midiCount = 0, midiFail = 0;
  const artists = fs.readdirSync(midiRoot).filter((a) => fs.statSync(path.join(midiRoot, a)).isDirectory());
  for (const artist of artists) {
    for (const f of fs.readdirSync(path.join(midiRoot, artist))) {
      if (!f.toLowerCase().endsWith('.mid')) continue;
      const title = f.replace(/\.mid$/i, '').replace(/\.\d+$/, '');
      const file = path.join(midiRoot, artist, f);
      let score = 0; let bpm: number | undefined; let key: string | undefined;
      try {
        const song = songFromMidi(new Uint8Array(fs.readFileSync(file)), { id: 'tmp', title, artist });
        const notes = song.tracks.reduce((a, t) => a + t.notes.length, 0);
        if (notes < 50) throw new Error('too few notes');
        score = transcriptionScore(song);
        bpm = song.meta.bpm;
        key = song.meta.tonic ? `${song.meta.tonic} ${song.meta.mode ?? ''}`.trim() : undefined;
      } catch { midiFail++; continue; }
      const k = matchKey(title, artist);
      const d = drafts.get(k);
      if (d) {
        d.variants++;
        if (score > d.midiScore) { d.midi = file; d.midiScore = score; d.bpm = bpm; d.key = key ?? d.key; }
      } else {
        drafts.set(k, { title, artist, midi: file, midiScore: score, bpm, key, variants: 1 });
      }
      midiCount++;
    }
  }
  console.log(`midi: ${midiCount} files parsed, ${midiFail} unreadable`);

  const curatedRoot = path.resolve(HERE, '..', 'curated');
  const curated: { entries: { id: string; file: string; sha256: string; drumKit?: 'acoustic'; vocalChannels?: number[]; beatScale?: number }[] } = JSON.parse(fs.readFileSync(path.join(curatedRoot, 'manifest.json'), 'utf8'));
  const entries: IndexEntry[] = [];
  const usedIds = new Set<string>();
  for (const d of drafts.values()) {
    let id = `${slug(d.artist)}--${slug(d.title)}`;
    let n = 2;
    while (usedIds.has(id)) id = `${slug(d.artist)}--${slug(d.title)}-${n++}`;
    usedIds.add(id);
    const pinned = curated.entries.find(e => e.id === id);
    if (pinned) {
      const file = path.join(curatedRoot, pinned.file), bytes = fs.readFileSync(file);
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== pinned.sha256) throw new Error(`Curated source checksum mismatch: ${id}`);
      const song = songFromMidi(bytes, { id, title: d.title, artist: d.artist }, { sourceTiming: true });
      d.midi = file; d.bpm = song.meta.bpm * (pinned.beatScale ?? 1); d.key = `${song.meta.tonic ?? ''} ${song.meta.mode ?? ''}`.trim();
    }
    const files: IndexEntry['files'] = {};
    if (d.midi) { files.midi = `songs/${id}.mid`; fs.copyFileSync(d.midi, path.join(SONGS, `${id}.mid`)); }
    if (d.mcgill) { files.mcgill = `songs/${id}.txt`; fs.copyFileSync(d.mcgill, path.join(SONGS, `${id}.txt`)); }
    const sources: IndexEntry['sources'] = [];
    if (d.mcgill) sources.push('mcgill');
    if (d.midi) sources.push('midi');
    entries.push({ id, ...(pinned?.drumKit ? { drumKit: pinned.drumKit } : {}), ...(pinned?.vocalChannels ? { vocalChannels: pinned.vocalChannels } : {}), ...(pinned?.beatScale ? { beatScale: pinned.beatScale } : {}), title: d.title, artist: d.artist, year: d.year, sources, bpm: d.bpm, key: d.key, popularity: d.variants + (d.mcgill ? 4 : 0), files });
  }
  entries.sort((a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title));
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(entries));
  const both = entries.filter((e) => e.sources.length === 2).length;
  console.log(`index: ${entries.length} songs (${both} with both sources) -> ${OUT}`);
}
main();
