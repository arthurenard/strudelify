/**
 * Song search.
 *
 * A small, dependency-free inverted index over title / artist with prefix and
 * fuzzy (typo) matching, and a ranking written for the way people look for
 * songs: "title", "artist", "title artist", "artist - title", "title by artist",
 * partial words while typing, misspellings.
 *
 * Ranking in one paragraph: every query token is matched against index terms
 * (exact > prefix > typo) and scored by how much of the query it explains
 * (idf-weighted). On top of that, large fixed bonuses encode the intent tiers:
 * the whole title matched letter-perfect (+ the artist too) beats a title with a
 * typo (a full title is only as good as its worst word, and a "typo" of a word
 * that exists as typed is discounted), which beats a query that is the artist's
 * name or a word of it (scaled by how well known the catalogue is relative to
 * the other artists the query could mean, by how much of the name was typed and,
 * for a single word of the name, by how often that word is an artist rather than
 * a title word in the data), which is level with a title prefix (including a
 * whole title whose last word is still being typed), which beats a phrase inside
 * the title, which beats a bag-of-words overlap. A trailing parenthetical is an
 * alternative title ("I Got You (I Feel Good)" is a full match for "i feel good").
 * Words typed without their spaces are found through glued runs of the index
 * ("obladi oblada", "teenspirit"), multi-word artists also through their glued
 * name ("acdc") and their initials ("ccr", "rhcp", "gnr"). Popularity is a small
 * additive term, so it only decides between candidates that match equally well
 * (covers vs originals, duplicate transcriptions, an artist's catalogue); the one
 * exception is a whole title from a song with a single transcription by an artist
 * with nothing else to their name (or a title that is mostly an artist's name in
 * the data), whose bonus shrinks against the same words inside a song more than
 * twice as popular, or against an artist of that name ("Rule the World" by Duke
 * Robillard lists after Tears for Fears, the song "Mozart" after the composer;
 * Aretha Franklin's "Respect" stays above "A Little Respect"). Duplicate
 * transcriptions of one song (same artist, the same title up to one misspelt
 * word, see isDuplicateTitle: "Part 1" and "Part 2" are never one song) share
 * their best score, so the most transcribed one leads. A one-letter last token
 * refines the candidates of the previous words instead of replacing them, so the
 * list stays stable at every keystroke. Everything is deterministic: ties are
 * broken by popularity, then the artist's catalogue, then source count, then how
 * the title matched (exact before fuzzy before prefix), then title, then id.
 */
import type { IndexEntry } from './types.js';

/**
 * How the title (or artist) was matched:
 * - exact: every word letter-perfect, the whole title covered
 * - fuzzy: the whole title covered, but at least one word through a typo or glued words
 * - prefix: the query is a prefix of the title (the last word may be half typed)
 * - phrase: the query's title words are a contiguous run inside the title
 * - partial: some words matched, anywhere
 */
export type MatchKind = 'exact' | 'fuzzy' | 'prefix' | 'phrase' | 'partial' | 'none';
/** Tie-break order of title match kinds, best first. */
const MATCH_RANK: Record<MatchKind, number> = { exact: 0, fuzzy: 1, prefix: 2, phrase: 3, partial: 4, none: 5 };

export interface SearchHit extends IndexEntry {
  score: number;
  /**
   * How the title and the artist were matched (title 'phrase': the query's title words
   * are a contiguous run inside the title, 'partial': some words, anywhere), which
   * fraction of the query (idf-weighted) this hit explains, and which fraction of the
   * title's words the query covers, for callers that want to explain or gate a result.
   */
  match: { title: MatchKind; artist: MatchKind; coverage: number; titleShare: number };
}

export type Resolution =
  | { kind: 'none'; hits: SearchHit[] }
  | { kind: 'ok'; entry: SearchHit; hits: SearchHit[] }
  | { kind: 'ambiguous'; hits: SearchHit[] };

export interface SongIndex {
  entries: IndexEntry[];
  search(query: string, limit?: number): SearchHit[];
  /**
   * Pick the single song a query refers to, or report that it is ambiguous.
   * An exact title shared by several artists is ambiguous unless one of them is
   * clearly the original (three or more MIDI transcriptions and more than twice
   * the best rival's, or more than the rival's from a catalogue at least twice as
   * big); a typo'd title with another full title or an exact-word match nearby, a
   * half-typed title with several completions, a query that also reads as an
   * artist's name (a catalogue, not a song), and a query whose last word is a
   * single letter still being typed (not a digit, not followed by a space, not a
   * letter-perfect word of the best title: "nothing compares 2 u" is complete) are
   * ambiguous too. Words inside a title only resolve when they explain nearly all
   * of the query, run contiguously through the title and cover at least half of
   * it (or the artist is named as well): a song that is not in the database must
   * not be silently replaced by one that shares a word with it, and among
   * duplicate transcriptions of one song only a strict duplicate (the same title
   * up to a misspelt word, never a different number or part) may stand in for
   * the one matched.
   */
  resolve(query: string, limit?: number): Resolution;
}

// ---------------------------------------------------------------------------
// Text normalisation

const LATIN: Record<string, string> = { ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', ð: 'd', þ: 'th', ł: 'l', đ: 'd', ı: 'i' };
/** Token aliases applied to both the index and the query. */
const WORDS: Record<string, string> = { n: 'and', ii: '2', iii: '3', iv: '4', pt: 'part' };

/**
 * Lower-case ASCII tokens: diacritics stripped, `&` -> and, apostrophes removed
 * (don't -> dont, o' mine -> o mine), runs of single letters joined
 * (R.E.M. -> rem, U.S.S.R. -> ussr), roman numerals and 'n' normalised.
 * With `typing`, a trailing single letter is kept as typed: the "n" of
 * "dont stop me n" is the start of "now", not "and", and the "r" of "guns n r"
 * is not glued to the "n" the way R.E.M. is.
 */
export function tokenize(text: string, typing = false): string[] {
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
  const lastLetter = typing && single(raw[raw.length - 1]) ? raw.length - 1 : -1;
  for (let i = 0; i < raw.length; i++) {
    let w = raw[i];
    if (single(w) && i + 1 < raw.length && single(raw[i + 1]) && i + 1 !== lastLetter) {
      let j = i + 1;
      while (j < raw.length && single(raw[j]) && j !== lastLetter) w += raw[j++];
      i = j - 1;
    }
    out.push(typing && i === raw.length - 1 && single(w) ? w : (WORDS[w] ?? w));
  }
  return out;
}

/** Normalised form of a string: the tokens joined by single spaces. */
export function normaliseText(s: string): string {
  return tokenize(s).join(' ');
}

/**
 * Split a title into an optional leading parenthetical ("(What a) Wonderful World",
 * "(You Drive Me) Crazy"), the main part, and trailing parenthesised / bracketed
 * extras ("I Got You (I Feel Good)", "Kokomo (From the soundtrack)"), each extra
 * returned on its own as well.
 */
function splitTitle(title: string): { lead: string; main: string; extras: string[] } {
  let lead = '';
  const extras: string[] = [];
  const main = title.replace(/[([][^)\]]*[)\]]/g, (m, at: number) => {
    if (title.slice(0, at).trim() === '') lead += ' ' + m.slice(1, -1);
    else extras.push(m.slice(1, -1));
    return ' ';
  });
  return { lead, main, extras };
}

