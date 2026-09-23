/**
 * Build the song database from raw datasets:
 *   public/db/index.json           searchable index (one row per song)
 *   public/db/songs/<id>.mid|.txt  source files, parsed on demand by core
 *
 * McGill Billboard rows and Clean MIDI files describing the same song are merged
 * into a single entry that carries both files. Every input is checked before any work starts, the
 * new database is written next to the old one, and the two are swapped only once it is complete:
 * a failed build leaves the working database untouched. Song ids come from `catalogue-ids.tsv`
 * (see ids.ts), so a rebuild keeps every shared link; new songs are added to that file.
 */
import fs from 'node:fs';
import { transcriptionScore, validTranscription } from './quality.js';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { songFromMidi, parseMcgill, CHART_BONUS, type IndexEntry } from '@strudelify/core';
import { words, readIds, writeIds, assignIds, idKey } from './ids.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RAW = path.resolve(HERE, '..', 'raw');
const OUT = path.resolve(HERE, '..', 'public', 'db');
const IDS = path.resolve(HERE, '..', 'catalogue-ids.tsv');
const CURATED = path.resolve(HERE, '..', 'curated');

/** Which song a source describes: title and first-named artist, folded (see `words`), without a leading "the". */
function matchKey(title: string, artist: string): string {
  const t = words(title).join(' ').replace(/^the /, '');
  const a = words(artist.split(/,|&| and | feat/i)[0]).join(' ').replace(/^the /, '');
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

/** Directory entries in a fixed order, so the same inputs always give the same catalogue. */
const listDir = (dir: string) => fs.readdirSync(dir).sort();

/** The key the song page shows (see `loadSong`): the annotated tonic and mode where McGill has them, else the MIDI file's. */
interface KeyParts { tonic?: string; mode?: 'major' | 'minor' }
interface Draft { title: string; artist: string; year?: number; mcgill?: string; midi?: string; midiScore: number; bpm?: number; mcgillKey: KeyParts; midiKey: KeyParts; variants: number }
const keyName = (d: Draft): string | undefined => {
  const tonic = d.mcgillKey.tonic ?? d.midiKey.tonic, mode = d.mcgillKey.mode ?? d.midiKey.mode;
  return tonic ? `${tonic} ${mode ?? ''}`.trim() : undefined;
};
interface CuratedEntry { id: string; file: string; sha256: string; sourceNote?: string; drumKit?: 'acoustic'; vocalChannels?: number[]; beatScale?: number }

/** Every input the build reads, checked before anything is written. */
function checkInputs(): { rows: Record<string, string>[]; midiRoot: string; curated: CuratedEntry[] } {
  const missing = (what: string) => new Error(`${what} is missing. Run \`node packages/data/dist/download.js\` before rebuilding; the working database was not touched.`);
  const midiRoot = path.join(RAW, 'clean_midi');
  if (!fs.existsSync(midiRoot) || !listDir(midiRoot).some((a) => {
    const p = path.join(midiRoot, a);
    return fs.statSync(p).isDirectory() && fs.readdirSync(p).some((f) => /\.mid$/i.test(f));
  })) throw missing('The Lakh MIDI clean subset (raw/clean_midi)');
  const csv = path.join(RAW, 'billboard-2.0-index.csv');
  if (!fs.existsSync(csv)) throw missing('The McGill Billboard index (raw/billboard-2.0-index.csv)');
  const rows = parseCsv(fs.readFileSync(csv, 'utf8'));
  if (!rows.length || !['id', 'title', 'artist', 'chart_date'].every((k) => k in rows[0])) throw new Error(`${csv} is not the McGill Billboard index (an interrupted download?). Delete it and download again.`);
  if (!rows.some((r) => r.title && fs.existsSync(path.join(RAW, 'McGill-Billboard', String(r.id).padStart(4, '0'), 'salami_chords.txt')))) throw missing('The McGill Billboard annotations (raw/McGill-Billboard)');
  const curated: CuratedEntry[] = JSON.parse(fs.readFileSync(path.join(CURATED, 'manifest.json'), 'utf8')).entries;
  for (const pin of curated) {
    const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(CURATED, pin.file))).digest('hex');
    if (digest !== pin.sha256) throw new Error(`Curated source checksum mismatch: ${pin.id} (${pin.file})`);
  }
  return { rows, midiRoot, curated };
}

