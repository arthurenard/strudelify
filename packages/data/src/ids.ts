/**
 * Catalogue ids. An id is part of every shared link (`#the-beatles--hey-jude`), so a rebuild must
 * give each song the id it already has, and never hand a retired id to another song.
 *
 * The ids once followed search's `tokenize`, which is retuned for ranking, so the shipped
 * catalogue mixes several spellings (`10cc--i-m-not-in-love` beside
 * `meat-loaf--ill-do-anything-for-love-but-i-wont-do-that`) and no rule reproduces them all.
 * `catalogue-ids.tsv` therefore records every id with the artist and title it was given for, and
 * the rules here (`slug`, `assignIds`) only name songs that are new to the catalogue. `words` is a
 * frozen copy of the text folding, independent of search, so those names do not drift either.
 */
import fs from 'node:fs';

const LATIN: Record<string, string> = { ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', ð: 'd', þ: 'th', ł: 'l', đ: 'd', ı: 'i' };
const WORDS: Record<string, string> = { n: 'and', ii: '2', iii: '3', iv: '4', pt: 'part' };

/**
 * Lower-case ASCII words: diacritics stripped, `&` spelled out, apostrophes removed, runs of
 * single letters joined (U.S.S.R. is `ussr`), roman numerals two to four and "n" normalised.
 * Frozen: changing it would rename songs and merge or split them in a rebuild.
 */
export function words(text: string): string[] {
  const s = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[ßæœøðþłđı]/g, (c) => LATIN[c] ?? c)
    .replace(/&/g, ' and ')
    .replace(/['’`´]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!s) return [];
  const raw = s.split(' ');
  const out: string[] = [];
  const single = (w: string) => w.length === 1 && w >= 'a' && w <= 'z';
  for (let i = 0; i < raw.length; i++) {
    let w = raw[i];
    if (single(w) && i + 1 < raw.length && single(raw[i + 1])) {
      let j = i + 1;
      while (j < raw.length && single(raw[j])) w += raw[j++];
      i = j - 1;
    }
    out.push(WORDS[w] ?? w);
  }
  return out;
}

/** An id part: the words joined by hyphens, at most 60 characters. */
export function slug(s: string): string {
  return words(s).join('-').slice(0, 60) || 'untitled';
}

/** The key a song is recorded under: its artist and title exactly as the sources spell them. */
export const idKey = (artist: string, title: string) => `${artist}\t${title}`;
/**
 * The key an imported score is recorded under: its artist and title, and its score, since a score may share its
 * artist and title with a transcription already in the catalogue (a second Sweet Child O' Mine).
 */
export const scoreKey = (artist: string, title: string, score: string) => idKey(artist, `${title} [score ${score}]`);

/** `catalogue-ids.tsv`: one `id<TAB>artist<TAB>title` line per song, sorted by id. */
export function readIds(file: string): Map<string, string> {
  const ids = new Map<string, string>();
  if (!fs.existsSync(file)) return ids;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    const [id, artist, title] = line.split('\t');
    if (!id || artist === undefined || title === undefined) throw new Error(`Malformed line in ${file}: ${line}`);
    ids.set(idKey(artist, title), id);
  }
  return ids;
}

export function writeIds(file: string, ids: Map<string, string>): void {
  const lines = [...ids].map(([key, id]) => `${id}\t${key}`).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  fs.writeFileSync(`${file}.next`, lines.join('\n') + '\n');
  fs.renameSync(`${file}.next`, file);
}

/**
 * Ids for this build's songs. A song recorded in `known` keeps its id. A new song is named
 * `artist--title` (see `slug`), with `-2`, `-3`... when that is taken, by a song of this build or
 * by any recorded id, so a retired id is never reused. New songs are named in a fixed order (by
 * name, then artist and title), whatever order the sources were read in.
 */
export function assignIds<T extends { artist: string; title: string }>(songs: T[], known: Map<string, string>, keyOf = (song: T) => idKey(song.artist, song.title)): Map<T, string> {
  const out = new Map<T, string>();
  const taken = new Set(known.values());
  const fresh: { song: T; base: string }[] = [];
  for (const song of songs) {
    const id = known.get(keyOf(song));
    if (id) out.set(song, id);
    else fresh.push({ song, base: `${slug(song.artist)}--${slug(song.title)}` });
  }
  const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  fresh.sort((a, b) => order(a.base, b.base) || order(a.song.artist, b.song.artist) || order(a.song.title, b.song.title));
  for (const { song, base } of fresh) {
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    taken.add(id);
    out.set(song, id);
  }
  return out;
}
