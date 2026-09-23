/** Pure matching: text normalisation, query variants and candidate scoring (unit-testable, no network). See ../art.ts. */
import type { ArtQuery } from './types.js';

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

export function uniq(xs: string[]): string[] {
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

export const BAD_ARTIST_RE = /karaoke|tribute|in the style of|originally performed|made famous|sound-?alike|studio (musicians|group|band|players|orchestra)|hit crew|party (mix|band)|cover (band|crew|team|version)|(?:^|\s)(?:the )?(?:hits?|top 40|chart|singers? unlimited|allstars)\b|kidz bop|8-?bit|lullaby|rockabye|vitamin string|midi|ringtone|piano tribute|orchestra of the|(?:^|\b)ameritz|starlite|the (?:new )?world orchestra/i;
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
export const NON_LATIN_RE = /[\u0370-\u03ff\u0400-\u052f\u0590-\u06ff\u0900-\u0dff\u0e00-\u0e7f\u1100-\u11ff\u3040-\u30ff\u3130-\u318f\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/;

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
export function flagsIn(s: string | undefined, own: Set<string>, side: 'title' | 'album'): Flags {
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
export function candArtistForms(artist: string): string[] {
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

/**
 * A hit at or above this score (exact artist + title, studio release, at most a compilation/year nudge) ends the
 * search. A lower one (live, remix, demo, tribute-ish album...) is kept as a fallback while the remaining
 * queries and sources look for a better release.
 */
export const GOOD_SCORE = 1.7;
