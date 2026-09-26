/**
 * One entry per song. The catalogue holds some songs twice: two Lakh transcriptions under different spellings
 * (`bon-jovi--livin-on-a-prayer`, `…-living-on-a-prayer`), a chord chart that the builder did not pair with its
 * MIDI, a score of a song Lakh already has. This step keeps the best transcription of each and drops the others:
 *   0. one with notes (MIDI) over a chord chart alone;
 *   1. the one LMD-matched found following a recording most closely (Colin Raffel's match score for the MIDI
 *      file, by its MD5; raw/match_scores.json, see download.ts): a checked match beats an unchecked one;
 *   2. then one with a McGill chord chart, then a Lakh transcription over a score arrangement (it transcribes
 *      the record's own parts), then the builder's structural ranking (quality.ts), then the more transcribed.
 * The song keeps the name and address of its most popular entry, playing the chosen file (see `mergeGroup`).
 * Each other id is recorded in db/moved.json with the id it moved to, so the website sends its address on, and
 * a transcription no song plays any more moves to packages/data/duplicates (the site would otherwise ship it).
 * Usage: node dist/dedupe.js [--db=/absolute/path] [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDuplicateTitle, loadSong, normaliseText, type IndexEntry } from '@strudelify/core';
import { transcriptionScore } from './quality.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = path.resolve(process.argv.find((x) => x.startsWith('--db='))?.slice(5) ?? path.join(ROOT, 'public/db'));
const SCORES = path.join(ROOT, 'raw/match_scores.json');
const DROPPED = path.join(ROOT, 'duplicates');

/** An artist as the catalogue matches it: its words without "the" and "and", in any order ("Jackson Michael" is Michael Jackson). */
export const artistKey = (artist: string) => normaliseText(artist).split(' ').filter((w) => w && w !== 'the' && w !== 'and').sort().join(' ');

/** Groups of entries that are the same song: the same artist and a duplicate title (see core's isDuplicateTitle). */
export function duplicateGroups<E extends Pick<IndexEntry, 'artist' | 'title'>>(entries: readonly E[]): E[][] {
  const byArtist = new Map<string, E[]>();
  for (const e of entries) (byArtist.get(artistKey(e.artist)) ?? byArtist.set(artistKey(e.artist), []).get(artistKey(e.artist))!).push(e);
  const groups: E[][] = [];
  for (const list of byArtist.values()) {
    const taken = new Set<number>();
    for (let i = 0; i < list.length; i++) {
      if (taken.has(i)) continue;
      const group = [list[i]];
      for (let j = i + 1; j < list.length; j++) if (!taken.has(j) && isDuplicateTitle(list[i].title, list[j].title)) { group.push(list[j]); taken.add(j); }
      if (group.length > 1) groups.push(group);
    }
  }
  return groups;
}

/** What decides between two entries of one song, best first (see the module comment). */
export interface Merit { notes: boolean; match?: number; chart: boolean; lakh: boolean; structure: number; popularity: number; id: string }
export function better(a: Merit, b: Merit): number {
  return (Number(b.notes) - Number(a.notes))
    || (Number(b.match !== undefined) - Number(a.match !== undefined)) || ((b.match ?? 0) - (a.match ?? 0))
    || (Number(b.chart) - Number(a.chart)) || (Number(b.lakh) - Number(a.lakh))
    || (b.structure - a.structure) || (b.popularity - a.popularity) || a.id.length - b.id.length || (a.id < b.id ? -1 : 1);
}

/**
 * One song's entry from its entries and the transcription chosen to play: the name and address of its most
 * popular entry (the spelling most transcriptions use; then one with a chord chart, whose names are curated),
 * the chosen file with what belongs to it (tempo, key, reviewed drum kit, score source), the entries'
 * popularity added up (each counts the transcriptions found), a chord chart and a year from whichever has one.
 */