/** "O'Riley" -> "O Riley", "Rock 'n' Roll" untouched: a word split at its apostrophe. */
function splitApostrophes(title: string): string {
  return title.replace(/\b([a-z])['’]([a-z]{2,})/gi, '$1 $2');
}

// ---------------------------------------------------------------------------
// Small string utilities

function letterMask(s: string): number {
  let m = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    m |= 1 << (c >= 97 && c <= 122 ? c - 97 : 26);
  }
  return m;
}

function popcount(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** Optimal-string-alignment (Damerau-Levenshtein with adjacent transpositions), bounded by `max`. */
export function editDistance(a: string, b: string, max: number): number {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev2: number[] = [];
  let prev: number[] = [];
  for (let j = 0; j <= lb; j++) prev.push(j);
  for (let i = 1; i <= la; i++) {
    const cur: number[] = [i];
    let rowMin = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const bj = b.charCodeAt(j - 1);
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ai === bj ? 0 : 1));
      if (i > 1 && j > 1 && ai === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === bj) v = Math.min(v, prev2[j - 2] + 1);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[lb];
}

/**
 * Popularity bonus the data build adds to a charting (McGill) hit; the rest of an
 * entry's popularity is the number of MIDI transcriptions found for it (see
 * packages/data/src/build.ts).
 */
export const CHART_BONUS = 4;

/** Number of independent MIDI transcriptions behind an entry: its popularity without the chart bonus. */
export function transcriptions(e: Pick<IndexEntry, 'popularity' | 'sources'>): number {
  return Math.max(0, (e.popularity ?? 0) - (e.sources.includes('mcgill') ? CHART_BONUS : 0));
}

/**
 * Two words that can be one misspelt: letters only (a number or a numeral is never a
 * typo of another), four letters only as a swap of two of them, five to seven letters
 * within one edit, eight or more within two: the same tolerances as a typo in a query.
 */
function spellingVariant(a: string, b: string): boolean {
  if (a === b) return true;
  const L = Math.min(a.length, b.length);
  if (L < 4 || /\d/.test(a) || /\d/.test(b)) return false;
  if (L === 4) return a.length === b.length && letterMask(a) === letterMask(b) && editDistance(a, b, 1) === 1;
  const max = L >= 8 ? 2 : 1;
  return editDistance(a, b, max) <= max;
}

/**
 * Two normalised titles (as word lists) that are transcriptions of one song: the same
 * words, the same letters spaced differently ("Brick House" / "Brickhouse", "Fu-Gee-La" /
 * "Fugeela"), or the same number of words with exactly one of them a spelling variant of
 * the other ("Livin' On a Prayer" / "Living on a Prayer", "Smell Like Teen Spirit").
 * Titles that differ in a number, a numeral, a short word or an extra word are different
 * songs ("Part 1" / "Part 2", "Oxygene, Part 4" / "Oxygene, Part 6", "I'd" / "I'll",
 * "Dio Morto" / "Dio e Morto").
 */
export function sameSongTitle(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return a.length > 0 && a.join('') === b.join('');
  let differ = -1;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    if (differ >= 0) return false;
    differ = i;
  }
  return differ < 0 || spellingVariant(a[differ], b[differ]);
}

/** Words of a title as the index sees them: a leading parenthetical, then the main title without trailing parentheticals. */
function titleWords(title: string): string[] {
  const { lead, main } = splitTitle(title);
  return [...tokenize(lead), ...tokenize(main)];
}

/**
 * Whether two raw titles (of one artist) are duplicate transcriptions of the same song:
 * sameSongTitle on the titles without their trailing parentheticals ("I Got You (I Feel
 * Good)" is "I Got You"), or on the whole titles ("Another Brick In The Wall (Part II)"
 * is "Another Brick in the Wall, Part 2", but not "Part 1"). For result lists that
 * collapse duplicates into one row.
 */
export function isDuplicateTitle(a: string, b: string): boolean {
  // Parenthetical part numbers identify separate works, not optional alternate titles.
  const numbers = (s: string) => tokenize(s).filter(t => /^\d+$/.test(t)).join(' ');
  if (numbers(a) !== numbers(b)) return false;
  return sameSongTitle(titleWords(a), titleWords(b)) || sameSongTitle(tokenize(a), tokenize(b));
}

// ---------------------------------------------------------------------------
// Index

const F_TITLE = 1;
const F_EXTRA = 2;
const F_ARTIST = 4;
const MAX_TOKENS = 12;
const SLOTS = MAX_TOKENS * 3;
const PREFIX_CAP = 300;
/** Longest glued alias ("gunsandroses" is 12, "obladioblada" too). */
const ALIAS_MAX = 16;
/** Marks an initials alias ("rhcp") in aliasFirst: never reached by a prefix or a typo. */
const INITIALS = ALIAS_MAX + 1;
/** Summed catalogue popularity from which an artist's initials are indexed ("ccr", "elo"). */
const INITIALS_CATALOGUE = 3;
/** Glued runs of adjacent words are indexed up to this many words ("obladi" is "ob la di"). */
const GLUE_RUN = 4;
const COVER_RE = /\b(karaoke|tribute|in the style of|made famous|sound-?alikes?|backing tracks?|various artists|unknown artists?|cover versions?|as made popular)\b/i;
/** Words that do not identify an artist: "The Who" is "who", "Simon & Garfunkel" is "simon garfunkel". */
const ARTIST_STOP = new Set(['the', 'and']);

/** Words glued into one token: their term ids (a set) and how many words the run has. */
interface GluedRun {
  ids: number[];
  words: number;
}

interface Doc {
  /** Title tokens, the optional leading parenthetical first. */
  title: string[];
  /** Every token of the raw title, trailing parentheticals included, for duplicate detection. */
  full: string[];
  titleIds: Int32Array;
  /** Number of leading optional tokens: they count as title text but a full match does not need them. */
  lead: number;
  /** Artist terms without "the" / "and", used for exactness checks. */
  artistCore: Int32Array;
  /** Term ids standing for the whole artist name: glued (AC DC -> acdc) and initials (ccr). */
  aliases: Int32Array;
  titleStr: string;
  /**
   * Alternative readings of the whole title, normalised: each trailing parenthetical
   * ("I Got You (I Feel Good)" -> "i feel good") and the apostrophe-split form
   * ("Baba O'Riley" -> "baba o riley"). A query equal to one is a full title match.
   */
  alts: string[];
  /** The core title words joined without spaces ("freebird", "obladioblada"), '' for a one-word title or a long one. */
  gluedTitle: string;
  artistKey: string;
  pop: number;
  /** Summed popularity of the artist's catalogue. */
  catalogue: number;
  /** 0..1: how well known the artist's whole catalogue is (log of its summed popularity). */
  artistWeight: number;
  cover: boolean;
}

/** Match kinds per term, best (lowest) wins when two query tokens reach the same term. */
const K_EXACT = 1;
const K_GLUED = 2;
const K_PREFIX = 3;
const K_FUZZY = 4;
/** Quality of a word reached through glued words ("wonder wall", "teenspirit"). */
const GLUED_Q = 0.9;
/**
 * Weight of a short (1-2 letter) last token after other words, per letter, as a share of
 * the average weight of the words before it: it refines their candidates, it cannot
 * dominate them ("hey ju" is not "Jump").
 */
const LETTER_SHARE = 0.3;
/**
 * Quality of a prefix match. Mostly flat: which word a user means at "sta" is a
 * matter of popularity, not of how long the word is; the slope only breaks ties
 * towards the shorter completion.
 */
function prefixQ(typed: number, wordLen: number): number {
  return 0.8 + 0.2 * (typed / wordLen);
}
/** Fraction of the word typed, recovered from a prefix quality. */
function prefixTyped(q: number): number {
  return Math.min(1, Math.max(0, (q - 0.8) / 0.2));
}
/** Popularity term: 0.6 * log2(1 + popularity). */
function popTerm(pop: number): number {
  return 0.6 * Math.log2(1 + Math.max(0, pop));
}
/**
 * An "unknown" exact title: the title has at most UNKNOWN_POP transcriptions across every
 * artist, and its artist's other songs sum to at most UNKNOWN_CATALOGUE (or the title's
 * words are mostly artist names in the data). Such a title, against the same words inside
 * (or at the start of) a song more than twice as popular, or against an artist of that
 * name with a bigger catalogue, is one of two rival readings of the query, and its bonus
 * shrinks with the popularity ratio (a quarter at 4x, then floored just above a
 * bag-of-words match) so that popularity decides. The thresholds are the smallest
 * counts the data can express (one transcription, one other song): 62% of the entries
 * have a single transcription, so anything looser would demote real originals. A title
 * with one transcription by an artist with a catalogue is not unknown, and neither is a
 * cover of a title someone else transcribed more (exact titles win; resolve() still
 * reports both readings).
 */