function main() {
  const { rows, midiRoot, curated } = checkInputs();
  const drafts = new Map<string, Draft>();

  // McGill
  let mcgillCount = 0;
  for (const row of rows) {
    const id = String(row.id).padStart(4, '0');
    const file = path.join(RAW, 'McGill-Billboard', id, 'salami_chords.txt');
    if (!fs.existsSync(file) || !row.title) continue;
    const key = matchKey(row.title, row.artist);
    if (drafts.has(key)) continue; // duplicate annotation of the same song
    const song = parseMcgill(fs.readFileSync(file, 'utf8'), id);
    drafts.set(key, {
      title: row.title, artist: row.artist, year: row.chart_date ? Number(row.chart_date.slice(0, 4)) : undefined,
      mcgill: file, midiScore: -1, variants: 0, bpm: song.meta.bpm, mcgillKey: { tonic: song.meta.tonic, mode: song.meta.mode }, midiKey: {},
    });
    mcgillCount++;
  }
  console.log(`mcgill: ${mcgillCount} songs`);

  // Clean MIDI: pick the best variant per (artist, title).
  let midiCount = 0, midiFail = 0;
  for (const artist of listDir(midiRoot).filter((a) => fs.statSync(path.join(midiRoot, a)).isDirectory())) {
    for (const f of listDir(path.join(midiRoot, artist))) {
      if (!f.toLowerCase().endsWith('.mid')) continue;
      const title = f.replace(/\.mid$/i, '').replace(/\.\d+$/, '');
      const file = path.join(midiRoot, artist, f);
      let score = 0; let bpm: number | undefined; let key: KeyParts = {};
      try {
        const song = songFromMidi(new Uint8Array(fs.readFileSync(file)), { id: 'tmp', title, artist });
        const notes = song.tracks.reduce((a, t) => a + t.notes.length, 0);
        if (notes < 50) throw new Error('too few notes');
        score = transcriptionScore(song);
        if (score < 0) throw new Error('invalid transcription');
        bpm = song.meta.bpm;
        key = { tonic: song.meta.tonic, mode: song.meta.mode };
      } catch { midiFail++; continue; }
      const k = matchKey(title, artist);
      const d = drafts.get(k);
      if (d) {
        d.variants++;
        if (score > d.midiScore) { d.midi = file; d.midiScore = score; d.bpm = bpm; d.midiKey = key; }
      } else {
        drafts.set(k, { title, artist, midi: file, midiScore: score, bpm, mcgillKey: {}, midiKey: key, variants: 1 });
      }
      midiCount++;
    }
  }
  console.log(`midi: ${midiCount} files parsed, ${midiFail} unreadable`);

  const known = readIds(IDS);
  const ids = assignIds([...drafts.values()], known);
  // Written beside the working database and swapped in at the end.
  const next = `${OUT}.next`, previous = `${OUT}.previous`;
  fs.rmSync(next, { recursive: true, force: true });
  fs.mkdirSync(path.join(next, 'songs'), { recursive: true });
  try {
    const entries: IndexEntry[] = [];
    const applied = new Set<string>();
    for (const d of drafts.values()) {
      const id = ids.get(d)!;
      const pinned = curated.find((e) => e.id === id);
      if (pinned) {
        const file = path.join(CURATED, pinned.file);
        const song = songFromMidi(fs.readFileSync(file), { id, title: d.title, artist: d.artist }, { sourceTiming: true });
        if (!validTranscription(song)) throw new Error(`Invalid curated transcription: ${id}`);
        d.midi = file; d.bpm = song.meta.bpm * (pinned.beatScale ?? 1); d.midiKey = { tonic: song.meta.tonic, mode: song.meta.mode };
        applied.add(id);
      }
      const files: IndexEntry['files'] = {};
      if (d.midi) { files.midi = `songs/${id}.mid`; fs.copyFileSync(d.midi, path.join(next, files.midi)); }
      if (d.mcgill) { files.mcgill = `songs/${id}.txt`; fs.copyFileSync(d.mcgill, path.join(next, files.mcgill)); }
      const sources: IndexEntry['sources'] = [];
      if (d.mcgill) sources.push('mcgill');
      if (d.midi) sources.push('midi');
      entries.push({ id, ...(pinned?.sourceNote ? { sourceNote: pinned.sourceNote } : {}), ...(pinned?.drumKit ? { drumKit: pinned.drumKit } : {}), ...(pinned?.vocalChannels ? { vocalChannels: pinned.vocalChannels } : {}), ...(pinned?.beatScale ? { beatScale: pinned.beatScale } : {}), title: d.title, artist: d.artist, year: d.year, sources, bpm: d.bpm, key: keyName(d), popularity: d.variants + (d.mcgill ? CHART_BONUS : 0), files });
    }
    // A reviewed replacement whose song the build no longer finds would silently revert to automatic selection.
    const unused = curated.filter((e) => !applied.has(e.id)).map((e) => e.id);
    if (unused.length) throw new Error(`Curated sources match no song of this build: ${unused.join(', ')}. Fix their ids in curated/manifest.json.`);
    entries.sort((a, b) => a.artist.localeCompare(b.artist, 'en') || a.title.localeCompare(b.title, 'en'));
    fs.writeFileSync(path.join(next, 'index.json'), JSON.stringify(entries));

    fs.rmSync(previous, { recursive: true, force: true });
    if (fs.existsSync(OUT)) fs.renameSync(OUT, previous);
    fs.renameSync(next, OUT);
    fs.rmSync(previous, { recursive: true, force: true });

    const recorded = new Map(known);
    for (const d of drafts.values()) recorded.set(idKey(d.artist, d.title), ids.get(d)!);
    const added = recorded.size - known.size;
    const built = new Set(entries.map((e) => e.id));
    const retired = [...known.values()].filter((id) => !built.has(id)).length;
    if (added) writeIds(IDS, recorded);
    const both = entries.filter((e) => e.sources.length === 2).length;
    console.log(`index: ${entries.length} songs (${both} with both sources) -> ${OUT}`);
    if (added) console.log(`${added} new song ids recorded in ${path.relative(process.cwd(), IDS)}: commit it so their links stay the same in later builds.`);
    if (retired) console.log(`${retired} recorded ids have no song in this build; their links now show "song not found".`);
    console.log('PDMX score arrangements are not part of the base build: run `npm run data:expand` to add them again.');
  } catch (e) {
    fs.rmSync(next, { recursive: true, force: true });
    throw e;
  }
}
main();
