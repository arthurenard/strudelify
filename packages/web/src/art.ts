/**
 * Cover art lookup for a song: iTunes Search → Deezer → MusicBrainz + Cover Art Archive → Deezer artist
 * picture → deterministic gradient placeholder. Every source is keyless and callable from a browser.
 *
 * The file is split in three layers so the exact same resolution logic runs in the browser and in Node
 * (see tools/art-check.mjs):
 *   - pure matching helpers (normalisation, query variants, fuzzy scoring)      → unit-testable
 *   - `resolveArt(query, adapter)`: the source chain, talks to the network only through an `ArtAdapter`
 *   - adapters: `createFetchAdapter` (Node or browser) / `createBrowserAdapter` (adds JSONP for Deezer),
 *     both wrapped in a `RequestQueue` that spaces requests per host (plus a token bucket that keeps iTunes
 *     under its ~20 requests/min), retries with exponential backoff and puts a host on cool-down after a run of
 *     failures so the chain skips it instead of waiting
 *   - `lookupArt(id, artist, title)`: what the web app calls. Adds the localStorage cache (hits only, never
 *     misses) and supersedes the previous in-flight lookup when the user switches song.
 *
 * Time-to-art is bounded: the track sources share a wall-time budget (`DEFAULT_BUDGET`, 8 s) after which the
 * artist picture or the placeholder is returned; a rate-limited iTunes (403) costs ~1 s before Deezer is asked.
 *
 * Deezer search rows carry no year, size or release type, so the album details (`/album/<id>`: record type,
 * track count, digital release date, album artist, fans) of the best few accepted releases are fetched and
 * merged before ranking – the ranking then sees the same signals as with iTunes and picks "A Night at the
 * Opera" over the "Queen + The Muppets" single. See `enrichDeezer` and `tools/art-check.md`. And because that
 * search shows one row per distinct title (the most-streamed one: on old catalogue the compilation), a hit on a
 * compilation / single / unknown release triggers the album route (`deezerAlbumRoute`): Deezer's album search
 * with a `track:` filter lists every release of the artist that carries the song, so "Arrival" is ranked against
 * "ABBA Gold" instead of never being seen.
 */

// ---------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------

export interface ArtInfo {
  /** Square cover image URL (≥ 500px), or an SVG data URI for the placeholder. */
  art?: string;
  album?: string;
  year?: number;
  /** Which service answered: itunes | itunes-album | deezer | deezer-album | musicbrainz | deezer-artist | placeholder. */
  source?: string;
  /** What `art` shows: the track's release, the artist, or a generated placeholder. */
  kind?: 'track' | 'artist' | 'placeholder';
  /** Artist portrait (Deezer), when one was seen while resolving. */
  artistImage?: string;
  /** Web page of the matched release / artist. */
  sourceUrl?: string;
  /** The names as the source spells them, and the fuzzy match score (debugging / harness). */
  matched?: { artist: string; title: string; score: number };
}

export interface ArtQuery {
  artist: string;
  title: string;
  /** Release year hint (from the database) – nudges the candidate ranking, never required. */
  year?: number;
}

export interface RequestInit2 {
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** Network seam. Implementations must throw `HttpError` for non-2xx responses so retries can classify them. */
export interface ArtAdapter {
  json(url: string, init?: RequestInit2): Promise<unknown>;
  /** JSONP GET (browser only – Deezer sends no CORS headers). Falls back to `json` when absent. */
  jsonp?(url: string, init?: RequestInit2): Promise<unknown>;
  /** Whether an image URL resolves (used for Cover Art Archive probes). */
  imageExists(url: string, init?: RequestInit2): Promise<boolean>;
  /**
   * Milliseconds until the host of `url` accepts requests again after a run of failures (0 = now).
   * The chain skips a cooling host instead of waiting, so a rate-limited iTunes never delays Deezer.
   */
  cooldown?(url: string): number;
}

export interface ArtEvent {
  source: string;
  url: string;
  ms: number;
  ok: boolean;
  status?: number;
  candidates?: number;
  note?: string;
  /** The source was skipped without a request (host cooling down after failures). */
  skipped?: boolean;
}

export interface ResolveOptions {
  signal?: AbortSignal;
  /** Called after every request – the harness uses it for per-source statistics. */
  onEvent?: (e: ArtEvent) => void;
  /** Skip the artist-image fallback (harness "track art only" mode). */
  noArtistFallback?: boolean;
  /**
   * Wall-time budget in ms for the track-art sources (default `DEFAULT_BUDGET`). When it runs out the chain
   * stops searching and returns the artist picture (given `ARTIST_GRACE_MS` more) or the placeholder.
   * `Infinity` disables the cap.
   */
  budget?: number;
  /** Clock (tests). */
  now?: () => number;
}

/** Default wall-time budget for the track-art sources, ms. */
export const DEFAULT_BUDGET = 8000;
/** Extra time granted to the artist-picture fallback once the budget is exhausted, ms. */
export const ARTIST_GRACE_MS = 3000;
/** A host whose cool-down exceeds this is skipped rather than waited for, ms. */
export const SKIP_COOLING_MS = 1500;

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly url: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
  }
}

export function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}
export const isAbort = (e: unknown): boolean => (e as Error | null)?.name === 'AbortError';

// ---------------------------------------------------------------------------------------------------
// Text normalisation and fuzzy matching
// ---------------------------------------------------------------------------------------------------

/** Lower-case, strip diacritics, unify "&"/"and", "Pt."/"Part", "Vol."/"Volume", drop punctuation. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019'`\u00b4]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\bpt\.?\s*(?=[0-9ivx]+\b)/g, 'part ')
    .replace(/\bvol\.?\s*(?=[0-9ivx]+\b)/g, 'volume ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Artist normalisation additionally drops a leading/trailing "the". */
export function normalizeArtist(s: string): string {
  return normalize(s).replace(/^the\s+/, '').replace(/\s+the$/, '').trim();
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const t = ` ${s} `;
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Sørensen–Dice similarity on character bigrams of two already-normalised strings (0..1). */
export function dice(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ga = bigrams(a);
  const gb = bigrams(b);
  let inter = 0;
  let na = 0;
  let nb = 0;
  for (const v of ga.values()) na += v;
  for (const [g, v] of gb) {
    nb += v;
    const x = ga.get(g);
    if (x) inter += Math.min(x, v);
  }
  return (2 * inter) / (na + nb);
}

/** Shared tokens over the longer token list (both normalised) – "teen spirit" is not "smells like teen spirit". */
export function containment(a: string, b: string): number {
  const ta = a.split(' ').filter(Boolean);
  const tb = b.split(' ').filter(Boolean);
  if (!ta.length || !tb.length) return 0;
  const set = new Set(tb);
  let hit = 0;
  for (const t of ta) if (set.has(t)) hit++;
  return hit / Math.max(ta.length, tb.length);
}

/** Blend of bigram similarity and token containment – robust to spelling drift and to appended qualifiers. */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  return 0.6 * dice(a, b) + 0.4 * containment(a, b);
}

/** Best similarity between any of our forms and any of the candidate's forms. */
export function bestSimilarity(ours: string[], theirs: string[]): number {
  let best = 0;
  for (const a of ours) for (const b of theirs) best = Math.max(best, similarity(a, b));
  return best;
}

// ---------------------------------------------------------------------------------------------------
// Query variants
// ---------------------------------------------------------------------------------------------------

const FEAT_PAREN_RE = /\s*[([]\s*(?:feat|ft|featuring|with|duet with|w\/)\.?\s+[^)\]]*[)\]]/gi;
const FEAT_BARE_RE = /\s+(?:feat|ft|featuring)\.?\s+.*$/i;

/** Remove "(feat. X)", "[with X]" groups and bare "feat. X" suffixes. */
export function stripFeatured(s: string): string {
  return s.replace(FEAT_PAREN_RE, '').replace(FEAT_BARE_RE, '').trim();
}

/** Remove every parenthesised / bracketed group. */
export function stripParens(s: string): string {
  return s.replace(/\s*[([][^)\]]*[)\]]/g, '').replace(/\s{2,}/g, ' ').trim();
}