const UNKNOWN_POP = 1;
const UNKNOWN_CATALOGUE = 1;
function unknownTitleFactor(pop: number, rivalPop: number): number {
  // pop: the best popularity of any song with this exact title (a cover of a known title is not unknown)
  if (pop > UNKNOWN_POP || rivalPop <= 0) return 1;
  const ratio = rivalPop / Math.max(1, pop);
  return Math.min(1, 4 / (ratio * ratio));
}
/** Summed catalogue popularity at which an artist name counts as fully known. */
const KNOWN_CATALOGUE = 40;
/** Score gap under which two full/prefix titles are rival readings of the query. */
const CLOSE_SCORE = 1.5;
/**
 * Quality multiplier for a typo candidate of a word that exists exactly as typed:
 * "cline" is Patsy Cline before it is a misspelt "Aline".
 */
const EXACT_ALT_FUZZY = 0.6;
/** Quality of a complete word read as a word with its last letter dropped ("gun" -> guns). */
const DROPPED_LETTER_Q = 0.5;
/** Quality of a full match through an alternative title (a parenthetical), below the main title. */
const ALT_TITLE_Q = 0.9;
/** The worst-matched word of a full title scales its bonus down to this factor at most. */
const WORST_WORD_FLOOR = 0.5;
/** Artist tier: base for an unknown artist, plus this much for a fully known one (see KNOWN_CATALOGUE). */
const ARTIST_TIER_BASE = 1.5;
const ARTIST_TIER_KNOWN = 5;
/**
 * A word of an artist's name matched by a short last word still being typed is as
 * likely the start of a longer word: "dan" is Dancing Queen before Steely Dan.
 */
const SHORT_LAST_WORD = 3;
const SHORT_LAST_WORD_PRIOR = 0.6;

function artistCoreWords(tokens: string[]): string[] {
  const core = tokens.filter((t) => !ARTIST_STOP.has(t));
  return core.length ? core : tokens;
}

function artistKeyOf(tokens: string[]): string {
  return artistCoreWords(tokens).slice().sort().join(' ');
}