export function mergeGroup(group: readonly IndexEntry[], played: IndexEntry): { named: IndexEntry; kept: IndexEntry } {
  const named = [...group].sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0) || Number(!!b.files.mcgill) - Number(!!a.files.mcgill) || a.id.length - b.id.length || (a.id < b.id ? -1 : 1))[0];
  const chart = named.files.mcgill ?? played.files.mcgill ?? group.find((e) => e.files.mcgill)?.files.mcgill;
  const year = named.year ?? group.find((e) => e.year)?.year;
  const kept: IndexEntry = {
    id: named.id, title: named.title, artist: named.artist, ...(year ? { year } : {}),
    sources: [...new Set([...(played.files.midi ? ['midi' as const] : []), ...(chart ? ['mcgill' as const] : [])])],
    ...(played.bpm !== undefined ? { bpm: played.bpm } : {}), ...(played.key ? { key: played.key } : {}),
    popularity: group.reduce((n, e) => n + (e.popularity ?? 0), 0),
    files: { ...(played.files.midi ? { midi: played.files.midi } : {}), ...(chart ? { mcgill: chart } : {}) },
    ...(played.provenance ? { provenance: played.provenance } : {}), ...(played.drumKit ? { drumKit: played.drumKit } : {}),
    ...(played.vocalChannels ? { vocalChannels: played.vocalChannels } : {}), ...(played.beatScale ? { beatScale: played.beatScale } : {}),
    ...(played.sourceNote ? { sourceNote: played.sourceNote } : {}),
  };
  return { named, kept };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const entries: IndexEntry[] = JSON.parse(fs.readFileSync(path.join(DB, 'index.json'), 'utf8'));
  // The best score of every MIDI file LMD-matched has, by MD5 (a file can match several recordings).
  const best = new Map<string, number>();
  if (fs.existsSync(SCORES)) {
    const scores: Record<string, Record<string, number>> = JSON.parse(fs.readFileSync(SCORES, 'utf8'));
    for (const pairs of Object.values(scores)) for (const [md5, score] of Object.entries(pairs)) if (score > (best.get(md5) ?? -1)) best.set(md5, score);
  } else console.warn(`No ${SCORES}: duplicates are decided without LMD match scores (run download.js).`);
  const groups = duplicateGroups(entries);
  const merit = async (e: IndexEntry): Promise<Merit> => {
    const midi = e.files.midi && path.join(DB, e.files.midi);
    const md5 = midi ? crypto.createHash('md5').update(fs.readFileSync(midi)).digest('hex') : '';
    const song = midi ? await loadSong(e, async (file) => fs.readFileSync(path.join(DB, file))) : null;
    return { notes: !!midi, match: best.get(md5), chart: !!e.files.mcgill, lakh: !e.provenance, structure: song ? transcriptionScore(song) : -2, popularity: e.popularity ?? 0, id: e.id };
  };
  const moved: Record<string, string> = {};
  const replaced = new Map<IndexEntry, IndexEntry>();
  let charts = 0, withScore = 0;
  for (const group of groups) {
    const merits = new Map<IndexEntry, Merit>();
    for (const e of group) merits.set(e, await merit(e));
    if (group.some((e) => merits.get(e)!.match !== undefined)) withScore++;
    const [played] = [...group].sort((a, b) => better(merits.get(a)!, merits.get(b)!));
    const { named, kept } = mergeGroup(group, played);
    if (kept.files.mcgill && !played.files.mcgill && played.files.midi) charts++;
    replaced.set(named, kept);
    for (const d of group) if (d !== named) moved[d.id] = kept.id;
  }
  const next = entries.filter((e) => !moved[e.id]).map((e) => replaced.get(e) ?? e);
  console.log(JSON.stringify({ entries: entries.length, songsTwice: groups.length, decidedByMatchScore: withScore, dropped: Object.keys(moved).length, chartsMoved: charts, after: next.length, dryRun }));
  if (dryRun) return;
  // Earlier moves stay: an address published before this run still reaches its song (a chain is followed to its end).
  const file = path.join(DB, 'moved.json');
  const all: Record<string, string> = { ...(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}), ...moved };
  const alive = new Set(next.map((e) => e.id));
  const target = (id: string, seen = new Set<string>()): string => (alive.has(id) || seen.has(id) || !all[id] ? id : target(all[id], seen.add(id)));
  const resolved = Object.fromEntries(Object.keys(all).filter((id) => !alive.has(id)).map((id) => [id, target(id)]).filter(([, to]) => alive.has(to)));
  fs.writeFileSync(path.join(DB, 'index.json.next'), JSON.stringify(next));
  fs.renameSync(path.join(DB, 'index.json.next'), path.join(DB, 'index.json'));
  fs.writeFileSync(file, `${JSON.stringify(resolved, null, 1)}\n`);
  const played = new Set(next.flatMap((e) => Object.values(e.files)));
  for (const f of new Set(entries.flatMap((e) => Object.values(e.files)))) {
    if (played.has(f) || !fs.existsSync(path.join(DB, f))) continue;
    fs.mkdirSync(path.dirname(path.join(DROPPED, f)), { recursive: true });
    fs.renameSync(path.join(DB, f), path.join(DROPPED, f));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