/** Remove trailing ".1", "(2)", " - 3" style duplicate markers coming from file names. */
export function stripDupSuffix(s: string): string {
  return s.replace(/(?:[.#_]\d{1,2}|\s*\(\d{1,2}\)|\s+-\s*\d{1,2})$/, '').trim();
}

function uniq(xs: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of xs) {
    const k = x.trim().toLowerCase();
    if (k && !seen.has(k)) {
      seen.add(k);
      out.push(x.trim());
    }
  }
  return out;
}

/** Search-term spellings of a title, most specific first. */
export function titleVariants(title: string): string[] {
  const t0 = stripDupSuffix(title.trim());
  const noFeat = stripFeatured(t0);
  const noParens = stripParens(noFeat);
  const noDash = noParens.replace(/\s+[-–—]\s+.*$/, '');
  const out = [noParens || noFeat || t0, noFeat, t0, title.trim()];
  if (noDash && noDash !== noParens && noDash.length >= 3) out.push(noDash);
  for (const v of [...out]) {
    if (/\bpart\s+(\d+|[ivx]+)\b/i.test(v)) out.push(v.replace(/\bpart\s+(\d+|[ivx]+)\b/i, 'Pt. $1'));
    if (/\bpt\.?\s*(\d+|[ivx]+)\b/i.test(v)) out.push(v.replace(/\bpt\.?\s*(\d+|[ivx]+)\b/i, 'Part $1'));
    // "Another Brick in the Wall, Part 2" → "Another Brick in the Wall (Part 2)"
    if (/,\s*(part|pt\.?)\s*\w+$/i.test(v)) out.push(v.replace(/,\s*((?:part|pt\.?)\s*\w+)$/i, ' ($1)'));
  }
  return uniq(out);
}

const ARTIST_SPLIT_RE = /\s+(?:feat|ft|featuring|with|vs|versus|and|x)\.?\s+|\s*[&/+,;]\s*/i;

/** Search-term spellings of an artist, most likely first. Handles "Amos, Tori", "Brown James", "Beatles, The". */
export function artistVariants(artist: string): string[] {
  const raw = artist.trim().replace(/\s{2,}/g, ' ');
  const out: string[] = [];
  const commaThe = raw.match(/^(.*),\s*(the|los|las|les|die|der|los)$/i);
  if (commaThe) out.push(`${commaThe[2]} ${commaThe[1]}`);
  const lastFirst = raw.match(/^([^,]+),\s*([^,]+)$/);
  if (lastFirst && !/[&/+]|\b(the|band|orchestra|and|his|her|feat|ft)\b/i.test(raw) && lastFirst[2].trim().split(' ').length <= 2) {
    out.push(`${lastFirst[2].trim()} ${lastFirst[1].trim()}`);
  }
  out.push(raw);
  const words = raw.split(' ');
  if (words.length === 2 && !/[,&/.]/.test(raw) && words.every((w) => /^[A-Za-z'’-]{2,}$/.test(w)) && !/^the$/i.test(words[0])) {
    out.push(`${words[1]} ${words[0]}`); // "Brown James" → "James Brown"
  }
  // Lead artist of "A feat. B", "A & B", "A / B" (computed on the already re-ordered spelling).
  const primary = stripFeatured(out[0]).split(ARTIST_SPLIT_RE)[0]?.trim();
  if (primary && primary.length >= 3 && primary.toLowerCase() !== out[0].toLowerCase()) out.push(primary);
  if (/^the\s+/i.test(raw)) out.push(raw.replace(/^the\s+/i, ''));
  // "Bach Johann Sebastian" / "Hooker John Lee" → "Johann Sebastian Bach" (last resort: a real band name rarely benefits)
  if (words.length === 3 && !/[,&/.]/.test(raw) && words.every((w) => /^[A-Za-z'’-]{2,}$/.test(w)) && !/^(the|los|les|die)$/i.test(words[0])) {
    out.push(`${words[1]} ${words[2]} ${words[0]}`);
  }
  return uniq(out);
}

export interface PreparedQuery extends ArtQuery {
  artistTerms: string[];
  titleTerms: string[];
  /** normalised forms for matching */
  artistForms: string[];
  titleForms: string[];
  /** words that the user's own title contains (so we don't penalise "live" when they asked for a live take) */
  ownFlags: Set<string>;
}

export function prepareQuery(q: ArtQuery): PreparedQuery {
  const artistTerms = artistVariants(q.artist);
  const titleTerms = titleVariants(q.title);
  const own = new Set<string>();
  for (const w of normalize(q.title).split(' ')) own.add(w);
  return {
    ...q,
    artistTerms,
    titleTerms,
    artistForms: uniq(artistTerms.map(normalizeArtist)),
    titleForms: uniq(titleTerms.map(normalize)),
    ownFlags: own,
  };
}

// ---------------------------------------------------------------------------------------------------
// Candidate scoring
// ---------------------------------------------------------------------------------------------------

export interface Candidate {
  artist: string;
  title: string;
  album?: string;
  /** Album-level artist when it differs from the track artist ("Various Artists" → compilation). */
  albumArtist?: string;
  year?: number;
  art?: string;
  artistImage?: string;
  sourceUrl?: string;
  /** Source popularity signal, larger is better (optional). */
  rank?: number;
  /** Release size (iTunes, Deezer album details): a multi-disc or 20+ track release is a box set / compilation, not the original album. */
  discCount?: number;
  trackCount?: number;
  /** Release type as the source classifies it (Deezer `record_type`). */
  recordType?: 'album' | 'single' | 'ep' | 'compile';
  /** Followers of the release (Deezer album `fans`): a grey-market re-upload of an old catalogue has almost none. */
  fans?: number;
  /**
   * What `year` dates: the recording's release (iTunes, MusicBrainz) or the *digital edition* (Deezer, where
   * "A Night at the Opera" is dated 2005). A digital date only tells that a 2020s upload of a 1970s song is a
   * re-release; it never says which release came first.
   */
  yearKind?: 'release' | 'digital';
  /** Source album id (Deezer), for detail look-ups. */
  albumId?: string;
  /** For MusicBrainz: release ids to probe. */
  releases?: string[];
  /** How the candidate was found when not by the source's track search (`album`: Deezer album-with-track search). */
  route?: 'album';
}

export interface Scored {
  cand: Candidate;
  titleSim: number;
  artistSim: number;
  score: number;
  accepted: boolean;
  /** The plain studio recording (no live / demo / alternate-version flag) – the reference for release years. */
  plain: boolean;
  /** On a compilation (by name or by the source's release type): fine, but the original album may be one query away. */
  comp: boolean;
  /** A live, demo or re-arranged take (remix, acoustic, orchestral...): never "good enough" to stop searching. */
  strongAlt: boolean;
}

const BAD_ARTIST_RE = /karaoke|tribute|in the style of|originally performed|made famous|sound-?alike|studio (musicians|group|band|players|orchestra)|hit crew|party (mix|band)|cover (band|crew|team|version)|(?:^|\s)(?:the )?(?:hits?|top 40|chart|singers? unlimited|allstars)\b|kidz bop|8-?bit|lullaby|rockabye|vitamin string|midi|ringtone|piano tribute|orchestra of the|(?:^|\b)ameritz|starlite|the (?:new )?world orchestra/i;
const REJECT_RE = /karaoke|tribute|in the style of|originally performed|made famous|sound-?alike|instrumental version|backing track|ringtone|8-?bit|lullaby|music box|kidz bop|salute to|homage to|a chill ?out|chill ?out salute|lounge version|panpipes?|string quartet|plays the (?:music|hits|songs) of|performs the (?:music|hits|songs) of|(?:music|hits|songs) of .* (?:performed|played) by|as made famous|bossa nova version|reggae version|piano version|orchestral version|for babies|sleep(?:y)? (?:baby|time)/i;
const LIVE_RE = /\blive\b|unplugged|in concert|\bconcert\b|\btour\b|at the bbc|sessions?\b|broadcast|transmission impossible|bootleg|rock in rio|live aid|wembley|budokan|montreux|glastonbury|isle of wight|hollywood bowl|madison square garden|royal albert hall|\b(?:january|february|march|april|june|july|august|september|october|november|december)\s+(?:19|20)\d\d\b|\b\d{1,2}(?:st|nd|rd|th)\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(?:19|20)\d\d\b/i;
/**
 * Alternate versions of the recording. The title side is matched on *normalised* text (hyphens become spaces),
 * so every hyphenated word is written `x[- ]?y`. "Strong" ones are a different recording or arrangement
 * (re-recording, remix, acoustic...), "weak" ones the same recording in another cut (edit, 12" version, mono).
 */
const ALT_STRONG_RE = /\bremix|acoustic|\b(?:spanish|french|german|italian|portuguese|swedish|japanese|dutch|english|espa[nñ]ol|deutsch|italiano|fran[cç]ais)\s+version\b|\bversi[oó]n\s+(?:en\s+)?(?:espa[nñ]ol|castellano)\b|instrumental|alternate|\bdub\b|re[- ]?record|re[- ]?make|re[- ]?made|\bcover\b|orchestral|symphonic|\bdance\b|mega[- ]?mix|medley|mash[- ]?up|non[- ]?stop|\bredux\b|\bre[- ]?imagined\b|\breworked?\b|\bre[- ]?cut\b|\bnew version\b|\b(?:19|20)\d\d version\b/i;
const ALT_WEAK_RE = /\bmix\b|\bedit\b|\bversion\b|\bmono\b|\bstereo\b|extended|\bradio\b/i;
/**
 * Album names are matched against a narrower list: an album may legitimately be called "We Can't Dance" or
 * "Radio K.A.O.S." – only words that describe the whole release as alternate takes count here.
 */
const ALBUM_ALT_RE = /\bremix|acoustic|instrumental|orchestral|symphonic|philharmonic|\borchestra\b|\bsymphony\b|\bunplugged\b|mega[- ]?mix|medley|mash[- ]?up|non[- ]?stop|re[- ]?record|re[- ]?make|re[- ]?made|\bdub\b|\bversions\b|\bmixes\b|\bedits\b|\bre[- ]?imagined\b|\breworked\b/i;
/** Singles carry single artwork; the album version of the same recording is the picture people expect. */
const SINGLE_RE = /\s-\s(?:single|ep)$|\[digital 45\]|\bdigital 45\b|\b(?:7|12)"\s*single\b/i;
/** Demos, outtakes and rehearsals: never the version people mean when they name a song. */
const DEMO_RE = /\bdemos?\b|out[- ]?take|rehearsal|\btakes?\s*\d|\brough\b|early version|work in progress|home recording|private recording|fragment|impromptu|sound[- ]?board|bootleg/i;
const REMASTER_RE = /remaster/i;
/** Deluxe / anniversary reissues carry the same art plus a sticker – the plain edition should win a tie. */
const REISSUE_RE = /deluxe|expanded|anniversary|bonus|super deluxe|special edition|legacy edition|collector|ultimate edition/i;
const COMP_RE = /\bgreatest\b|best of|grandes [eé]xitos|grandi successi|grands succ[eè]s|gr[oö][sß]+ten? erfolge|\b[eé]xitos\b|\bhits\b|collection|\blove songs\b|\bballads\b|anthology|essential|\bgold\b|century masters|millennium|ultimate|definitive|complete|\bsingles\b|\bbox\b|playlist|compilation|very best|cream of|\bnow\b.*that|number ones|#\s?1'?s|number 1'?s|legend|classics|\bicon\b|retrospective|chronicles?|top 40|soundtrack|motion picture|\bost\b|mega[- ]?mix|medley|mash[- ]?up|non[- ]?stop|\bmix\s*(?:[ivx]+|\d+)\b|\bvol(?:ume|\.)?\s*(?:[ivx]+|\d+)\b|\b(?:19|20)\d\d\s*[-–]\s*(?:19|20)?\d\d\b/i;
/** Scripts that a Latin-only query would never contain: a candidate carrying them is a regional/bootleg edition. */
const NON_LATIN_RE = /[\u0370-\u03ff\u0400-\u052f\u0590-\u06ff\u0900-\u0dff\u0e00-\u0e7f\u1100-\u11ff\u3040-\u30ff\u3130-\u318f\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/;

/** "(Bonus Track Version)", "[Deluxe Edition]": reissue qualifiers, not alternate versions of the music. */
const REISSUE_GROUP_RE = /\s*[([][^)\]]*(?:deluxe|expanded|anniversary|bonus|remaster|edition|reissue)[^)\]]*[)\]]/gi;

interface Flags {
  reject: boolean;
  live: boolean;
  /** A different recording / arrangement (title side) or a release of such (album side). */
  altStrong: boolean;
  /** The same recording in another cut: edit, 12" version, mono... (title side only). */
  altWeak: boolean;
  demo: boolean;
  remaster: boolean;
  reissue: boolean;
  comp: boolean;
}

/**
 * Qualifier flags of one text. `title` side: the words the candidate title adds to ours, already normalised
 * (hyphens are spaces there – the patterns above are written for both spellings). `album` side: the raw album
 * name, where "(Bonus Track Version)"-style reissue groups are ignored before looking for alternate versions.
 */
function flagsIn(s: string | undefined, own: Set<string>, side: 'title' | 'album'): Flags {
  const t = s ?? '';
  const core = t.replace(REISSUE_GROUP_RE, '');
  const has = (re: RegExp, word: string) => re.test(t) && !own.has(word);
  const ownAlt = own.has('remix') || own.has('version') || own.has('mix');
  return {
    reject: REJECT_RE.test(t),
    live: has(LIVE_RE, 'live'),
    altStrong: !ownAlt && (side === 'album' ? ALBUM_ALT_RE : ALT_STRONG_RE).test(core),
    altWeak: !ownAlt && side === 'title' && ALT_WEAK_RE.test(core),
    demo: has(DEMO_RE, 'demo'),
    remaster: REMASTER_RE.test(t),
    reissue: REISSUE_RE.test(t),
    comp: COMP_RE.test(t),
  };
}

/** "Bad" on the album "Bad", "The Joker" on "The Joker": the title track of the album that carries the song. */
export function isTitleTrack(title: string, album: string | undefined): boolean {
  if (!album) return false;
  const a = normalize(stripParens(album.replace(/\s+-\s+(?:single|ep)$/i, '')));
  const t = normalize(stripParens(stripFeatured(title)));
  return !!a && a === t;
}

export const ACCEPT = { title: 0.78, artist: 0.66, titleStrong: 0.92, artistWeak: 0.5, artistPrefix: 0.9, prefixSim: 0.85 };

/** Extra words that make a name a *different* act, not a spelling of ours ("Genesis Orchestra", "Abba Stars"). */
const ARTIST_SUFFIX_BAD = new Set(['orchestra', 'band', 'ensemble', 'quartet', 'players', 'singers', 'choir', 'project', 'tribute', 'revival', 'mania', 'kids', 'allstars', 'symphony', 'strings', 'stars', 'covers', 'karaoke', 'machine', 'experience']);

/**
 * "Zero" ↔ "Renato Zero", "Paul Simon" ↔ "Simon & Garfunkel" (lead "simon"): one name's words are a subset of
 * the other's – a short form, a full name or a collaboration. Sharing a word is not enough ("Taylor James" vs
 * "Taylor Swift", "Bob Marley" vs "Ziggy Marley"), and the extra words must not make it another act.
 */
export function isArtistRelated(ours: string[], theirs: string[]): boolean {
  const toks = (s: string) => new Set(s.split(' ').filter((w) => w && w !== 'the' && w !== 'and'));
  for (const a of ours) {
    const ta = toks(a);
    if (!ta.size) continue;
    for (const b of theirs) {
      const tb = toks(b);
      if (!tb.size) continue;
      const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
      let sub = true;
      for (const w of small) if (!big.has(w)) sub = false;
      if (!sub) continue;
      let bad = false;
      for (const w of big) if (!small.has(w) && ARTIST_SUFFIX_BAD.has(w)) bad = true;
      if (!bad) return true;
    }
  }
  return false;
}

/**
 * "Killing Me Softly" → "Killing Me Softly With His Song": the candidate title starts with the whole query
 * title and adds at most four words. With a strong artist match this is the same song under its full name.
 */
export function isTitlePrefix(ours: string[], theirs: string[]): boolean {
  for (const a of ours) {
    const na = a.split(' ').filter(Boolean).length;
    if (na < 2) continue;
    for (const b of theirs) {
      if (b.length > a.length && b.startsWith(a + ' ')) {
        const extra = b.slice(a.length).split(' ').filter(Boolean).length;
        if (extra <= 4) return true;
      }
    }
  }
  return false;
}

/**
 * "Celtic Pink Floyd", "Australian Pink Floyd Show", "Vitamin String Quartet Pink Floyd": a candidate artist that
 * wraps our whole artist name in extra words is a tribute act, unless the extra words are a collaboration
 * ("Ike & Tina Turner" for "Tina Turner", "Prince with Sheena Easton") or a suffix ("The Jimi Hendrix Experience").
 */
export function isTributeWrap(ours: string[], theirs: string[]): boolean {
  for (const a of ours) {
    if (a.split(' ').length < 2) continue;
    for (const b of theirs) {
      const at = b.indexOf(' ' + a);
      if (at <= 0) continue;
      const prefix = b.slice(0, at).trim();
      if (!prefix || /\b(and|with|feat|featuring|vs|versus|x|meets|presents)$/.test(prefix)) continue;
      if (b === a || new RegExp(`(^|\\s)${a}(\\s|$)`).test(b)) return true;
    }
  }
  return false;
}

/** Candidate name forms: full and with qualifiers stripped, normalised. */
function candTitleForms(title: string): string[] {
  return uniq([normalize(stripParens(stripFeatured(title))), normalize(title), normalize(title.replace(/\s+[-–—]\s+.*$/, ''))]);
}
function candArtistForms(artist: string): string[] {
  const primary = stripFeatured(artist).split(ARTIST_SPLIT_RE)[0] ?? artist;
  return uniq([normalizeArtist(artist), normalizeArtist(primary)]);
}

export interface ScoreContext {
  /** Highest `rank` among the candidates of the same response (Deezer): a track far below it is an obscure release. */
  maxRank?: number;
  /** Highest `fans` among the candidates' releases (Deezer album details): a release with almost none is a re-upload. */
  maxFans?: number;
  /**
   * Earliest release year among the plain, accepted candidates of the same response: the original release of
   * the song. Later releases of the same recording (a 2022 re-recording album, a 2012 compilation) are
   * penalised in proportion to the gap, whatever they are called.
   */
  minYear?: number;
}

/** Score one candidate against the query. `accepted` means "this really is the right song". */
export function scoreCandidate(q: PreparedQuery, c: Candidate, ctx: ScoreContext = {}): Scored {
  const candTitles = candTitleForms(c.title);
  const candArtists = candArtistForms(c.artist);
  let titleSim = bestSimilarity(q.titleForms, candTitles);
  let artistSim = bestSimilarity(q.artistForms, candArtists);
  if (BAD_ARTIST_RE.test(c.artist)) artistSim = 0;
  else if (artistSim < 1 && isTributeWrap(q.artistForms, candArtists)) artistSim = Math.min(artistSim, ACCEPT.artistWeak - 0.05);
  if (titleSim < ACCEPT.prefixSim && artistSim >= ACCEPT.artistPrefix && isTitlePrefix(q.titleForms, candTitles)) titleSim = ACCEPT.prefixSim;
  const accepted =
    (titleSim >= ACCEPT.title && artistSim >= ACCEPT.artist) ||
    (titleSim >= ACCEPT.titleStrong && artistSim >= ACCEPT.artistWeak && isArtistRelated(q.artistForms, candArtists));
  let score = titleSim + artistSim;
  // Qualifiers on the candidate side that our own title does not carry.
  const ownStripped = normalize(stripParens(q.title));
  const extraTitle = normalize(c.title).replace(ownStripped, '');
  const ft = flagsIn(extraTitle, q.ownFlags, 'title');
  const fa = flagsIn(c.album, q.ownFlags, 'album');
  // A single / EP (iTunes names them, Deezer classifies them, or a release of ≤ 4 tracks) carries single artwork.
  const single = !!c.album && (SINGLE_RE.test(c.album) || (c.trackCount ?? 99) <= 4 || c.recordType === 'single' || c.recordType === 'ep');
  if (c.recordType === 'compile') fa.comp = true;
  // Only a release known to be a real album can be "the album that carries the song": without a track count
  // (Deezer search rows) an album named like the track is far more likely a single.
  const realAlbum = (c.trackCount ?? 0) >= 5 || (c.recordType === 'album' && c.trackCount === undefined);
  if (ft.reject || fa.reject) score -= 1.5;
  if (ft.live || fa.live) score -= 0.35;
  if (ft.demo || fa.demo) score -= 0.5;
  else if (ft.altStrong) score -= 0.25;
  else if (ft.altWeak) score -= 0.12;
  // "Born To Be Alive (The Remixes)": a release of alternate takes, whatever the track is called on it.
  if (fa.altStrong && !fa.comp) score -= 0.15;
  // A remaster shows the same art: the plain edition wins a tie, nothing more (the compilation next to it
  // must not profit from the "(2012 Remaster)" tag on the real album's tracks).
  if (ft.remaster || fa.remaster) score -= 0.005;
  if (fa.reissue) score -= 0.03;
  if (fa.comp) score -= 0.12;
  if (single) score -= 0.05;
  // "Bad" on Bad, "The Joker" on The Joker: the album that carries the song as its title track.
  else if (realAlbum && !fa.comp && !fa.altStrong && !ft.live && !fa.live && isTitleTrack(c.title, c.album)) score += 0.05;
  // Box sets and big compilations keep the track's original release date on iTunes, so size is a tell.
  // Discs: a double album (The Wall) is a normal studio release, three discs is suspicious (the White Album
  // ships as three on iTunes, so only a nudge), four or more is a box set. Track counts grow from the 9–14 of a
  // studio album to the 15–30 of a compilation: -0.012 per track above 14, at most -0.12.
  const discs = c.discCount ?? 1;
  if (discs >= 4) score -= 0.12;
  else if (discs === 3) score -= 0.06;
  const tracks = c.trackCount ?? 0;
  if (tracks >= 15) score -= Math.min(0.12, 0.012 * (tracks - 14));
  // Regional / bootleg editions: "Killing Me Softly 情歌醉我心" on "Top High Megamix" when we asked in Latin script.
  if (NON_LATIN_RE.test(`${c.title} ${c.album ?? ''}`) && !NON_LATIN_RE.test(`${q.title} ${q.artist}`)) score -= 0.3;
  // The album belongs to someone else: a Various Artists compilation (-0.2), another act (-0.1), or a related
  // credit – "Bruce Hornsby" for a "Bruce Hornsby & The Range" track, "Queen + The Muppets" for Queen (-0.02).
  if (c.albumArtist && normalizeArtist(c.albumArtist) !== normalizeArtist(c.artist)) {
    if (/various|varios|v[aá]rios|verschiedene|artisti vari|divers|soundtrack|original cast|^v\.?a\.?$/i.test(c.albumArtist)) score -= 0.2;
    else if (isArtistRelated(candArtistForms(c.albumArtist), candArtists)) score -= 0.02;
    else score -= 0.1;
  }
  // Prefer the original release: gently penalise later years, reward a match with the database year, and
  // penalise a release that is years younger than the earliest one seen for the song (`ctx.minYear`).
  // A remaster / anniversary edition is dated by its reissue, not by the recording: it counts as the original.
  let year = c.year && c.year >= 1900 ? c.year : undefined;
  if (c.yearKind === 'digital') {
    // A digital-edition date: it matches the database year when the edition is the original release (+0.1), and a
    // streaming-era upload of a song more than 20 years older is a re-release / grey-market catalogue (-0.08).
    // It says nothing about which release came first, so no ordering penalties.
    if (year && q.year) {
      if (Math.abs(year - q.year) <= 1) score += 0.1;
      else if (year >= 2015 && year - q.year > 20) score -= 0.08;
    }
  } else {
    if (year && ctx.minYear && year > ctx.minYear && (fa.reissue || fa.remaster || ft.remaster)) year = ctx.minYear;
    if (year && c.year) {
      score -= Math.max(0, year - 1950) * 0.002;
      if (q.year && (Math.abs(year - q.year) <= 1 || Math.abs(c.year - q.year) <= 1)) score += 0.1;
      if (ctx.minYear && year > ctx.minYear) score -= Math.min(0.15, 0.004 * (year - ctx.minYear));
    }
  }
  // Sources without release years (Deezer) still tell popularity: the original album track is streamed far more
  // than a bootleg, a single re-issue or a regional reissue of the same recording – the most-streamed accepted
  // studio candidate is the picture people know. Weighted enough (0.15) to beat the small release nudges above.
  // Deezer's search shows one row per distinct title, the most-streamed one – on old catalogue that is nearly
  // always the compilation ("ABBA Gold"), so a compilation earns only half of the popularity bonus: the original
  // album found by the album route (`deezerAlbumRoute`) must be able to overtake it.
  if (typeof c.rank === 'number' && ctx.maxRank) {
    const rel = c.rank / ctx.maxRank;
    score += (fa.comp ? 0.075 : 0.15) * Math.min(1, rel);
    if (rel < 0.1) score -= 0.15;
  }
  // A release that almost nobody follows next to one that thousands do: a re-upload ("Guitar Man" by an "SPS"
  // label with 64 fans against The Best of Bread's 21,000), whatever it is called.
  if (typeof c.fans === 'number' && ctx.maxFans && ctx.maxFans >= 200 && c.fans / ctx.maxFans < 0.05) score -= 0.1;
  if (!c.art) score -= 2; // useless without artwork
  const strongAlt = ft.live || fa.live || ft.demo || fa.demo || ft.altStrong || fa.altStrong;
  const plain = !strongAlt && !ft.altWeak;
  return { cand: c, titleSim, artistSim, score, accepted, plain, comp: fa.comp, strongAlt };
}

/**
 * Best accepted candidate with artwork, or null. Two passes: the first finds the earliest release year among
 * the plain accepted candidates (the original release), the second ranks everything against it.
 */
export function pickBest(q: PreparedQuery, cands: Candidate[]): Scored | null {
  let maxRank = 0;
  let maxFans = 0;
  for (const c of cands) {
    if (typeof c.rank === 'number' && c.rank > maxRank) maxRank = c.rank;
    if (typeof c.fans === 'number' && c.fans > maxFans) maxFans = c.fans;
  }
  const ctx: ScoreContext = {};
  if (maxRank) ctx.maxRank = maxRank;
  if (maxFans) ctx.maxFans = maxFans;
  const withArt = cands.filter((c) => c.art);
  let minYear: number | undefined;
  for (const c of withArt) {
    if (!c.year || c.year < 1900 || c.yearKind === 'digital') continue;
    const s = scoreCandidate(q, c, ctx);
    if (s.accepted && s.plain && (minYear === undefined || c.year < minYear)) minYear = c.year;
  }
  if (minYear) ctx.minYear = minYear;
  let best: Scored | null = null;
  for (const c of withArt) {
    const s = scoreCandidate(q, c, ctx);
    if (!s.accepted) continue;
    if (!best || s.score > best.score || (s.score === best.score && (c.rank ?? 0) > (best.cand.rank ?? 0))) best = s;
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------
// Request queue: per-host spacing, exponential backoff, cancellation
// ---------------------------------------------------------------------------------------------------

export interface HostPolicy {
  /** Minimum ms between two request starts on the host. */
  gap?: number;
  /** Retries of one request before giving up on it (0 = none). */
  maxRetries?: number;
  /** First retry delay, doubled on every further attempt. */
  baseDelay?: number;
  /** Lane cool-down once a request has exhausted its retries; doubles with each consecutive failure. */
  cooldown?: number;
  /**
   * Token bucket on top of the spacing: at most `burst` requests at once, refilled at `perMinute`. Keeps a user
   * flipping through uncached songs under the host's published limit (iTunes: ~20/min) instead of tripping a
   * 403 and losing the host for a cool-down. Off when `perMinute` is unset.
   */
  burst?: number;
  perMinute?: number;
}

export interface QueueOptions extends HostPolicy {
  /** @deprecated use `hostPolicy` – kept for callers that only tune the spacing. */
  hostGap?: Record<string, number>;
  hostPolicy?: Record<string, HostPolicy>;
  /** Cap for one retry delay. */
  maxDelay?: number;
  /** Cap for a lane cool-down. */
  maxCooldown?: number;
  jitter?: boolean;
  onRetry?: (info: { host: string; attempt: number; delay: number; error: unknown }) => void;
  /** Called when a request gave up and the lane was put on cool-down. */
  onCooldown?: (info: { host: string; streak: number; ms: number; error: unknown }) => void;
  /** Called when an attempt starts, with the ms the job spent waiting for its lane (spacing, back-off, queue). */
  onStart?: (info: { host: string; url: string; attempt: number; waited: number }) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

/**
 * Per-host tuning. iTunes answers 403 the moment ~20 requests/min are exceeded, and keeps doing so for a
 * while: a token bucket (6 at once, then one every 3 s) keeps a browser session under that limit – the first
 * songs of a session pay nothing, a fast flipper waits ≤ 3 s, well inside the budget – and, should a 403 still
 * come, one quick retry, then a long cool-down that lets the chain move on to Deezer immediately.
 * MusicBrainz asks for ≤ 1 request/s and returns transient 503s.
 */
export const DEFAULT_HOST_POLICY: Record<string, HostPolicy> = {
  'itunes.apple.com': { gap: 350, burst: 6, perMinute: 20, maxRetries: 1, baseDelay: 1000, cooldown: 20_000 },
  'api.deezer.com': { gap: 200, maxRetries: 2, baseDelay: 800, cooldown: 10_000 },
  'musicbrainz.org': { gap: 1100, maxRetries: 2, baseDelay: 1500, cooldown: 15_000 },
  'coverartarchive.org': { gap: 350, maxRetries: 1, baseDelay: 1000, cooldown: 10_000 },
};

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(abortError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function isRetryable(e: unknown): boolean {
  if (isAbort(e)) return false;
  if (e instanceof HttpError) return e.status === 403 || e.status === 408 || e.status === 425 || e.status === 429 || e.status >= 500;
  return true; // network / JSONP timeout / CORS failure
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

interface Lane {
  tail: Promise<void>;
  lastStart: number;
  /** Earliest next start: retry back-off or cool-down after a run of failures. */
  notBefore: number;
  /** Consecutive requests that exhausted their retries (reset by any success). */
  streak: number;
  /** Token bucket state (only used when the host policy sets `perMinute`). */
  tokens: number;
  refilled: number;
}

export class RequestQueue {
  private lanes = new Map<string, Lane>();
  private readonly o: Required<Omit<QueueOptions, 'onRetry' | 'onCooldown' | 'onStart' | 'hostGap' | 'hostPolicy'>> & Pick<QueueOptions, 'onRetry' | 'onCooldown' | 'onStart'>;
  private readonly policy: Record<string, HostPolicy>;
  constructor(opts: QueueOptions = {}) {
    this.o = {
      gap: opts.gap ?? 350,
      maxRetries: opts.maxRetries ?? 2,
      baseDelay: opts.baseDelay ?? 1000,
      cooldown: opts.cooldown ?? 15_000,
      burst: opts.burst ?? 1,
      perMinute: opts.perMinute ?? 0,
      maxDelay: opts.maxDelay ?? 30_000,
      maxCooldown: opts.maxCooldown ?? 120_000,
      jitter: opts.jitter ?? true,
      sleep: opts.sleep ?? sleep,
      now: opts.now ?? (() => Date.now()),
      onRetry: opts.onRetry,
      onCooldown: opts.onCooldown,
      onStart: opts.onStart,
    };
    this.policy = { ...(opts.hostPolicy ?? {}) };
    for (const [h, gap] of Object.entries(opts.hostGap ?? {})) this.policy[h] = { ...this.policy[h], gap };
  }

  private lane(host: string): Lane {
    let l = this.lanes.get(host);
    if (!l) {
      l = { tail: Promise.resolve(), lastStart: -Infinity, notBefore: 0, streak: 0, tokens: Infinity, refilled: this.o.now() };
      this.lanes.set(host, l);
    }
    return l;
  }

  private policyFor(host: string): Required<HostPolicy> {
    const p = this.policy[host] ?? {};
    return {
      gap: p.gap ?? this.o.gap,
      maxRetries: p.maxRetries ?? this.o.maxRetries,
      baseDelay: p.baseDelay ?? this.o.baseDelay,
      cooldown: p.cooldown ?? this.o.cooldown,
      burst: Math.max(1, p.burst ?? this.o.burst),
      perMinute: p.perMinute ?? this.o.perMinute,
    };
  }

  /** Refill the lane's token bucket and return the earliest time a token is available (0 = now). */
  private tokenReady(lane: Lane, p: Required<HostPolicy>): number {
    if (!p.perMinute) return 0;
    const now = this.o.now();
    const rate = p.perMinute / 60_000; // tokens per ms
    lane.tokens = Math.min(p.burst, lane.tokens + (now - lane.refilled) * rate);
    lane.refilled = now;
    return lane.tokens >= 1 ? 0 : now + Math.ceil((1 - lane.tokens) / rate);
  }

  /** Ms a request on the host of `url` would wait for its token bucket right now (0 = none; spacing not included). */
  bucketWait(url: string): number {
    const host = hostOf(url);
    const p = this.policyFor(host);
    if (!p.perMinute) return 0;
    return Math.max(0, this.tokenReady(this.lane(host), p) - this.o.now());
  }

  private jitter(ms: number): number {
    return this.o.jitter ? Math.round(ms * (0.8 + Math.random() * 0.4)) : ms;
  }

  /** Ms until the host of `url` is out of its failure cool-down / retry back-off (0 when it is usable now). */
  cooldown(url: string): number {
    const lane = this.lanes.get(hostOf(url));
    return lane ? Math.max(0, lane.notBefore - this.o.now()) : 0;
  }

  /** Run `fn` when its host lane is free. Aborted jobs are skipped without consuming a slot. */
  run<T>(url: string, fn: (attempt: number) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const host = hostOf(url);
    const lane = this.lane(host);
    const p = this.policyFor(host);
    const enqueued = this.o.now();
    const job = lane.tail.then(async () => {
      if (signal?.aborted) throw abortError();
      for (let attempt = 0; ; attempt++) {
        const wait = Math.max(lane.lastStart + p.gap, lane.notBefore, this.tokenReady(lane, p)) - this.o.now();
        if (wait > 0) await this.o.sleep(wait, signal);
        if (signal?.aborted) throw abortError(); // never consumed a token: the next job gets it
        this.tokenReady(lane, p);
        if (p.perMinute) lane.tokens -= 1;
        lane.lastStart = this.o.now();
        this.o.onStart?.({ host, url, attempt, waited: attempt === 0 ? lane.lastStart - enqueued : Math.max(0, wait) });
        try {
          const v = await fn(attempt);
          lane.streak = 0;
          return v;
        } catch (e) {
          if (!isRetryable(e)) throw e;
          if (attempt >= p.maxRetries) {
            // Give up on this request and put the lane on cool-down so the chain (and later lookups) skip
            // the host instead of queueing behind more failures.
            lane.streak++;
            const ms = this.jitter(Math.min(this.o.maxCooldown, p.cooldown * 2 ** (lane.streak - 1)));
            lane.notBefore = this.o.now() + ms;
            this.o.onCooldown?.({ host, streak: lane.streak, ms, error: e });
            throw e;
          }
          const delay = this.jitter(Math.min(this.o.maxDelay, p.baseDelay * 2 ** attempt));
          // Stored on the lane so that later jobs (even after this one is cancelled) respect it.
          lane.notBefore = this.o.now() + delay;
          this.o.onRetry?.({ host, attempt, delay, error: e });
        }
      }
    });
    lane.tail = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  }
}

// ---------------------------------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------------------------------

export interface FetchAdapterOptions {
  fetch?: typeof fetch;
  queue?: RequestQueue;
  /** Sent to MusicBrainz (they ask for one). Ignored by browsers (forbidden header). */
  userAgent?: string;
  /** Per-request timeout in ms. */
  timeout?: number;
}

/** Per-request timeout: shorter than the resolution budget, so one hung host cannot eat the whole budget. */
export const REQUEST_TIMEOUT = 7000;

export function defaultQueue(): RequestQueue {
  return new RequestQueue({ hostPolicy: DEFAULT_HOST_POLICY });
}

/**
 * Per-request timeout. Besides aborting the controller it also rejects `expired`, so a request is raced against
 * it: a fetch implementation that fails to honour an abort (seen with Node's undici on a stalled keep-alive
 * socket, which then leaves the event loop with nothing to wait on) can no longer hang the chain.
 */
function withTimeout(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; expired: Promise<never>; done: () => void } {
  const ctrl = new AbortController();
  let expire: (e: Error) => void = () => {};
  const expired = new Promise<never>((_, reject) => {
    expire = reject;
  });
  expired.catch(() => {}); // not every request awaits it
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) ctrl.abort();
  const t = setTimeout(() => {
    ctrl.abort();
    expire(new Error(`timeout after ${ms}ms`));
  }, ms);
  return {
    signal: ctrl.signal,
    expired,
    done: () => {
      clearTimeout(t);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

/** Adapter for any runtime with `fetch` (Node ≥ 18, browsers). Deezer goes through plain JSON here. */
export function createFetchAdapter(opts: FetchAdapterOptions = {}): ArtAdapter {
  const f = opts.fetch ?? globalThis.fetch;
  const queue = opts.queue ?? defaultQueue();
  const timeout = opts.timeout ?? REQUEST_TIMEOUT;
  const baseHeaders: Record<string, string> = { Accept: 'application/json' };
  if (opts.userAgent) baseHeaders['User-Agent'] = opts.userAgent;
  return {
    cooldown: (url) => queue.cooldown(url),
    json(url, init) {
      return queue.run(
        url,
        async () => {
          const t = withTimeout(init?.signal, timeout);
          try {
            const res = await Promise.race([f(url, { headers: { ...baseHeaders, ...init?.headers }, signal: t.signal }), t.expired]);
            if (!res.ok) throw new HttpError(res.status, url);
            return (await Promise.race([res.json(), t.expired])) as unknown;
          } catch (e) {
            if (init?.signal?.aborted) throw abortError();
            throw e;
          } finally {
            t.done();
          }
        },
        init?.signal,
      );
    },
    imageExists(url, init) {
      return queue.run(
        url,
        async () => {
          const t = withTimeout(init?.signal, timeout);
          try {
            const res = await Promise.race([f(url, { method: 'HEAD', redirect: 'manual', signal: t.signal }), t.expired]);
            if (res.status === 404 || res.status === 400) return false;
            if (res.status >= 500 || res.status === 429 || res.status === 403) throw new HttpError(res.status, url);
            return res.status < 400;
          } catch (e) {
            if (init?.signal?.aborted) throw abortError();
            throw e;
          } finally {
            t.done();
          }
        },
        init?.signal,
      );
    },
  };
}

let jsonpCounter = 0;

/** Browser adapter: fetch for CORS-enabled services, JSONP for Deezer, `Image()` probes for CAA. */
export function createBrowserAdapter(opts: FetchAdapterOptions = {}): ArtAdapter {
  const queue = opts.queue ?? defaultQueue();
  const base = createFetchAdapter({ ...opts, queue });
  const timeout = opts.timeout ?? REQUEST_TIMEOUT;
  return {
    json: base.json,
    cooldown: base.cooldown,
    jsonp(url, init) {
      return queue.run(
        url,
        () =>
          new Promise((resolve, reject) => {
            const name = `__strudelifyArt${++jsonpCounter}`;
            const w = window as unknown as Record<string, unknown>;
            const script = document.createElement('script');
            const cleanup = () => {
              delete w[name];
              script.remove();
              clearTimeout(timer);
              init?.signal?.removeEventListener('abort', onAbort);
            };
            const onAbort = () => {
              cleanup();
              reject(abortError());
            };
            const timer = setTimeout(() => {
              cleanup();
              reject(new Error(`jsonp timeout ${url}`));
            }, timeout);
            w[name] = (data: unknown) => {
              cleanup();
              resolve(data);
            };
            script.onerror = () => {
              cleanup();
              reject(new Error(`jsonp failed ${url}`));
            };
            init?.signal?.addEventListener('abort', onAbort, { once: true });
            script.src = `${url}${url.includes('?') ? '&' : '?'}output=jsonp&callback=${name}`;
            document.head.appendChild(script);
          }),
        init?.signal,
      );
    },
    imageExists(url, init) {
      return queue.run(
        url,
        () =>
          new Promise<boolean>((resolve, reject) => {
            if (init?.signal?.aborted) return reject(abortError());
            const img = new Image();
            const cleanup = () => {
              clearTimeout(timer);
              init?.signal?.removeEventListener('abort', onAbort);
              img.onload = img.onerror = null;
            };
            // Superseded lookup: drop the probe now instead of letting it run to the timeout.
            const onAbort = () => {
              cleanup();
              img.src = '';
              reject(abortError());
            };
            const timer = setTimeout(() => {
              cleanup();
              img.src = '';
              resolve(false);
            }, timeout);
            img.onload = () => {
              cleanup();
              resolve(img.naturalWidth > 1);
            };
            img.onerror = () => {
              cleanup();
              resolve(false);
            };
            init?.signal?.addEventListener('abort', onAbort, { once: true });
            img.src = url;
          }),
        init?.signal,
      );
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------------------------------

type Rec = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const yearOf = (v: unknown): number | undefined => {
  const m = str(v).match(/^\d{4}/);
  return m ? Number(m[0]) : undefined;
};

/** Deezer returns a placeholder URL with an empty hash when an item has no picture. */
export function deezerImage(url: unknown): string | undefined {
  const u = str(url);
  return /\/images\/(?:cover|artist|playlist)\/[0-9a-f]{8,}\//i.test(u) ? u : undefined;
}

/**
 * Upgrade an iTunes thumbnail to `size` px. The `cc` variant centre-crops to an exact square (`bb` keeps the
 * source aspect: Madonna's Like a Virgin comes back 600x595 with it).
 */
export function itunesImage(url: unknown, size = 600): string | undefined {
  const u = str(url);
  return u ? u.replace(/\/\d+x\d+(bb|cc|-999)?\./, `/${size}x${size}cc.`) : undefined;
}

/** Resolution context: `signal` is the combined user+deadline signal, `user` the caller's own one. */
export interface ResolveContext extends ResolveOptions {
  user?: AbortSignal;
}
type Ctx = ResolveContext;

async function timed<T>(source: string, url: string, opts: Ctx, fn: () => Promise<T>, count: (v: T) => number): Promise<T | null> {
  const t0 = Date.now();
  try {
    const v = await fn();
    opts.onEvent?.({ source, url, ms: Date.now() - t0, ok: true, candidates: count(v) });
    return v;
  } catch (e) {
    if (isAbort(e)) {
      // The caller gave up → propagate. The budget ran out → just a failed source, the chain falls back.
      if (opts.user?.aborted || !opts.signal?.aborted) throw e;
      opts.onEvent?.({ source, url, ms: Date.now() - t0, ok: false, note: 'budget exhausted' });
      return null;
    }
    opts.onEvent?.({ source, url, ms: Date.now() - t0, ok: false, status: e instanceof HttpError ? e.status : undefined, note: String((e as Error)?.message ?? e) });
    return null;
  }
}

async function itunesSongs(q: PreparedQuery, adapter: ArtAdapter, opts: Ctx, term: string, entity: 'song' | 'album', country = 'us'): Promise<Candidate[]> {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=${entity}&limit=25&country=${country}`;
  const data = (await timed(`itunes-${entity}`, url, opts, () => adapter.json(url, { signal: opts.signal }), (d) => ((d as Rec)?.results as unknown[])?.length ?? 0)) as Rec | null;
  const results = (data?.results as Rec[] | undefined) ?? [];
  return results.map((r) =>
    entity === 'song'
      ? {
          artist: str(r.artistName),
          title: str(r.trackName),
          album: str(r.collectionName),
          albumArtist: str(r.collectionArtistName) || undefined,
          year: yearOf(r.releaseDate),
          art: itunesImage(r.artworkUrl100),
          sourceUrl: str(r.trackViewUrl) || str(r.collectionViewUrl) || undefined,
          discCount: typeof r.discCount === 'number' ? r.discCount : undefined,
          trackCount: typeof r.trackCount === 'number' ? r.trackCount : undefined,
        }
      : {
          artist: str(r.artistName),
          title: str(r.collectionName).replace(/\s+-\s+(single|ep)$/i, ''),
          album: str(r.collectionName),
          year: yearOf(r.releaseDate),
          art: itunesImage(r.artworkUrl100),
          sourceUrl: str(r.collectionViewUrl) || undefined,
          trackCount: typeof r.trackCount === 'number' ? r.trackCount : undefined,
        },
  );
}

async function deezerGet(adapter: ArtAdapter, url: string, opts: Ctx): Promise<unknown> {
  return adapter.jsonp ? adapter.jsonp(url, { signal: opts.signal }) : adapter.json(url, { signal: opts.signal });
}

async function deezerTracks(q: PreparedQuery, adapter: ArtAdapter, opts: Ctx, query: string): Promise<Candidate[]> {
  const url = `https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=25`;
  const data = (await timed('deezer', url, opts, () => deezerGet(adapter, url, opts), (d) => ((d as Rec)?.data as unknown[])?.length ?? 0)) as Rec | null;
  const rows = (data?.data as Rec[] | undefined) ?? [];
  return rows.map((r) => {
    const album = r.album as Rec | undefined;
    const artist = r.artist as Rec | undefined;
    return {
      artist: str(artist?.name),
      title: str(r.title),
      album: str(album?.title),
      albumId: album?.id !== undefined && album?.id !== null ? String(album.id) : undefined,
      art: deezerImage(album?.cover_xl) ?? deezerImage(album?.cover_big),
      artistImage: deezerImage(artist?.picture_xl) ?? deezerImage(artist?.picture_big),
      sourceUrl: str(r.link) || undefined,
      rank: typeof r.rank === 'number' ? r.rank : undefined,
    };
  });
}

/** What Deezer's album endpoint adds to a search row. `null` = looked up, nothing usable. */
export interface DeezerAlbumDetails {
  year?: number;
  trackCount?: number;
  recordType?: Candidate['recordType'];
  albumArtist?: string;
  fans?: number;
  art?: string;
  /** The first 25 tracks of the release (title, credited artist, popularity rank). */
  tracks?: { title: string; artist: string; rank?: number }[];
}
export type DeezerAlbumCache = Map<string, DeezerAlbumDetails | null>;

/** How many distinct releases of one Deezer response are looked up in detail (≈ 250 ms each). */
export const MAX_DEEZER_ALBUM_LOOKUPS = 3;

async function deezerAlbum(adapter: ArtAdapter, opts: Ctx, id: string): Promise<DeezerAlbumDetails | null> {
  const url = `https://api.deezer.com/album/${encodeURIComponent(id)}`;
  const a = (await timed('deezer-album', url, opts, () => deezerGet(adapter, url, opts), (d) => ((d as Rec)?.id ? 1 : 0))) as Rec | null;
  if (!a || !a.id) return null;
  const rt = str(a.record_type).toLowerCase();
  const artist = a.artist as Rec | undefined;
  const rows = ((a.tracks as Rec | undefined)?.data as Rec[] | undefined) ?? [];
  const tracks = rows
    .map((t) => ({ title: str(t.title), artist: str((t.artist as Rec | undefined)?.name), rank: typeof t.rank === 'number' ? t.rank : undefined }))
    .filter((t) => t.title);
  return {
    year: yearOf(a.release_date),
    trackCount: typeof a.nb_tracks === 'number' ? a.nb_tracks : undefined,
    recordType: rt === 'album' || rt === 'single' || rt === 'ep' || rt === 'compile' ? rt : undefined,
    albumArtist: str(artist?.name) || undefined,
    fans: typeof a.fans === 'number' ? a.fans : undefined,
    art: deezerImage(a.cover_xl) ?? deezerImage(a.cover_big),
    tracks: tracks.length ? tracks : undefined,
  };
}

/**
 * Deezer search rows carry no year, size or type, so "Bohemian Rhapsody" (the Muppets single) and "A Night at
 * the Opera" look alike. Look up the album details of the best few accepted releases and merge them into the
 * candidates (mutated in place) so the ranking sees the same signals as with iTunes.
 */
export async function enrichDeezer(q: PreparedQuery, cands: Candidate[], adapter: ArtAdapter, opts: Ctx, cache: DeezerAlbumCache, max = MAX_DEEZER_ALBUM_LOOKUPS, overBudget: () => boolean = () => false): Promise<void> {
  let maxRank = 0;
  for (const c of cands) if (typeof c.rank === 'number' && c.rank > maxRank) maxRank = c.rank;
  const ctx: ScoreContext = maxRank ? { maxRank } : {};
  const byAlbum = new Map<string, number>();
  for (const c of cands) {
    if (!c.art || !c.albumId) continue;
    const s = scoreCandidate(q, c, ctx);
    if (!s.accepted || s.score < 1) continue;
    byAlbum.set(c.albumId, Math.max(byAlbum.get(c.albumId) ?? -Infinity, s.score));
  }
  if (!byAlbum.size) return;
  const ids = [...byAlbum.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  for (const id of ids.slice(0, max)) {
    if (opts.signal?.aborted || overBudget()) break;
    if (!cache.has(id)) cache.set(id, await deezerAlbum(adapter, opts, id));
  }
  for (const c of cands) {
    const d = c.albumId ? cache.get(c.albumId) : undefined;
    if (!d) continue;
    if (d.year) {
      c.year = d.year;
      c.yearKind = 'digital';
    }
    if (d.trackCount !== undefined) c.trackCount = d.trackCount;
    if (d.recordType) c.recordType = d.recordType;
    if (d.albumArtist) c.albumArtist = d.albumArtist;
    if (d.fans !== undefined) c.fans = d.fans;
  }
}

/** One row of Deezer's album search. */
export interface AlbumRow {
  id: string;
  title: string;
  /** Album artist as Deezer credits the release ("Various Artists" for a compilation of several acts). */
  artist: string;
  art?: string;
  trackCount?: number;
  recordType?: Candidate['recordType'];
  sourceUrl?: string;
}

/**
 * Deezer's album search accepts a `track:` filter and then lists *every* release of the artist that carries a
 * track of that name – the plain track search shows only the most-streamed row per distinct title, which on old
 * catalogue is the compilation ("Dancing Queen" is only ever found on ABBA Gold; with the filter, Arrival is
 * listed next to it). One request, no CORS issue (JSONP in the browser).
 */
async function deezerAlbumsWithTrack(adapter: ArtAdapter, opts: Ctx, artist: string, title: string): Promise<AlbumRow[]> {
  const url = `https://api.deezer.com/search/album?q=${encodeURIComponent(`artist:"${artist}" track:"${title}"`)}&limit=25`;
  const data = (await timed('deezer-album-search', url, opts, () => deezerGet(adapter, url, opts), (d) => ((d as Rec)?.data as unknown[])?.length ?? 0)) as Rec | null;
  const rows = (data?.data as Rec[] | undefined) ?? [];
  return rows
    .map((r) => {
      const rt = str(r.record_type).toLowerCase();
      return {
        id: r.id !== undefined && r.id !== null ? String(r.id) : '',
        title: str(r.title),
        artist: str((r.artist as Rec | undefined)?.name),
        art: deezerImage(r.cover_xl) ?? deezerImage(r.cover_big),
        trackCount: typeof r.nb_tracks === 'number' ? r.nb_tracks : undefined,
        recordType: rt === 'album' || rt === 'single' || rt === 'ep' || rt === 'compile' ? (rt as Candidate['recordType']) : undefined,
        sourceUrl: str(r.link) || undefined,
      };
    })
    .filter((r) => r.id && r.title);
}

/**
 * Order the releases that carry the song by how likely each is the original studio album, most likely first –
 * this only decides which few releases are looked up in detail (`MAX_ALBUM_ROUTE_LOOKUPS`), the final choice is
 * `pickBest` over the tracks found on them. Live, demo, remix and tribute releases and other artists' albums
 * are dropped; compilations, singles, box sets and deluxe reissues sink; a proper album with the song as its
 * title track rises.
 */
export function rankAlbumRows(q: PreparedQuery, rows: AlbumRow[]): { row: AlbumRow; score: number }[] {
  const out: { row: AlbumRow; score: number }[] = [];
  for (const row of rows) {
    if (!row.art) continue;
    if (BAD_ARTIST_RE.test(row.artist)) continue;
    const artistForms = candArtistForms(row.artist);
    const artistSim = bestSimilarity(q.artistForms, artistForms);
    const related = artistSim >= ACCEPT.artistWeak && isArtistRelated(q.artistForms, artistForms);
    if (artistSim < ACCEPT.artist && !related) continue;
    if (isTributeWrap(q.artistForms, artistForms)) continue;
    const fa = flagsIn(row.title, q.ownFlags, 'album');
    if (fa.reject || fa.live || fa.demo || fa.altStrong) continue;
    let score = artistSim >= ACCEPT.artist ? 0 : -0.3;
    const comp = fa.comp || row.recordType === 'compile';
    if (comp) score -= 0.5;
    if (row.recordType === 'album') score += 0.2;
    else if (row.recordType === 'ep') score += 0.05;
    const tracks = row.trackCount ?? 0;
    if (tracks > 30) score -= 0.55; // a box set sinks below a compilation
    else if (tracks > 20) score -= 0.05;
    else if (tracks > 0 && tracks <= 4) score -= 0.1;
    if (fa.reissue) score -= 0.05;
    if (fa.remaster) score -= 0.01;
    if (!comp && isTitleTrack(q.title, row.title)) score += 0.1;
    if (NON_LATIN_RE.test(row.title) && !NON_LATIN_RE.test(`${q.title} ${q.artist}`)) score -= 0.3;
    out.push({ row, score });
  }
  // Stable: Deezer's own order (relevance, then popularity) breaks ties.
  return out.map((x, i) => ({ ...x, i })).sort((a, b) => b.score - a.score || a.i - b.i).map(({ row, score }) => ({ row, score }));
}

/** Releases considered by the album route – the best-ranked few, looked up in detail (≈ 250 ms each) unless cached. */
export const MAX_ALBUM_ROUTE_LOOKUPS = 3;
/** Album-route searches per lookup: one that lists releases settles it, one that lists none may be retried. */
export const MAX_ALBUM_ROUTES = 2;

/**
 * The album route: when the track search settled on a compilation, a single, an alternate take or an unknown
 * release, ask Deezer which of the artist's releases carry the song, look up the most album-like few and turn
 * the song's row on each of them into a candidate carrying the release's size, type, popularity and followers –
 * so `pickBest` can rank "Arrival" against "ABBA Gold" with the same signals as an iTunes response. The album's
 * own track list verifies that the song really is on it (as a plain take, not a live one) and gives its rank.
 */
export async function deezerAlbumRoute(q: PreparedQuery, from: Candidate, adapter: ArtAdapter, opts: Ctx, cache: DeezerAlbumCache, overBudget: () => boolean = () => false, max = MAX_ALBUM_ROUTE_LOOKUPS): Promise<Candidate[]> {
  // Deezer's own spellings of the artist and the title: the strict filters need them ("Pt. 2", "Bangles";
  // "Earth, Wind & Fire" must not be cut at its comma).
  const artist = stripFeatured(from.artist) || from.artist;
  const title = stripParens(stripFeatured(from.title)) || from.title;
  const rows = await deezerAlbumsWithTrack(adapter, opts, artist, title);
  const ranked = rankAlbumRows(q, rows);
  const out: Candidate[] = [];
  // Releases already looked up by the track search are free, so up to `max` new lookups among the best 2·max rows.
  let looked = 0;
  for (const { row } of ranked.slice(0, 2 * max)) {
    if (opts.signal?.aborted || overBudget()) break;
    if (!cache.has(row.id)) {
      if (looked >= max) continue;
      looked++;
      cache.set(row.id, await deezerAlbum(adapter, opts, row.id));
    }
    const d = cache.get(row.id);
    if (!d?.tracks) continue;
    for (const t of d.tracks) {
      const c: Candidate = {
        artist: t.artist || row.artist,
        title: t.title,
        album: row.title,
        albumArtist: d.albumArtist ?? row.artist,
        albumId: row.id,
        art: row.art ?? d.art,
        sourceUrl: row.sourceUrl,
        rank: t.rank,
        trackCount: d.trackCount ?? row.trackCount,
        recordType: d.recordType ?? row.recordType,
        fans: d.fans,
        route: 'album',
      };
      if (d.year) {
        c.year = d.year;
        c.yearKind = 'digital';
      }
      const s = scoreCandidate(q, c);
      if (s.accepted && !s.strongAlt) out.push(c);
    }
  }
  return out;
}

/** True when a Deezer hit is worth a look at the artist's other releases: not a confident, plain, real album. */
export function wantsAlbumRoute(s: Scored, q?: PreparedQuery): boolean {
  const c = s.cand;
  // A studio album has 5–20 tracks: more is a double album (fine, the route finds it again) or a compilation
  // that no word gives away ("1", "Love", "The Righteous Brothers").
  const realAlbum = c.recordType === 'album' && (c.trackCount ?? 0) >= 5 && (c.trackCount ?? 0) <= 20;
  // A streaming-era edition of a song more than 20 years older: a re-release, the original is worth a look.
  const reissue = c.yearKind === 'digital' && !!c.year && c.year >= 2015 && !!q?.year && c.year - q.year > 20;
  return s.score < GOOD_SCORE || s.comp || s.strongAlt || !realAlbum || reissue;
}

async function deezerArtist(q: PreparedQuery, adapter: ArtAdapter, opts: Ctx, name: string): Promise<{ name: string; image: string; url?: string; fans: number } | null> {
  const url = `https://api.deezer.com/search/artist?q=${encodeURIComponent(name)}&limit=10`;
  const data = (await timed('deezer-artist', url, opts, () => deezerGet(adapter, url, opts), (d) => ((d as Rec)?.data as unknown[])?.length ?? 0)) as Rec | null;
  const rows = (data?.data as Rec[] | undefined) ?? [];
  let best: { name: string; image: string; url?: string; fans: number; sim: number } | null = null;
  for (const r of rows) {
    const image = deezerImage(r.picture_xl) ?? deezerImage(r.picture_big);
    if (!image) continue;
    const nm = str(r.name);
    const sim = bestSimilarity(q.artistForms, candArtistForms(nm));
    if (sim < 0.8 || BAD_ARTIST_RE.test(nm)) continue;
    const fans = typeof r.nb_fan === 'number' ? r.nb_fan : 0;
    if (!best || sim > best.sim + 0.05 || (Math.abs(sim - best.sim) <= 0.05 && fans > best.fans)) best = { name: nm, image, url: str(r.link) || undefined, fans, sim };
  }
  return best;
}

interface MbRelease {
  id: string;
  rg?: string;
  title: string;
  date?: string;
  status?: string;
  primary?: string;
  secondary: string[];
}

function mbEscape(s: string): string {
  return s.replace(/["\\]/g, ' ').replace(/[+\-!(){}[\]^~*?:/]/g, ' ');
}

async function musicbrainz(q: PreparedQuery, adapter: ArtAdapter, opts: Ctx, artist: string, title: string): Promise<Candidate | null> {
  const lucene = `recording:"${mbEscape(title)}" AND artist:"${mbEscape(artist)}"`;
  const url = `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(lucene)}&fmt=json&limit=15`;
  const data = (await timed('musicbrainz', url, opts, () => adapter.json(url, { signal: opts.signal }), (d) => ((d as Rec)?.recordings as unknown[])?.length ?? 0)) as Rec | null;
  const recs = (data?.recordings as Rec[] | undefined) ?? [];
  // Collect every acceptable recording's releases, rank releases, then probe the Cover Art Archive.
  const releases: { rel: MbRelease; cand: Candidate; score: number }[] = [];
  for (const r of recs) {
    const credit = ((r['artist-credit'] as Rec[] | undefined) ?? []).map((c) => str(c.name) + str(c.joinphrase)).join('');
    const cand: Candidate = { artist: credit, title: str(r.title), art: 'pending' };
    const s = scoreCandidate(q, cand);
    if (!s.accepted) continue;
    for (const rel of (r.releases as Rec[] | undefined) ?? []) {
      const rg = rel['release-group'] as Rec | undefined;
      const mr: MbRelease = {
        id: str(rel.id),
        rg: str(rg?.id) || undefined,
        title: str(rel.title),
        date: str(rel.date) || undefined,
        status: str(rel.status) || undefined,
        primary: str(rg?.['primary-type']) || undefined,
        secondary: ((rg?.['secondary-types'] as unknown[]) ?? []).map(String),
      };
      let score = s.titleSim + s.artistSim;
      if (mr.status && mr.status !== 'Official') score -= 0.5;
      if (mr.secondary.some((t) => /live|compilation|remix|dj-mix|demo|soundtrack|mixtape/i.test(t))) score -= 0.3;
      if (mr.primary === 'Album') score += 0.1;
      else if (mr.primary === 'Single') score += 0.05;
      const y = yearOf(mr.date);
      if (y) {
        score -= Math.max(0, y - 1950) * 0.002;
        if (q.year && Math.abs(y - q.year) <= 1) score += 0.1;
      } else score -= 0.05;
      releases.push({ rel: mr, cand, score });
    }
  }
  releases.sort((a, b) => b.score - a.score);
  const probed = new Set<string>();
  let probes = 0;
  for (const { rel, cand } of releases) {
    if (probes >= 4 || opts.signal?.aborted) break;
    // A release-group probe returns the front cover of any release in the group – best odds per request.
    const targets = [rel.rg ? `https://coverartarchive.org/release-group/${rel.rg}/front-500` : '', `https://coverartarchive.org/release/${rel.id}/front-500`].filter(Boolean);
    for (const t of targets) {
      if (probed.has(t)) continue;
      probed.add(t);
      probes++;
      const ok = await timed('coverart', t, opts, () => adapter.imageExists(t, { signal: opts.signal }), (v) => (v ? 1 : 0));
      if (ok) {
        return { ...cand, art: t, album: rel.title, year: yearOf(rel.date), sourceUrl: `https://musicbrainz.org/release/${rel.id}` };
      }
      if (probes >= 4) break;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------
// Placeholder
// ---------------------------------------------------------------------------------------------------

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** hsl (h in degrees, s and l in percent) → hex, so the value is usable in every CSS/canvas context. */
function hsl(h: number, s: number, l: number): string {
  const sl = s / 100;
  const ll = l / 100;
  const a = sl * Math.min(ll, 1 - ll);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = ll - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** Deterministic gradient + initial, as an SVG data URI. Same title → same picture, on every machine. */
export function placeholderArt(title: string, artist = ''): ArtInfo {
  const h = hash32(`${normalize(title)}|${normalizeArtist(artist)}`);
  const hue1 = h % 360;
  const hue2 = (hue1 + 50 + ((h >>> 9) % 120)) % 360;
  const angle = (h >>> 17) % 360;
  const c1 = hsl(hue1, 55, 30);
  const c2 = hsl(hue2, 60, 18);
  const initial = (title.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 1) || '♪').toUpperCase();
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600">` +
    `<defs><linearGradient id="g" gradientTransform="rotate(${angle} 0.5 0.5)"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>` +
    `<rect width="600" height="600" fill="url(#g)"/>` +
    `<circle cx="${150 + ((h >>> 3) % 300)}" cy="${150 + ((h >>> 11) % 300)}" r="${120 + ((h >>> 5) % 120)}" fill="#fff" fill-opacity="0.06"/>` +
    `<text x="300" y="300" text-anchor="middle" dominant-baseline="central" font-family="system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif" font-size="320" font-weight="800" fill="#fff" fill-opacity="0.35">${initial.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>` +
    `</svg>`;
  return { art: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, source: 'placeholder', kind: 'placeholder' };
}

// ---------------------------------------------------------------------------------------------------
// Resolution chain
// ---------------------------------------------------------------------------------------------------

const MAX_ITUNES_SONG_TERMS = 3;
const MAX_DEEZER_QUERIES = 4;
/**
 * A hit at or above this score (exact artist + title, studio release, at most a compilation/year nudge) ends the
 * search. A lower one (live, remix, demo, tribute-ish album...) is kept as a fallback while the remaining
 * queries and sources look for a better release.
 */
export const GOOD_SCORE = 1.7;

function toInfo(q: PreparedQuery, s: Scored, source: string): ArtInfo {
  const c = s.cand;
  const info: ArtInfo = { art: c.art, source, kind: 'track', matched: { artist: c.artist, title: c.title, score: Math.round(s.score * 1000) / 1000 } };
  if (c.album) info.album = c.album;
  // A digital-edition date is only reported when it plausibly is the release year: it matches the database year,
  // or, when the database has none (most MIDI songs), it predates the streaming era – Deezer dates The Wall 1979
  // but "A Night at the Opera" 2005, and the UI would show 2005 as the song's year.
  if (c.year && (c.yearKind !== 'digital' || (q.year ? Math.abs(c.year - q.year) <= 3 : c.year <= 1999))) info.year = c.year;
  if (c.artistImage) info.artistImage = c.artistImage;
  if (c.sourceUrl) info.sourceUrl = c.sourceUrl;
  return info;
}

/**
 * Resolve cover art for a song using the fallback chain. Never rejects except on abort; always returns an
 * `ArtInfo` – with `kind: 'placeholder'` when nothing better could be found.
 */
export const HOSTS = { itunes: 'itunes.apple.com', deezer: 'api.deezer.com', musicbrainz: 'musicbrainz.org' } as const;

export async function resolveArt(query: ArtQuery, adapter: ArtAdapter, opts: ResolveOptions = {}): Promise<ArtInfo> {
  const q = prepareQuery(query);
  const now = opts.now ?? (() => Date.now());
  const budget = opts.budget ?? DEFAULT_BUDGET;
  const t0 = now();
  const user = opts.signal;
  // Two deadlines: the track-art sources stop at `budget`, the artist-picture fallback gets a little more.
  const soft = new AbortController();
  const hard = new AbortController();
  const timers: ReturnType<typeof setTimeout>[] = [];
  if (Number.isFinite(budget)) {
    timers.push(setTimeout(() => soft.abort(), budget));
    timers.push(setTimeout(() => hard.abort(), budget + ARTIST_GRACE_MS));
  }
  const onUserAbort = () => {
    soft.abort();
    hard.abort();
  };
  if (user?.aborted) onUserAbort();
  else user?.addEventListener('abort', onUserAbort, { once: true });
  const ctx: Ctx = { ...opts, user, signal: soft.signal };
  const ctxArtist: Ctx = { ...opts, user, signal: hard.signal };

  const check = () => {
    if (user?.aborted) throw abortError();
  };
  const overBudget = () => soft.signal.aborted || now() - t0 >= budget;
  const skipped = new Set<string>();
  /** True when the host is on a failure cool-down long enough that waiting would be worse than moving on. */
  const cooling = (host: string): boolean => {
    const ms = adapter.cooldown?.(`https://${host}/`) ?? 0;
    if (ms <= SKIP_COOLING_MS) return false;
    if (!skipped.has(host)) {
      skipped.add(host);
      opts.onEvent?.({ source: host, url: `https://${host}/`, ms: 0, ok: false, skipped: true, note: `skipped: host cooling down for ${Math.ceil(ms / 1000)}s` });
    }
    return true;
  };

  let artistImage: string | undefined;
  let artistUrl: string | undefined;
  const tried = new Set<string>();
  // Best accepted-but-unconvincing hit so far (a live take, a remix...): returned only if nothing better shows up.
  let fallback: { s: Scored; source: string } | null = null;
  // A confident hit on a compilation ("Love Songs", "Greatest Hits") is good enough to show, but the original
  // album is often one query away (another artist spelling, Deezer's "Pt." form): it buys one extra query of
  // the same source, after which the best hit so far is returned.
  let extraSpent = 0;
  const settle = (best: Scored | null, source: string): ArtInfo | null => {
    if (!best) return null;
    if (best.score >= GOOD_SCORE && !best.comp && !best.strongAlt) return toInfo(q, best, source);
    if (!fallback || best.score > fallback.s.score) fallback = { s: best, source };
    return null;
  };
  const goodFallback = (): boolean => !!fallback && (fallback as { s: Scored }).s.score >= GOOD_SCORE && !(fallback as { s: Scored }).s.strongAlt;
  /** True when a good compilation hit exists and its one extra query has already been spent. */
  const spentOnComp = (): boolean => goodFallback() && extraSpent++ >= 1;
  const settled = (): ArtInfo | null => {
    if (!fallback) return null;
    const info = toInfo(q, fallback.s, fallback.source);
    if (artistImage && !info.artistImage) info.artistImage = artistImage;
    return info;
  };
  const deezerAlbums: DeezerAlbumCache = new Map();
  let albumRoutes = 0;

  try {
    // 1. iTunes, entity=song. The primary term already uses the cleaned title and the "First Last" artist.
    const itunesTerms = uniq([
      `${q.artistTerms[0]} ${q.titleTerms[0]}`,
      `${q.artistTerms[0]} ${q.titleTerms[1] ?? q.titleTerms[0]}`,
      ...q.titleTerms.slice(2).map((t) => `${q.artistTerms[0]} ${t}`),
      ...q.artistTerms.slice(1).map((a) => `${a} ${q.titleTerms[0]}`),
    ]);
    for (const term of itunesTerms.slice(0, MAX_ITUNES_SONG_TERMS)) {
      check();
      if (overBudget() || cooling(HOSTS.itunes) || spentOnComp()) break;
      tried.add(term);
      const hit = settle(pickBest(q, await itunesSongs(q, adapter, ctx, term, 'song')), 'itunes');
      if (hit) return hit;
    }
    if (goodFallback()) {
      const hit = settled();
      if (hit) return hit;
    }

    // 2. Deezer (JSONP in the browser). Precise artist/track filter first – also with Deezer's own "Pt. 2"
    // spelling, which its strict search needs ("Part 2" finds only a live remix) and without a leading "The"
    // ("Bangles" finds Everything, "The Bangles" a compilation) – then a plain search, then the other spellings.
    const ptTerm = q.titleTerms.find((t, i) => i > 0 && /\bpt\.\s*(\d+|[ivx]+)\b/i.test(t));
    const noThe = /^the\s+/i.test(q.artistTerms[0]) ? q.artistTerms.find((a) => a.toLowerCase() === q.artistTerms[0].replace(/^the\s+/i, '').toLowerCase()) : undefined;
    const deezerQueries = uniq([
      `artist:"${q.artistTerms[0]}" track:"${q.titleTerms[0]}"`,
      ...(ptTerm ? [`artist:"${q.artistTerms[0]}" track:"${ptTerm}"`] : []),
      ...(noThe ? [`artist:"${noThe}" track:"${q.titleTerms[0]}"`] : []),
      `${q.artistTerms[0]} ${q.titleTerms[0]}`,
      ...q.artistTerms.slice(1, 2).map((a) => `artist:"${a}" track:"${q.titleTerms[0]}"`),
      ...q.titleTerms.slice(1, 2).map((t) => `artist:"${q.artistTerms[0]}" track:"${t}"`),
    ]);
    extraSpent = 0;
    for (const dq of deezerQueries.slice(0, MAX_DEEZER_QUERIES)) {
      check();
      if (overBudget() || cooling(HOSTS.deezer) || spentOnComp()) break;
      const cands = await deezerTracks(q, adapter, ctx, dq);
      if (cands.length && !cooling(HOSTS.deezer)) await enrichDeezer(q, cands, adapter, ctx, deezerAlbums, MAX_DEEZER_ALBUM_LOOKUPS, overBudget);
      check();
      if (!artistImage) {
        // Remember the artist portrait of any well-matching artist for the fallback.
        for (const c of cands) {
          if (c.artistImage && bestSimilarity(q.artistForms, candArtistForms(c.artist)) >= 0.8 && !BAD_ARTIST_RE.test(c.artist)) {
            artistImage = c.artistImage;
            break;
          }
        }
      }
      let best = pickBest(q, cands);
      // The album route: the original album behind a compilation / single / unknown release. Once per lookup
      // when it finds releases; a spelling that finds none ("Part 2" where Deezer says "Pt. 2") leaves one retry.
      if (best && albumRoutes < MAX_ALBUM_ROUTES && wantsAlbumRoute(best, q) && !overBudget() && !cooling(HOSTS.deezer)) {
        albumRoutes++;
        const more = await deezerAlbumRoute(q, best.cand, adapter, ctx, deezerAlbums, overBudget);
        check();
        if (more.length) {
          albumRoutes = MAX_ALBUM_ROUTES;
          cands.push(...more);
          best = pickBest(q, cands);
        }
      }
      const hit = settle(best, best?.cand.route === 'album' ? 'deezer-album' : 'deezer');
      if (hit) return hit;
    }
    if (goodFallback()) {
      const hit = settled();
      if (hit) return hit;
    }

    // 3. iTunes again: album entity (title tracks, singles, EPs) and remaining artist spellings.
    check();
    extraSpent = 0;
    if (!overBudget() && !cooling(HOSTS.itunes) && !spentOnComp()) {
      const hit = settle(pickBest(q, await itunesSongs(q, adapter, ctx, `${q.artistTerms[0]} ${q.titleTerms[0]}`, 'album')), 'itunes-album');
      if (hit) return hit;
    }
    for (const term of itunesTerms.slice(MAX_ITUNES_SONG_TERMS, MAX_ITUNES_SONG_TERMS + 2)) {
      check();
      if (tried.has(term)) continue;
      if (overBudget() || cooling(HOSTS.itunes) || spentOnComp()) break;
      tried.add(term);
      const hit = settle(pickBest(q, await itunesSongs(q, adapter, ctx, term, 'song')), 'itunes');
      if (hit) return hit;
    }

    // A studio take of the right song (on a compilation, in a mono cut...) beats a MusicBrainz round trip and
    // everything after it. A live / remix / demo fallback does not: MusicBrainz knows the studio releases.
    if (fallback && !(fallback as { s: Scored }).s.strongAlt) {
      const hit = settled();
      if (hit) return hit;
    }

    // 4. MusicBrainz recording search + Cover Art Archive.
    for (const a of q.artistTerms.slice(0, 2)) {
      check();
      if (overBudget() || cooling(HOSTS.musicbrainz)) break;
      const c = await musicbrainz(q, adapter, ctx, a, q.titleTerms[0]);
      if (c) {
        const s = scoreCandidate(q, c);
        const info = toInfo(q, s, 'musicbrainz');
        if (artistImage) info.artistImage = artistImage;
        return info;
      }
    }
    {
      const hit = settled();
      if (hit) return hit;
    }

    // 5. Artist picture.
    if (!opts.noArtistFallback) {
      if (!artistImage) {
        for (const a of q.artistTerms.slice(0, 3)) {
          check();
          if (hard.signal.aborted || cooling(HOSTS.deezer)) break;
          const hit = await deezerArtist(q, adapter, ctxArtist, a);
          if (hit) {
            artistImage = hit.image;
            artistUrl = hit.url;
            break;
          }
        }
      }
      if (artistImage) return { art: artistImage, artistImage, source: 'deezer-artist', kind: 'artist', sourceUrl: artistUrl };
    }

    // 6. Placeholder.
    return placeholderArt(q.title, q.artist);
  } finally {
    for (const t of timers) clearTimeout(t);
    user?.removeEventListener('abort', onUserAbort);
  }
}

// ---------------------------------------------------------------------------------------------------
// Browser entry point: cache + supersede
// ---------------------------------------------------------------------------------------------------

const CACHE_PREFIX = 'art:v3:';
const ARTIST_TTL = 7 * 24 * 3600 * 1000;
/**
 * Track hits whose match score is below this (a fuzzy title or a penalised release) are re-validated after a
 * week instead of being kept forever; confident matches (exact title + artist, studio release) are permanent.
 */
export const LOW_CONFIDENCE_SCORE = 1.7;
const LOW_CONFIDENCE_TTL = 7 * 24 * 3600 * 1000;

interface CacheRow extends ArtInfo {
  ts: number;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

let swept = false;
/** Drop cache rows written by older versions of this module (they may contain cached misses). */
function sweepOldCache(ls: Storage) {
  if (swept) return;
  swept = true;
  try {
    const stale: string[] = [];
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k && k.startsWith('art:') && !k.startsWith(CACHE_PREFIX)) stale.push(k);
    }
    for (const k of stale) ls.removeItem(k);
  } catch {
    /* ignore */
  }
}

export function readCache(id: string): ArtInfo | null {
  const ls = storage();
  if (!ls) return null;
  sweepOldCache(ls);
  try {
    const raw = ls.getItem(CACHE_PREFIX + id);
    if (!raw) return null;
    const row = JSON.parse(raw) as CacheRow;
    if (!row.art || row.kind === 'placeholder') return null;
    const age = Date.now() - (row.ts ?? 0);
    if (row.kind === 'artist' && age > ARTIST_TTL) return null;
    if (row.kind === 'track' && (row.matched?.score ?? 0) < LOW_CONFIDENCE_SCORE && age > LOW_CONFIDENCE_TTL) return null;
    const { ts: _ts, ...info } = row;
    return info;
  } catch {
    return null;
  }
}

export function writeCache(id: string, info: ArtInfo) {
  if (!info.art || (info.kind !== 'track' && info.kind !== 'artist')) return; // never cache misses or placeholders
  const ls = storage();
  if (!ls) return;
  try {
    ls.setItem(CACHE_PREFIX + id, JSON.stringify({ ...info, ts: Date.now() } satisfies CacheRow));
  } catch {
    /* quota or private mode */
  }
}

let browserAdapter: ArtAdapter | null = null;
function defaultAdapter(): ArtAdapter {
  if (!browserAdapter) browserAdapter = typeof document !== 'undefined' ? createBrowserAdapter() : createFetchAdapter();
  return browserAdapter;
}

const memo = new Map<string, ArtInfo>();
const inFlight = new Map<string, { job: Promise<ArtInfo>; ctrl: AbortController }>();
let latest: AbortController | null = null;

export interface LookupOptions {
  signal?: AbortSignal;
  /** Cancel the previous still-running lookup (default true: the UI shows one song at a time). */
  supersede?: boolean;
  year?: number;
  adapter?: ArtAdapter;
  /** Wall-time budget for the track-art sources, ms (default `DEFAULT_BUDGET`). */
  budget?: number;
}

/**
 * Look up cover art for a song. Resolves quickly from cache when possible, otherwise walks the source chain.
 * Never rejects: a superseded/aborted lookup resolves to `{}`, an exhausted chain to a placeholder.
 * Bounded in time: after `budget` ms (8 s) of unlucky sources the artist picture or placeholder is returned.
 */
export async function lookupArt(id: string, artist: string, title: string, opts: LookupOptions = {}): Promise<ArtInfo> {
  const cached = memo.get(id) ?? readCache(id);
  if (cached?.art) {
    memo.set(id, cached);
    return cached;
  }
  // Share a running lookup of the same song – unless it was superseded (A → B → A): that one resolves to `{}`
  // as soon as its requests notice the abort, so start a fresh one instead.
  const pending = inFlight.get(id);
  if (pending && !pending.ctrl.signal.aborted) return pending.job;

  if (opts.supersede !== false) latest?.abort();
  const ctrl = new AbortController();
  if (opts.supersede !== false) latest = ctrl;
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }

  const entry = { ctrl, job: Promise.resolve<ArtInfo>({}) };
  entry.job = (async (): Promise<ArtInfo> => {
    try {
      const info = await resolveArt({ artist, title, year: opts.year }, opts.adapter ?? defaultAdapter(), { signal: ctrl.signal, budget: opts.budget });
      if (info.kind === 'track' || info.kind === 'artist') {
        memo.set(id, info);
        writeCache(id, info);
      }
      return info;
    } catch (e) {
      if (isAbort(e)) return {};
      return placeholderArt(title, artist);
    } finally {
      if (inFlight.get(id) === entry) inFlight.delete(id);
      if (latest === ctrl) latest = null;
    }
  })();
  inFlight.set(id, entry);
  return entry.job;
}