export function createIndex(entries: IndexEntry[]): SongIndex {
  const termId = new Map<string, number>();
  const terms: string[] = [];
  const postLists: number[][] = [];
  /** Highest popularity among the songs containing each term: which prefix completions matter. */
  const termPop: number[] = [];
  const intern = (w: string): number => {
    let id = termId.get(w);
    if (id === undefined) {
      id = terms.length;
      termId.set(w, id);
      terms.push(w);
      postLists.push([]);
      termPop.push(0);
    }
    return id;
  };

  const N = entries.length;
  const docs: Doc[] = new Array(N);
  const artistKeys = new Set<string>();
  const cataloguePop = new Map<string, number>();
  for (const e of entries) {
    const key = artistKeyOf(tokenize(e.artist));
    cataloguePop.set(key, (cataloguePop.get(key) ?? 0) + Math.max(0, e.popularity ?? 0));
  }
  /**
   * Runs of adjacent words glued together -> the term ids of the words ("teenspirit" ->
   * teen, spirit; "obladi" -> ob, la, di), plus whole titles ("obladioblada").
   */
  const glued = new Map<string, GluedRun>();
  const glue = (words: string[], from: number, to: number) => {
    const key = words.slice(from, to).join('');
    if (key.length > ALIAS_MAX) return;
    let run = glued.get(key);
    if (!run) glued.set(key, (run = { ids: [], words: 0 }));
    for (let i = from; i < to; i++) {
      const id = termId.get(words[i])!;
      if (!run.ids.includes(id)) run.ids.push(id);
    }
    if (to - from > run.words) run.words = to - from;
  };
  /**
   * Length of the first word of a glued artist alias, per term id (0: not an alias;
   * INITIALS: an initials alias, only ever matched by the exact token).
   */
  const aliasFirst: number[] = [];
  /** Term ids that occur as an ordinary title/artist word (an alias may coincide with one). */
  const realWord: boolean[] = [];
  /** Postings carrying the artist flag, per term: how often the word is an artist rather than a title word. */
  const artistPostings: number[] = [];
  for (let d = 0; d < N; d++) {
    const e = entries[d];
    const { lead, main, extras } = splitTitle(e.title);
    const leadTokens = tokenize(lead);
    const title = [...leadTokens, ...tokenize(main)];
    const titleSet = new Set(title);
    const titleStr = ' ' + title.join(' ') + ' ';
    // Parenthesised parts and "O'Riley -> o riley" style splits are searchable, at a lower
    // weight, and each of them is also an alternative reading of the whole title.
    const alts: string[] = [];
    const extraTokens: string[] = [];
    for (const src of [...extras, splitApostrophes(e.title)]) {
      const toks = tokenize(src);
      if (!toks.length) continue;
      const str = ' ' + toks.join(' ') + ' ';
      if (str !== titleStr && !alts.includes(str)) alts.push(str);
      for (const w of toks) if (!titleSet.has(w)) extraTokens.push(w);
    }
    const artist = tokenize(e.artist);
    const masks = new Map<number, number>();
    const add = (words: string[], f: number) => {
      for (const w of words) {
        const id = intern(w);
        realWord[id] = true;
        masks.set(id, (masks.get(id) ?? 0) | f);
      }
    };
    add(title, F_TITLE);
    add(extraTokens, F_EXTRA);
    add(artist, F_ARTIST);
    // Words typed without their spaces: every run of 2..GLUE_RUN adjacent title words and
    // the whole title ("obladi oblada", "obladioblada"), pairs of artist words.
    for (let i = 0; i + 1 < title.length; i++) for (let j = i + 2; j <= Math.min(title.length, i + GLUE_RUN); j++) glue(title, i, j);
    if (title.length > GLUE_RUN) glue(title, 0, title.length);
    for (let i = 0; i + 1 < artist.length; i++) glue(artist, i, i + 2);
    // Multi-word artists are also findable glued together ("acdc", "zztop", "ledzeppelin")
    // and, once their catalogue is known at all, by their initials ("ccr", "elo", "rhcp";
    // "gnr" with the "n"). Initials are only ever matched by the exact token.
    const aliases: number[] = [];
    const gluedArtist = artist.join('');
    if (artist.length >= 2 && artist.length <= 3 && gluedArtist.length <= ALIAS_MAX) {
      const alias = intern(gluedArtist);
      masks.set(alias, (masks.get(alias) ?? 0) | F_ARTIST);
      const first = artist[0].length;
      if (!aliasFirst[alias] || first < aliasFirst[alias]) aliasFirst[alias] = first;
      aliases.push(alias);
    }
    const artistKey = artistKeyOf(artist);
    if (cataloguePop.get(artistKey)! >= INITIALS_CATALOGUE) {
      const core = artistCoreWords(artist);
      const variants = [core.map((w) => w[0]).join('')];
      if (artist.includes('and')) variants.push(artist.filter((w) => w !== 'the').map((w) => (w === 'and' ? 'n' : w[0])).join(''));
      for (const v of variants) {
        if (v.length < 3 || v.length > 5 || (core.length < 3 && !artist.includes('and'))) continue;
        const alias = intern(v);
        masks.set(alias, (masks.get(alias) ?? 0) | F_ARTIST);
        if (!aliasFirst[alias]) aliasFirst[alias] = INITIALS;
        if (!aliases.includes(alias)) aliases.push(alias);
      }
    }
    const pop = Math.max(0, e.popularity ?? 0);
    for (const [id, m] of masks) {
      postLists[id].push((d << 3) | m);
      if (pop > termPop[id]) termPop[id] = pop;
      if (m & F_ARTIST) artistPostings[id] = (artistPostings[id] ?? 0) + 1;
    }
    const artistCore = Int32Array.from(artistCoreWords(artist).map((w) => termId.get(w)!));
    docs[d] = {
      title,
      full: tokenize(e.title),
      titleIds: Int32Array.from(title.map((w) => termId.get(w)!)),
      lead: leadTokens.length,
      artistCore,
      aliases: Int32Array.from(aliases),
      titleStr,
      alts,
      gluedTitle: title.length - leadTokens.length >= 2 && title.join('').length <= ALIAS_MAX ? title.slice(leadTokens.length).join('') : '',
      artistKey,
      pop,
      catalogue: 0,
      artistWeight: 0,
      cover: COVER_RE.test(e.artist),
    };
    artistKeys.add(artistKey);
  }
  for (const doc of docs) {
    doc.catalogue = cataloguePop.get(doc.artistKey)!;
    doc.artistWeight = Math.min(1, Math.log2(1 + doc.catalogue) / Math.log2(1 + KNOWN_CATALOGUE));
  }
  /** Duplicate transcriptions of one song: the same artist and the same title, see isDuplicateTitle. */
  const sameSong = (a: Doc, b: Doc): boolean => a.artistKey === b.artistKey && (sameSongTitle(a.title, b.title) || sameSongTitle(a.full, b.full));

  const nTerms = terms.length;
  const post: Int32Array[] = postLists.map((l) => Int32Array.from(l));
  const idf = new Float64Array(nTerms);
  const lmask = new Int32Array(nTerms);
  /** 0..1 prior that a query word equal to this term means an artist, not a title. */
  const artistShare = new Float32Array(nTerms);
  const byLen: number[][] = [];
  for (let i = 0; i < nTerms; i++) {
    idf[i] = Math.log(1 + N / post[i].length);
    lmask[i] = letterMask(terms[i]);
    artistShare[i] = (artistPostings[i] ?? 0) / post[i].length;
    (byLen[terms[i].length] ??= []).push(i);
  }
  const sorted = terms.map((_, i) => i).sort((a, b) => (terms[a] < terms[b] ? -1 : terms[a] > terms[b] ? 1 : 0));
  const sortedStr = sorted.map((i) => terms[i]);
  const defaultIdf = Math.log(1 + N);

  // Per-query scratch space, reused across calls (no allocation in the hot path).
  const slots = new Float32Array(N * SLOTS);
  const docStamp = new Int32Array(N);
  const termStamp = new Int32Array(nTerms);
  const termQ = new Float32Array(nTerms);
  const termKind = new Int8Array(nTerms);
  /** Terms matched only through refine(): they count for a doc only where its own slot says so. */
  const termRefined = new Int32Array(nTerms);
  let gen = 0;
  let touched: number[] = [];

  /** Candidate terms for one query token: term id -> match quality and kind (best kept). */
  class Matches {
    q = new Map<number, number>();
    kind = new Map<number, number>();
    add(id: number, q: number, kind: number): void {
      const cur = this.q.get(id);
      if (cur === undefined || q > cur || (q === cur && kind < this.kind.get(id)!)) {
        this.q.set(id, q);
        this.kind.set(id, kind);
      }
    }
  }

  function lowerBound(p: string): number {
    let lo = 0;
    let hi = sortedStr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sortedStr[mid] < p) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Terms starting with `p`, except `p` itself. A short prefix ("st") can fan out to
   * thousands of terms; keep the ones that complete a popular song first, then the
   * most common ones. A glued artist alias only counts once the prefix crosses its
   * first word ("acd" is AC DC, "bowie" is the word bowie and not "bowiedavid"), and
   * `maxLen` limits the completions to words at most that long.
   */
  function prefixTerms(p: string, maxLen = Infinity): number[] {
    const out: number[] = [];
    for (let i = lowerBound(p); i < sortedStr.length && sortedStr[i].startsWith(p); i++) {
      const w = sortedStr[i];
      if (w === p || w.length > maxLen) continue;
      const id = sorted[i];
      if (aliasFirst[id] && !realWord[id] && p.length <= aliasFirst[id]) continue;
      out.push(id);
    }
    if (out.length > PREFIX_CAP) {
      out.sort((a, b) => termPop[b] - termPop[a] || post[b].length - post[a].length || a - b);
      out.length = PREFIX_CAP;
    }
    return out;
  }

  /**
   * Typo candidates: one edit for words of 5+ letters, two for 8+. Four-letter words only
   * accept a swap of two letters ("jhon" -> john): with substitutions "wall" would also
   * match call, ball, fall and hall. `scale` discounts them all (a word that exists as
   * typed is probably not a typo).
   */
  function fuzzyTerms(tok: string, into: Matches, scale: number): void {
    const L = tok.length;
    if (L < 4) return;
    const maxD = L >= 8 ? 2 : 1;
    const qm = letterMask(tok);
    const sameLetters = L === 4;
    for (let len = L - maxD; len <= L + maxD; len++) {
      const bucket = byLen[len];
      if (!bucket) continue;
      for (const id of bucket) {
        if (sameLetters ? lmask[id] !== qm : popcount(lmask[id] ^ qm) > 2 * maxD) continue;
        if (aliasFirst[id] === INITIALS && !realWord[id]) continue;
        const d = editDistance(tok, terms[id], maxD);
        if (d === 0 || d > maxD) continue;
        into.add(id, scale * (d === 1 ? (L <= 5 ? 0.6 : 0.7) : 0.45), K_FUZZY);
      }
    }
  }

  function touch(d: number): void {
    if (docStamp[d] !== gen) {
      docStamp[d] = gen;
      touched.push(d);
      slots.fill(0, d * SLOTS, d * SLOTS + SLOTS);
    }
  }

  function stamp(id: number, q: number, kind: number): void {
    if (termStamp[id] !== gen) {
      termStamp[id] = gen;
      termQ[id] = q;
      termKind[id] = kind;
    } else if (q > termQ[id] || (q === termQ[id] && kind < termKind[id])) {
      termQ[id] = q;
      termKind[id] = kind;
    }
  }

  function hit(t: number, id: number, q: number, kind: number): void {
    stamp(id, q, kind);
    const list = post[id];
    for (let k = 0; k < list.length; k++) {
      const p = list[k];
      const d = p >> 3;
      const m = p & 7;
      touch(d);
      const base = d * SLOTS + t * 3;
      if (m & F_TITLE && q > slots[base]) slots[base] = q;
      if (m & F_ARTIST && q > slots[base + 1]) slots[base + 1] = q;
      if (m & F_EXTRA && q > slots[base + 2]) slots[base + 2] = q;
    }
  }

  /**
   * Complete a short last token against the title and artist words of the docs touched
   * so far. Only those docs get the slot, so the list at "hey j" is the list at "hey",
   * narrowed. The matched terms are recorded in `matches` for the idf estimate.
   * A single letter after a complete title is taken as the title going on, not as the
   * artist's initial: "dont stop m" must not turn Madonna's "Don't Stop" into a
   * title-and-artist match above the other "Don't Stop"s.
   */
  function refine(t: number, tok: string, matches: Matches): void {
    const first = tok.charCodeAt(0);
    const c1 = tok.length > 1 ? tok.charCodeAt(1) : -1;
    const fits = (id: number): boolean => {
      const w = terms[id];
      return w.length > tok.length && w.charCodeAt(0) === first && (c1 < 0 || w.charCodeAt(1) === c1);
    };
    for (let i = 0; i < touched.length; i++) {
      const d = touched[i];
      const doc = docs[d];
      const base = d * SLOTS + t * 3;
      for (let k = 0; k < doc.titleIds.length; k++) {
        const id = doc.titleIds[k];
        if (!fits(id)) continue;
        const q = prefixQ(tok.length, terms[id].length);
        matches.add(id, q, K_PREFIX);
        if (termStamp[id] !== gen) termRefined[id] = gen;
        stamp(id, q, K_PREFIX);
        if (q > slots[base]) slots[base] = q;
      }
      if (tok.length === 1 && titleCoveredSoFar(doc)) continue;
      for (let k = 0; k < doc.artistCore.length; k++) {
        const id = doc.artistCore[k];
        if (!fits(id)) continue;
        const q = prefixQ(tok.length, terms[id].length);
        matches.add(id, q, K_PREFIX);
        if (termStamp[id] !== gen) termRefined[id] = gen;
        stamp(id, q, K_PREFIX);
        if (q > slots[base + 1]) slots[base + 1] = q;
      }
    }
  }

  const byId = new Map<string, number>();
  entries.forEach((e, i) => byId.set(e.id, i));
  const docOf = (h: SearchHit): Doc => docs[byId.get(h.id)!];

  /** Every core title word of the doc has been matched by the tokens processed so far. */
  function titleCoveredSoFar(doc: Doc): boolean {
    if (doc.titleIds.length === doc.lead) return false;
    for (let k = doc.lead; k < doc.titleIds.length; k++) if (termStamp[doc.titleIds[k]] !== gen) return false;
    return true;
  }

  /** Drop a "by" that separates a title from a known artist ("hey jude by the beatles"). */
  function stripBy(toks: string[]): string[] {
    for (let i = toks.length - 2; i > 0; i--) {
      if (toks[i] !== 'by') continue;
      if (artistKeys.has(artistKeyOf(toks.slice(i + 1)))) return [...toks.slice(0, i), ...toks.slice(i + 1)];
      break;
    }
    return toks;
  }

  function search(query: string, limit = 10): SearchHit[] {
    limit = Math.max(0, Math.floor(Number.isFinite(limit) ? limit : 10));
    // The last word is still being typed unless the query ends with a space.
    const typing = !/\s$/.test(query);
    const toks = stripBy(tokenize(query, typing)).slice(0, MAX_TOKENS);
    const n = toks.length;
    if (!n || !limit) return [];
    const shortLast = typing && toks[n - 1].length <= SHORT_LAST_WORD;
    gen++;
    touched = [];

    // 1. Match every query token against the term table.
    const idfQ: number[] = new Array(n);
    /** The run of words a token stands for when it is several words glued together ("obladi"). */
    const gluedRuns: (GluedRun | undefined)[] = new Array(n);
    for (let t = 0; t < n; t++) {
      const tok = toks[t];
      const last = t === n - 1;
      const matches = new Matches();
      const exact = termId.get(tok);
      if (exact !== undefined) matches.add(exact, 1, K_EXACT);
      // Prefix expansion: always for the word being typed, otherwise only for words long
      // enough not to explode ("the" must not become "there"); a 3-letter word without an
      // exact term is a partial word the user typed. A single letter after other words is
      // handled below: it refines their candidates instead of pulling in every j-word.
      const letter = last && tok.length === 1 && n > 1;
      if (!letter && tok.length >= (last ? 1 : exact === undefined ? 3 : 4)) {
        for (const id of prefixTerms(tok)) matches.add(id, prefixQ(tok.length, terms[id].length), K_PREFIX);
      } else if (!last && exact !== undefined && tok.length === 3) {
        // A complete short word may have lost its last letter: "gun n roses".
        for (const id of prefixTerms(tok, 4)) matches.add(id, DROPPED_LETTER_Q, K_FUZZY);
      }
      fuzzyTerms(tok, matches, exact === undefined ? 1 : EXACT_ALT_FUZZY);
      // "wonder wall" -> wonderwall, "radio gaga" -> ga ga, "obladi oblada" -> ob la di ob la da.
      if (t + 1 < n) {
        const joined = termId.get(tok + toks[t + 1]);
        if (joined !== undefined) matches.add(joined, GLUED_Q, K_GLUED);
      }
      if (t > 0) {
        const joined = termId.get(toks[t - 1] + tok);
        if (joined !== undefined) matches.add(joined, GLUED_Q, K_GLUED);
      }
      // A token that is a run of words glued together ("teenspirit", "freebird") stands for
      // those words too, whether or not it also exists as a word somewhere ("Freebird" is a
      // parenthetical of a medley; the exact word keeps quality 1 and wins on score alone).
      const run = glued.get(tok);
      if (run) {
        gluedRuns[t] = run;
        for (const id of run.ids) matches.add(id, GLUED_Q, K_GLUED);
      }
      for (const [id, q] of matches.q) hit(t, id, q, matches.kind.get(id)!);
      // A short last token (1-2 letters) also completes any word of the songs the previous
      // tokens already found, however rare that word is ("hey j" -> Hey Jude).
      if (last && n > 1 && tok.length <= 2) refine(t, tok, matches);
      let w = exact !== undefined ? idf[exact] : 0;
      if (last && n > 1 && tok.length <= 2) {
        let sum = 0;
        for (let i = 0; i < t; i++) sum += idfQ[i];
        w = (tok.length * LETTER_SHARE * sum) / t;
      } else if (exact === undefined) {
        let bestQ = 0;
        for (const [id, q] of matches.q) {
          if (q > bestQ || (q === bestQ && idf[id] > w)) {
            bestQ = q;
            w = idf[id];
          }
        }
        if (!matches.q.size) w = defaultIdf;
      }
      idfQ[t] = w;
    }
    if (!touched.length) return [];

    let qIdfTotal = 0;
    for (let t = 0; t < n; t++) qIdfTotal += idfQ[t];

    // 2. Cheap pass: how much of the query (idf-weighted) does each touched doc explain?
    const matchedIdf = new Float64Array(touched.length);
    let bestMatched = 0;
    for (let i = 0; i < touched.length; i++) {
      const base = touched[i] * SLOTS;
      let m = 0;
      for (let t = 0; t < n; t++) {
        const b = base + t * 3;
        if (slots[b] > 0 || slots[b + 1] > 0 || slots[b + 2] > 0) m += idfQ[t];
      }
      matchedIdf[i] = m;
      if (m > bestMatched) bestMatched = m;
    }
    const threshold = bestMatched * 0.6;
    const queryStr = ' ' + toks.join(' ') + ' ';

    // 3. The biggest catalogue among the artists the query could name (a word of the name
    // matched, "the" and "and" aside, or an alias): the artist tier is relative to it, so
    // five songs credited to "Elvis" do not outrank Elvis Presley.
    const namesArtist = (doc: Doc): boolean => {
      for (let k = 0; k < doc.artistCore.length; k++) if (termStamp[doc.artistCore[k]] === gen) return true;
      for (let k = 0; k < doc.aliases.length; k++) if (termStamp[doc.aliases[k]] === gen) return true;
      return false;
    };
    let maxCatalogue = 0;
    for (let i = 0; i < touched.length; i++) {
      if (matchedIdf[i] < threshold) continue;
      const doc = docs[touched[i]];
      if (doc.catalogue > maxCatalogue && namesArtist(doc)) maxCatalogue = doc.catalogue;
    }

    /**
     * How many words of a glued run a field (title or artist core) has: the run's word
     * count when the field has all of them, else the number of distinct words found.
     */
    const runWords = (run: GluedRun, field: Int32Array): number => {
      let have = 0;
      for (const id of run.ids) {
        for (let k = 0; k < field.length; k++) {
          if (field[k] === id) {
            have++;
            break;
          }
        }
      }
      return have === run.ids.length ? run.words : have;
    };
    /** A term reached only through a glued run counts for a field that has two or more words of that run. */
    const gluedOk = (id: number, field: Int32Array): boolean => {
      let inRun = false;
      for (let t = 0; t < n; t++) {
        const run = gluedRuns[t];
        if (!run || !run.ids.includes(id)) continue;
        inRun = true;
        if (runWords(run, field) >= 2) return true;
      }
      return !inRun;
    };

    // 4. Full scoring of the surviving candidates.
    const out: SearchHit[] = [];
    /** Per hit: the title-side score, its title bonus and floor, and the artist-side score, for step 5. */
    const titleScores: number[] = [];
    const titleBonuses: number[] = [];
    const titleFloors: number[] = [];
    const artistness: number[] = [];
    const artistScores: number[] = [];
    /** Per hit: a whole title from a song with a single transcription, see unknownTitleFactor. */
    const unknownFull: boolean[] = [];
    /** Per hit: the artist's catalogue, a tie-breaker after popularity. */
    const catalogues: number[] = [];
    /** Best popularity per whole title matched: a cover of a well-known title is not an unknown title. */
    const titlePop = new Map<string, number>();
    /** The most popular song reading the query's title words as a phrase inside, or the start of, its title. */
    let rivalPop = 0;
    /** The biggest catalogue reading the whole query as its artist's name. */
    let rivalCatalogue = 0;
    for (let i = 0; i < touched.length; i++) {
      if (matchedIdf[i] < threshold) continue;
      const d = touched[i];
      const doc = docs[d];
      const base = d * SLOTS;
      let qQual = 0;
      let qQualArtist = 0;
      let allMatched = true;
      let inTitle = 0;
      let inArtist = 0;
      let artistOnlyOk = true;
      for (let t = 0; t < n; t++) {
        const b = base + t * 3;
        let tq = slots[b];
        let aq = slots[b + 1];
        const xq = slots[b + 2];
        // A glued token stands for the words of its run, and only matches a field that has
        // at least two of them: "teenspirit" is not the band Spirit, "radioga" does not
        // cover the title "Radio". A field with a single word of the run matched through
        // that word alone (the run's quality, nothing better) does not match at all; a
        // field with none was reached by another term ("hote" is a prefix of Hotel).
        const run = gluedRuns[t];
        let words = 1;
        if (run) {
          const inT = runWords(run, doc.titleIds);
          if (inT === 1 && tq <= GLUED_Q) tq = 0;
          else if (inT >= 2) words = inT;
          if (aq > 0 && aq <= GLUED_Q && runWords(run, doc.artistCore) === 1) aq = 0;
        }
        const best = Math.max(tq, 0.9 * aq, 0.6 * xq);
        if (best === 0) allMatched = false;
        qQual += idfQ[t] * best;
        qQualArtist += idfQ[t] * aq;
        if (tq > 0) inTitle += words;
        if (aq > 0) inArtist++;
        else artistOnlyOk = false;
      }
      qQual /= qIdfTotal;
      qQualArtist /= qIdfTotal;

      // A term completed by refine() for some other doc does not count here unless this
      // doc's own slot for the last token was set (a global stamp, a per-doc match).
      const lastBase = base + (n - 1) * 3;
      const matched = (id: number, field: number) =>
        termStamp[id] === gen && (termRefined[id] !== gen || slots[lastBase + field] > 0) && (termKind[id] !== K_GLUED || gluedOk(id, field === 0 ? doc.titleIds : doc.artistCore));
      let tMatched = 0;
      let tMatchedCore = 0;
      let tQual = 0;
      let tIdf = 0;
      let tIdfMatched = 0;
      let tShare = 0;
      let tMinQ = 1;
      let coreLetterPerfect = true;
      let corePrefixed = false;
      for (let k = 0; k < doc.titleIds.length; k++) {
        const id = doc.titleIds[k];
        const w = idf[id];
        tIdf += w;
        if (matched(id, 0)) {
          tMatched++;
          if (k >= doc.lead) {
            tMatchedCore++;
            if (termKind[id] !== K_EXACT) coreLetterPerfect = false;
            if (termKind[id] === K_PREFIX) corePrefixed = true;
            if (termQ[id] < tMinQ) tMinQ = termQ[id];
          }
          tQual += w * termQ[id];
          tIdfMatched += w;
          tShare += w * artistShare[id];
        }
      }
      let titleQual = tIdf ? tQual / tIdf : 0;
      /**
       * How much the matched title words are artist words rather than title words in the
       * data, as the excess over an even split ("Elvis Interview": 0.97 -> 0.94; "sweet": 0).
       */
      const titleArtistness = tIdfMatched ? Math.max(0, (2 * tShare) / tIdfMatched - 1) : 0;

      let aMatched = 0;
      let aQual = 0;
      let aIdf = 0;
      let aIdfMatched = 0;
      let aPrior = 0;
      let aTyped = 0;
      let aLetterPerfect = true;
      for (const id of doc.artistCore) {
        const w = idf[id];
        aIdf += w;
        if (matched(id, 1)) {
          aMatched++;
          aQual += w * termQ[id];
          aIdfMatched += w;
          aPrior += w * artistShare[id];
          aTyped += termKind[id] === K_PREFIX ? prefixTyped(termQ[id]) : 1;
          if (termKind[id] !== K_EXACT) aLetterPerfect = false;
        }
      }
      let artistQual = aIdf ? aQual / aIdf : 0;
      // How much of the matched artist words has been typed (1 when they are complete).
      let artistTyped = aMatched ? aTyped / aMatched : 0;
      let aliasHit = false;
      for (let k = 0; k < doc.aliases.length; k++) {
        const alias = doc.aliases[k];
        if (termStamp[alias] !== gen) continue;
        aliasHit = true;
        aMatched = doc.artistCore.length;
        artistQual = Math.max(artistQual, termQ[alias]);
        artistTyped = Math.max(artistTyped, termKind[alias] === K_PREFIX ? prefixTyped(termQ[alias]) : 1);
      }

      // The title part of the query: the tokens the artist name does not explain. "The" or
      // "and" alone is not the artist's ("the wall" is not "The" Offspring + "Wall..."): a
      // stop word only belongs to the artist next to a real word of the name.
      const titlePart: string[] = [];
      for (let t = 0; t < n; t++) {
        const b = base + t * 3;
        // A field holds the token when it has the word itself (above the glued quality)
        // or at least two words of the run the token glues together.
        const run = gluedRuns[t];
        const inArtistField = slots[b + 1] > 0 && (!run || slots[b + 1] > GLUED_Q || runWords(run, doc.artistCore) >= 2);
        const inTitleField = slots[b] > 0 && (!run || slots[b] > GLUED_Q || runWords(run, doc.titleIds) >= 2);
        const artistOnly = inArtistField && !inTitleField && (aMatched > 0 || !ARTIST_STOP.has(toks[t]));
        if (!artistOnly) titlePart.push(toks[t]);
      }

      const titleN = doc.titleIds.length;
      const coreN = titleN - doc.lead;
      let titleCovered = allMatched && coreN > 0 && tMatchedCore === coreN && inTitle >= coreN;
      let titleExactQ = titleCovered && coreLetterPerfect;
      // A title whose last word is still being typed is a prefix, not a full match:
      // "jungle" must not rank Jungleland like the exact title it is not.
      let titleFull = titleCovered && !corePrefixed;
      const artistFull = doc.artistCore.length > 0 && aMatched === doc.artistCore.length && (aliasHit || inArtist >= doc.artistCore.length);

      let prefixTitle = titleCovered && !titleFull;
      let titleInQuery = false;
      let phraseInTitle = false;
      const k = titlePart.length;
      const partStr = ' ' + titlePart.join(' ') + ' ';
      // The query is one of the title's alternative readings ("i feel good" for
      // "I Got You (I Feel Good)", "baba o riley"): a full, letter-perfect match, even
      // where the main title was reached through glued words or a typo.
      if (allMatched && k > 0 && !titleExactQ && doc.alts.includes(partStr)) {
        titleCovered = titleFull = titleExactQ = true;
        prefixTitle = false;
        titleQual = Math.max(titleQual, ALT_TITLE_Q);
        tMinQ = 1;
        qQual = Math.max(qQual, ALT_TITLE_Q);
      }
      // The whole title typed without its spaces ("freebird", "obladioblada"): the letters
      // are all there, so it is a full match, not a fuzzy one.
      if (titleCovered && !titleExactQ && k === 1 && titlePart[0] === doc.gluedTitle) {
        titleFull = titleExactQ = true;
        prefixTitle = false;
        titleQual = tMinQ = 1;
        qQual = Math.max(qQual, 1);
      }
      if (!titleCovered) {
        if (allMatched && k > 0) {
          if (k <= titleN) {
            prefixTitle = true;
            for (let j = 0; j < k - 1 && prefixTitle; j++) if (titlePart[j] !== doc.title[j]) prefixTitle = false;
            if (prefixTitle && !doc.title[k - 1].startsWith(titlePart[k - 1])) prefixTitle = false;
          }
          if (!titleCovered && !prefixTitle) {
            // ...or the start of one ("i feel goo").
            const open = partStr.slice(0, -1);
            prefixTitle = doc.alts.some((a) => a.startsWith(open));
          }
        }
        if (!titleCovered && !prefixTitle) {
          titleInQuery = titleN > 0 && queryStr.includes(doc.titleStr);
          if (!titleInQuery && k > 0) phraseInTitle = doc.titleStr.includes(partStr);
        }
      }

      // Popularity is a small additive term: it orders equally good matches, it cannot lift
      // a partial match over a full one. The tiers are scaled by match quality so that a
      // typo'd "full" title never beats a letter-perfect artist, and a full title is only as
      // good as its worst-matched word ("country roads" is not "Country Road" first).
      // The artist named next to a full title counts more the bigger its catalogue is
      // among the artists the query could name ("in the ghetto elvis": Elvis Presley
      // before the five songs credited to "Elvis").
      const relative = maxCatalogue > 0 ? Math.sqrt(doc.catalogue / maxCatalogue) : 1;
      const artistPart = Math.sqrt(artistQual) * artistTyped;
      let titleBonus: number;
      if (titleFull) titleBonus = 8 * Math.max(tMinQ, WORST_WORD_FLOOR) * titleQual + (aMatched ? 2 * artistPart * (0.5 + 0.5 * relative) : 0);
      // A prefix of the title: the rest of the title is unknown, so how much of it the
      // query covers matters less than popularity ("hey" -> Hey Jude before Hey You). A word
      // that is almost always an artist's word in the data is less likely to be the start of
      // a title ("elvis" is not "Elvis Interview" first), or a phrase inside one ("beethoven"
      // is the composer before "Roll Over Beethoven").
      else if (prefixTitle) titleBonus = 3 + titleQual - 1.5 * titleArtistness;
      else titleBonus = 2 * titleQual + (titleInQuery ? 2 : phraseInTitle ? 1.5 * (1 - titleArtistness) : 0);
      const titleScore = 4 * qQual + artistQual + titleBonus;

      // Every query word is explained by the artist name: browse the catalogue by popularity.
      // The tier is scaled by how well known the artist is, by how much of the name has been
      // typed, and, when only part of the name was given, by how often that part is an
      // artist's word in the data: "zeppelin" is Led Zeppelin, "black" is a title word before
      // it is Black Sabbath, six one-transcription songs by a band called Sweet do not bury
      // Sweet Home Alabama, and "com" is Come Together before the Commodores. A complete,
      // letter-perfect word that is nearly always an artist's word stands for the name
      // however small a share of it it is: "mozart" is a third of "Wolfgang Amadeus
      // Mozart" but 75% of the time a composer in the data ("billi" or "ever", a typo or
      // a prefix away from Billy Joel and the Everly Brothers, get no such credit).
      let artistScore = -Infinity;
      const artistBrowse = allMatched && artistOnlyOk && aMatched > 0 && !(titleExactQ && !artistFull);
      if (artistBrowse) {
        const wordPrior = aIdfMatched > 0 ? aPrior / aIdfMatched : 0;
        let prior = artistFull || aIdfMatched === 0 ? 1 : wordPrior;
        if (!artistFull && shortLast) prior *= SHORT_LAST_WORD_PRIOR;
        const namePart = artistFull || !aLetterPerfect ? artistPart : Math.max(artistPart, wordPrior);
        artistScore = 3.6 * qQualArtist + artistQual + (ARTIST_TIER_BASE + ARTIST_TIER_KNOWN * doc.artistWeight * relative) * namePart * prior;
        if (!shortLast && doc.catalogue > rivalCatalogue) rivalCatalogue = doc.catalogue;
      }
      if ((phraseInTitle || prefixTitle) && !titleFull && doc.pop > rivalPop) rivalPop = doc.pop;

      let score = popTerm(doc.pop) + Math.max(titleScore, artistScore);
      if (doc.cover && aMatched === 0) score -= 2;

      titleScores.push(titleScore);
      titleBonuses.push(titleBonus);
      // A demoted exact title still ranks above loose word overlaps (a bag of words has
      // titleQual < 1 and no bonus) and a title that is an artist's name means less.
      titleFloors.push(2 * titleQual + 1);
      artistness.push(titleArtistness);
      artistScores.push(artistScore);
      unknownFull.push(titleFull && aMatched === 0 && (doc.catalogue - doc.pop <= UNKNOWN_CATALOGUE || titleArtistness > 0));
      catalogues.push(doc.catalogue);
      if (titleFull && doc.pop > (titlePop.get(doc.titleStr) ?? -1)) titlePop.set(doc.titleStr, doc.pop);
      out.push({
        ...entries[d],
        score,
        match: {
          title: titleExactQ ? 'exact' : titleFull ? 'fuzzy' : prefixTitle ? 'prefix' : phraseInTitle ? 'phrase' : tMatched > 0 ? 'partial' : 'none',
          artist: artistFull ? 'exact' : aMatched > 0 ? 'partial' : 'none',
          coverage: matchedIdf[i] / qIdfTotal,
          titleShare: coreN > 0 ? tMatchedCore / coreN : 0,
        },
      });
    }

    // 5. A whole title from a song nobody else transcribed, against the same words inside a
    // much more popular song or an artist of that name: shrink the title bonus with the
    // popularity ratio so that the two readings are decided by popularity.
    const rival = Math.max(rivalPop, rivalCatalogue);
    if (rival > 2 * UNKNOWN_POP) {
      for (let i = 0; i < out.length; i++) {
        if (!unknownFull[i]) continue;
        const factor = unknownTitleFactor(titlePop.get(docOf(out[i]).titleStr) ?? 0, rival);
        if (factor === 1) continue;
        const demoted = Math.max(titleBonuses[i] * factor, titleFloors[i]) * (1 - artistness[i]);
        const titleScore = titleScores[i] - titleBonuses[i] + demoted;
        out[i].score = popTerm(Math.max(0, out[i].popularity ?? 0)) + Math.max(titleScore, artistScores[i]);
      }
    }

    // 6. Duplicate transcriptions of one song (same artist, the same title up to one
    // misspelt word, each matched as a whole title or as its start) share their best score,
    // so the most transcribed one leads the group: "living on a prayer" is "Livin' On A
    // Prayer", "smell like teen spirit" is Nirvana's "Smells Like Teen Spirit"; "Part 1"
    // and "Part 2" of a suite are different songs and keep their own scores. Pairs are
    // only compared within one artist, so a one-letter query stays cheap.
    const byArtist = new Map<string, number[]>();
    for (let i = 0; i < out.length; i++) {
      const kind = out[i].match.title;
      if (kind !== 'exact' && kind !== 'fuzzy' && kind !== 'prefix') continue;
      const key = docs[byId.get(out[i].id)!].artistKey;
      const list = byArtist.get(key);
      if (list) list.push(i);
      else byArtist.set(key, [i]);
    }
    for (const list of byArtist.values()) {
      if (list.length < 2) continue;
      for (let a = 0; a < list.length; a++) {
        const da = docs[byId.get(out[list[a]].id)!];
        for (let b = a + 1; b < list.length; b++) {
          if (!sameSong(da, docs[byId.get(out[list[b]].id)!])) continue;
          const best = Math.max(out[list[a]].score, out[list[b]].score);
          out[list[a]].score = best;
          out[list[b]].score = best;
        }
      }
    }

    // 7. Order: score, then popularity, then the artist's catalogue (Scott Joplin's
    // "The Entertainer" before Marvin Hamlisch's), then source count, then how the title
    // matched (the letter-perfect spelling of a duplicate pair leads), title, id.
    const order = out.map((_, i) => i);
    order.sort((i, j) => {
      const a = out[i];
      const b = out[j];
      if (b.score !== a.score) return b.score - a.score;
      const pa = a.popularity ?? 0;
      const pb = b.popularity ?? 0;
      if (pb !== pa) return pb - pa;
      if (catalogues[j] !== catalogues[i]) return catalogues[j] - catalogues[i];
      if (b.sources.length !== a.sources.length) return b.sources.length - a.sources.length;
      const ka = MATCH_RANK[a.match.title];
      const kb = MATCH_RANK[b.match.title];
      if (ka !== kb) return ka - kb;
      if (a.title !== b.title) return a.title < b.title ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    const ranked = order.slice(0, Math.min(limit, order.length)).map((i) => out[i]);
    return ranked;
  }

  /** Transcriptions a candidate needs before any margin makes it "clearly" anything. */
  const CLEAR_MIN = 3;
  /**
   * A song is clearly more popular than another when it has CLEAR_MIN or more MIDI
   * transcriptions and more than twice as many as the other. Transcriptions, not
   * popularity: the chart bonus says a version charted, not that anyone transcribed it.
   */
  const clearlyMorePopular = (a: SearchHit, b: SearchHit) => {
    const ta = transcriptions(a);
    return ta >= CLEAR_MIN && ta > 2 * transcriptions(b);
  };
  /**
   * One of several artists sharing a title is clearly the original when it is clearly
   * more popular than every rival, or has more transcriptions than each of them and a
   * catalogue at least twice as big (an artist known for many songs before one known for
   * one): Neil Diamond's "Sweet Caroline" (7 transcriptions) over a chords-only cover,
   * George Michael's "Careless Whisper" (4, a catalogue of 32) over Wham!'s (3, 12);
   * Seal's "Crazy" (5, a catalogue of 14) is not clearly the original over Aerosmith's
   * (3, 47).
   */
  const clearlyOriginal = (a: SearchHit, rivals: SearchHit[]) => {
    const ta = transcriptions(a);
    if (ta < CLEAR_MIN) return false;
    const ca = docOf(a).catalogue;
    return rivals.every((r) => clearlyMorePopular(a, r) || (ta > transcriptions(r) && ca >= 2 * docOf(r).catalogue));
  };
  /** Coverage (idf-weighted share of the query explained) below which words inside a title do not resolve. */
  const PHRASE_COVERAGE = 0.8;
  /** Share of the title's words that a phrase must cover to resolve without the artist named. */
  const PHRASE_TITLE_SHARE = 0.5;
  /** Share of a word that a lone fragment must cover to resolve to the title starting with it. */
  const PREFIX_FRAGMENT = 0.75;

  function resolve(query: string, limit = 6): Resolution {
    const hits = search(query, limit);
    if (!hits.length) return { kind: 'none', hits };
    const typing = !/\s$/.test(query);
    const toks = tokenize(query, typing);
    const best = hits[0];
    // A trailing single letter is a word still being typed ("hey j", "led z"): never guess
    // what it completes. A digit is a word ("mambo no 5"), so is a letter followed by a
    // space, and so is a one-letter word of a title matched letter-perfect ("nothing
    // compares 2 u", "canon in d").
    const last = toks[toks.length - 1];
    if (toks.length > 1 && typing && last.length === 1 && last >= 'a' && last <= 'z' && best.match.title !== 'exact') return { kind: 'ambiguous', hits };
    // Half or more of what was typed is unexplained by the best hit: do not guess.
    if (best.match.coverage <= 0.5) return { kind: 'ambiguous', hits };
    const bestDoc = docOf(best);
    // Duplicate transcriptions of one song: same artist and the same title up to one
    // misspelt word or its spacing ("Smell Like Teen Spirit", "Brickhouse"); never a
    // different part or number.
    const isDup = (h: SearchHit) => sameSong(docOf(h), bestDoc);
    const others = hits.filter((h) => h !== best && !isDup(h));
    // Among duplicate transcriptions of the song, hand back the most transcribed one.
    let entry = best;
    for (const h of hits) if (h !== best && isDup(h) && (h.popularity ?? 0) > (entry.popularity ?? 0)) entry = h;
    const ok = (): Resolution => ({ kind: 'ok', entry, hits });
    const ambiguous = (): Resolution => ({ kind: 'ambiguous', hits });
    const pop = best.popularity ?? 0;
    const full = (h: SearchHit) => h.match.title === 'exact' || h.match.title === 'fuzzy';
    const sameTitle = (h: SearchHit) => docOf(h).titleStr === bestDoc.titleStr;
    /** The hit reads the query as an artist's name (or a word of it), not as a title. */
    const artistReading = (h: SearchHit) => h.match.title === 'none' && h.match.artist !== 'none';

    if (best.match.title === 'exact' && best.match.artist === 'exact') return ok();
    // An artist name, or a word of one, alone is a catalogue, not a song.
    if (artistReading(best)) return ambiguous();
    if (best.match.title === 'exact') {
      // The same title by other artists: one of them must be clearly the original; so must
      // a title that is also an artist's name in the data ("Mozart"). A song whose title
      // starts with or contains the query is a rival too when it is clearly more popular
      // ("the wall": Kansas's or Pink Floyd's?), or when nobody else transcribed the exact
      // title and its artist has nothing else to their name ("lola": Allan Theo's, or the
      // Kinks' "Lola - The Kinks Christmas Concert"?).
      const unknown = pop <= UNKNOWN_POP && bestDoc.catalogue - bestDoc.pop <= UNKNOWN_CATALOGUE;
      const rivals = others.filter(
        (h) =>
          h.match.title === 'exact' ||
          artistReading(h) ||
          ((h.match.title === 'prefix' || h.match.title === 'phrase') && (clearlyMorePopular(h, best) || (unknown && (h.popularity ?? 0) >= pop))),
      );
      if (rivals.some((h) => h.match.title !== 'exact' && !artistReading(h))) return ambiguous();
      return !rivals.length || clearlyOriginal(best, rivals) ? ok() : ambiguous();
    }
    // A title that is not letter-perfect and complete competes with the query's other
    // readings: the same words as an artist's name ("mercury": Mercury Blues / Freddie
    // Mercury), and any nearby full, prefix or exact-word match when the score is close.
    // "Wonderful" is a typo away from "wonderwal" but scores far below Wonderwall.
    if (others.some(artistReading)) return ambiguous();
    const close = (h: SearchHit) => best.score - h.score < CLOSE_SCORE;
    if (best.match.title === 'fuzzy') {
      // A typo'd title: another full title within an edit or two is as likely to be the one
      // meant ("heros": Hero / Heroes), unless it is the same title by a less popular artist;
      // so is a song that contains the words exactly as typed ("country roads").
      const rivals = others.filter((h) => (full(h) || h.match.title === 'phrase' || h.match.title === 'partial') && close(h));
      if (rivals.some((h) => !sameTitle(h))) return ambiguous();
      if (rivals.length) return clearlyOriginal(best, rivals) ? ok() : ambiguous();
    } else if (best.match.title === 'prefix') {
      // A lone word fragment ("muse") completes to too many things outside the database
      // to mean the one title that starts with it, unless most of the word was typed
      // ("wonderwal", "bohemian rhapsod").
      if (toks.length === 1 && !termId.has(toks[0])) {
        const first = bestDoc.title[bestDoc.lead] ?? '';
        if (toks[0].length < PREFIX_FRAGMENT * first.length) return ambiguous();
      }
      // The title is not finished: any other full or prefix title nearby is a different completion.
      const rivals = others.filter((h) => (full(h) || h.match.title === 'prefix') && close(h));
      if (rivals.some((h) => !sameTitle(h))) return ambiguous();
      if (rivals.length) return clearlyOriginal(best, rivals) ? ok() : ambiguous();
    } else {
      // Words inside a title ("teen spirit"). The song the user means may not be in the
      // database at all, so this is only a match when the words explain nearly all of the
      // query, run contiguously through the title and cover at least half of it, or the
      // artist is named too ("the wall pink floyd"); a bag of words never resolves
      // ("lose yourself" is not "Express Yourself", "top gun" is not "Gun").
      if (best.match.title !== 'phrase') return ambiguous();
      if (best.match.coverage < PHRASE_COVERAGE) return ambiguous();
      if (best.match.artist === 'none' && best.match.titleShare < PHRASE_TITLE_SHARE) return ambiguous();
      // Some words of a title against a whole title a typo away ("country roads"), or the
      // same words at the start of, or inside, a comparable song.
      if (others.some((h) => (full(h) || h.match.title === 'prefix') && close(h))) return ambiguous();
      // Another song with the phrase close behind: only when the artist is named too may
      // popularity pick among that artist's own songs ("the wall pink floyd").
      const runnerUp = others[0];
      if (!runnerUp || best.score - runnerUp.score >= 0.5) return ok();
      return best.match.artist !== 'none' && clearlyMorePopular(best, runnerUp) ? ok() : ambiguous();
    }
    const runnerUp = others[0];
    if (!runnerUp) return ok();
    const clear = best.score - runnerUp.score >= 0.5 || clearlyMorePopular(best, runnerUp);
    return clear ? ok() : ambiguous();
  }

  return { entries, search, resolve };
}

/**
 * The artist a result list is "about", if its top hit reads the query as an artist's
 * name (or a word of it) rather than as a title: the name to show as a catalogue
 * heading, and the artist whose songs lead the list. Null for title queries.
 */
export function leadArtist(hits: SearchHit[]): string | null {
  const top = hits[0];
  return top && top.match.artist !== 'none' && top.match.title === 'none' ? top.artist : null;
}
