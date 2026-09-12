/**
 * Pure helpers for the web UI (no DOM), so they can be unit-tested.
 */
import { normaliseText, isDuplicateTitle, estimateKey, pcName, pitchClass, type IndexEntry, type SearchHit, type Section, type TimelineSection } from '@strudelify/core';

export function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** m:ss, rounded to the nearest second. */
export function fmt(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export { hashHue, fallbackTint, songTint, initial } from './tint.js';

/** Query tokens worth highlighting (normalised, at least two characters). */
export function queryTokens(query: string): string[] {
  return normaliseText(query).split(' ').filter((t) => t.length >= 2);
}

/** Words too common to explain a match ("the beatles" should not light up "Come Toge<mark>ther</mark>"). */
const STOP_WORDS = new Set(['the', 'a', 'an', 'of', 'and', 'in', 'to', 'on', 'at', 'by', 'for', 'is', 'it', 'my', 'me', 'you']);
/** Query tokens worth highlighting: the search tokens minus stop-words. */
export function highlightTokens(query: string): string[] {
  return queryTokens(query).filter((t) => !STOP_WORDS.has(t));
}

const WORD_START = '(?<![\\p{L}\\p{N}])';
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * HTML for `text` with every token wrapped in <mark> where it starts a word (case-insensitive); everything
 * is escaped. Matches are anchored at word starts because that is how the search matches ("love" explains
 * "Lovely Day", not "Glove"). A token that does not occur verbatim (a fuzzy hit) falls back to its longest
 * prefix of at least three characters that does, so the user can still see why the row matched.
 */
export function highlight(text: string, tokens: string[]): string {
  const lower = text.toLowerCase();
  const at = (t: string) => new RegExp(`${WORD_START}${escapeRe(t)}`, 'iu').test(lower);
  const found = tokens.map((t) => {
    if (at(t)) return t;
    for (let n = t.length - 1; n >= 3; n--) if (at(t.slice(0, n))) return t.slice(0, n);
    return null;
  }).filter((t): t is string => !!t);
  if (!found.length) return esc(text);
  const re = new RegExp(`${WORD_START}(${found.map(escapeRe).join('|')})`, 'igu');
  return text.split(re).map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part))).join('');
}

/**
 * Artist name as people write it: the datasets sometimes file solo artists as "Last, First"
 * ("Amos, Tori"). Only a single comma with plain words on both sides is flipped; bands with a comma
 * in their name ("Earth, Wind & Fire", "10,000 Maniacs", "Crosby, Stills, Nash & Young") are kept.
 */
export function displayArtist(name: string): string {
  const flipped = flipLastFirst(name);
  return artistAliases.get(normaliseText(flipped)) ?? flipped;
}
/** "Amos, Tori" → "Tori Amos" (see `displayArtist`); anything else trimmed. */
function flipLastFirst(name: string): string {
  const m = /^([A-Za-z'’.\- ]+),\s+([A-Za-z'’.\- ]+)$/.exec(name.trim());
  if (!m) return name.trim();
  const last = m[1].trim(), first = m[2].trim();
  if (/\b(and|&|the|feat)\b/i.test(name) || first.split(/\s+/).length > 2 || last.split(/\s+/).length > 2) return name.trim();
  return `${first} ${last}`;
}
/** Whether `name` came in the datasets' "Last, First" form. */
const isLastFirst = (name: string) => flipLastFirst(name) !== name.trim();

/** Canonical spelling by normalised name, learnt from the index (`canonicalArtists`); empty until it is loaded. */
let artistAliases = new Map<string, string>();
export function setArtistAliases(aliases: Map<string, string>) { artistAliases = aliases; }

const isAllCaps = (s: string) => /[A-Z]{3}/.test(s) && s === s.toUpperCase();
interface ArtistSpelling { key: string; spellings: Map<string, number>; n: number; mcgill: number; comma: number; caps: number }
/**
 * One spelling per artist, learnt from the index itself. The datasets file the same artist several ways:
 * "Abba" next to "ABBA", "Nat "King" Cole" next to "Nat King Cole", and solo artists surname first with no
 * comma ("Jackson Michael", "Collins Phil", "BOWIE DAVID"). Spellings that only differ in case or punctuation
 * merge on the majority. Two-word names that also occur reversed are decided by the evidence at hand, in this
 * order: the McGill annotations (curated, always "First Last"), the "Last, First" comma form (which names the
 * given name), an all-caps spelling (the surname-first convention in the MIDI set), then a first word that is a
 * confirmed given name elsewhere in the index; only when none of that says anything does the larger side win.
 * Returns normalised name → canonical display name, for `setArtistAliases`.
 */
export function canonicalArtists(entries: readonly IndexEntry[]): Map<string, string> {
  const groups = new Map<string, ArtistSpelling>();
  const givenNames = new Set<string>();
  for (const e of entries) {
    const disp = flipLastFirst(e.artist);
    const key = normaliseText(disp);
    if (!key) continue;
    const g = groups.get(key) ?? { key, spellings: new Map(), n: 0, mcgill: 0, comma: 0, caps: 0 };
    g.spellings.set(disp, (g.spellings.get(disp) ?? 0) + 1);
    g.n++;
    const mcgill = e.sources.includes('mcgill'), comma = isLastFirst(e.artist);
    if (mcgill) g.mcgill++;
    if (comma) g.comma++;
    if (isAllCaps(disp)) g.caps++;
    const words = key.split(' ');
    if (words.length === 2 && (mcgill || comma)) givenNames.add(words[0]);
    groups.set(key, g);
  }
  const canonical = new Map<string, string>();
  const spelling = (g: ArtistSpelling) => [...g.spellings].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  for (const g of groups.values()) if (g.spellings.size > 1) canonical.set(g.key, spelling(g));
  const evidence = (g: ArtistSpelling) => g.mcgill * 10 + g.comma * 5 - (g.caps === g.n ? 5 : 0);
  for (const g of groups.values()) {
    const w = g.key.split(' ');
    if (w.length !== 2) continue;
    const twin = groups.get(`${w[1]} ${w[0]}`);
    if (!twin || g.key > twin.key) continue; // each pair once
    const a = evidence(g), b = evidence(twin);
    const ga = givenNames.has(w[0]), gb = givenNames.has(w[1]);
    let winner: ArtistSpelling;
    if (a !== b) winner = a > b ? g : twin;
    else if (ga !== gb) winner = ga ? g : twin;
    else winner = twin.n > g.n ? twin : g;
    const loser = winner === g ? twin : g;
    canonical.set(loser.key, canonical.get(winner.key) ?? spelling(winner));
  }
  return canonical;
}

export interface ArtistGroup { name: string; entries: IndexEntry[] }

/** Group index entries by normalised (display) artist name. */
export function buildArtistIndex(entries: IndexEntry[]): Map<string, ArtistGroup> {
  const byArtist = new Map<string, ArtistGroup>();
  for (const e of entries) {
    const name = displayArtist(e.artist);
    const k = normaliseText(name);
    if (!k) continue;
    const g = byArtist.get(k) ?? { name, entries: [] };
    g.entries.push(e);
    byArtist.set(k, g);
  }
  return byArtist;
}

export interface ArtistMatch { group: ArtistGroup; exact: boolean }

/**
 * When the query names an artist, return that artist's group (the largest one on ties). An exact
 * name ("beatles", "the beatles") always matches; a prefix ("nirv", "beatl") only when it covers at
 * least half of the name, so a common title word ("love") does not summon Loverboy. Needs at least
 * two songs so a single-song artist just shows as a hit.
 */
export function artistMatch(query: string, artists: Map<string, ArtistGroup>): ArtistMatch | null {
  const nq = normaliseText(query);
  if (nq.length < 3) return null;
  let best: ArtistMatch | null = null;
  for (const [k, g] of artists) {
    const bare = k.startsWith('the ') ? k.slice(4) : k;
    const exact = k === nq || bare === nq;
    const prefix = !exact && nq.length >= 4 && (k.startsWith(nq) || bare.startsWith(nq)) && nq.length * 2 >= bare.length;
    if (!(exact || prefix) || g.entries.length < 2) continue;
    if (!best || (exact && !best.exact) || (exact === best.exact && g.entries.length > best.group.entries.length)) best = { group: g, exact };
  }
  return best;
}

/**
 * Whether the query reads as a song title rather than an artist: at least two of the hits carry the
 * whole query at a word boundary of their title ("love" → "Love", "Love Me Do"). A prefix-matched
 * artist group is then listed after those direct hits instead of hijacking the first row.
 */
export function queryLooksLikeTitle(query: string, hits: readonly { title: string }[]): boolean {
  const nq = normaliseText(query);
  if (!nq) return false;
  let n = 0;
  for (const h of hits) if (` ${normaliseText(h.title)} `.includes(` ${nq} `) || normaliseText(h.title).startsWith(`${nq} `)) n++;
  return n >= 2;
}

/**
 * Tidy a ranked hit list for display: near-duplicate transcriptions (same artist, titles within two
 * edits, e.g. "Smell Like Teen Spirit" next to "Smells Like Teen Spirit") collapse into the best-ranked
 * one, and hits that contain none of the query's words verbatim (pure typo matches) are dropped as soon
 * as at least one hit does, so a fuzzy stranger never pads a list of real matches. Order is otherwise preserved.
 */
export function tidyHits<T extends Pick<SearchHit, 'id' | 'title' | 'artist'>>(hits: T[], query: string): T[] {
  const seen: { artist: string; title: string }[] = [];
  const kept = hits.filter((h) => {
    const artist = normaliseText(displayArtist(h.artist));
    const title = h.title;
    const dup = seen.some((s) => s.artist === artist && isDuplicateTitle(s.title, title));
    if (!dup) seen.push({ artist, title });
    return !dup;
  });
  const tokens = queryTokens(query);
  if (!tokens.length) return kept;
  const verbatim = (h: T) => {
    const hay = ` ${normaliseText(h.title)} ${normaliseText(displayArtist(h.artist))}`;
    return tokens.some((t) => hay.includes(` ${t}`) || hay.includes(t));
  };
  const exact = kept.filter(verbatim);
  // Pure edit-distance matches only pad the list when nothing was found verbatim: two real hits for
  // "smells" are a better answer than two real hits plus "Grandpa's Spells".
  return exact.length ? exact : kept;
}

/** Most popular songs first, then alphabetical. */
export function byPopularity(entries: IndexEntry[]): IndexEntry[] {
  return [...entries].sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0) || a.title.localeCompare(b.title));
}

export interface ChordBlock { start: number; end: number; label: string | null }

/** Merge consecutive bars with the same chord into blocks (`end` is inclusive). */
export function chordBlocks(chords: (string | null)[]): ChordBlock[] {
  const out: ChordBlock[] = [];
  let i = 0;
  while (i < chords.length) {
    let j = i;
    while (j + 1 < chords.length && chords[j + 1] === chords[i]) j++;
    out.push({ start: i, end: j, label: chords[i] ?? null });
    i = j + 1;
  }
  return out;
}

/** Section colour by keyword in the label; a neutral grey otherwise. */
export const SECTION_COLORS: Record<string, string> = {
  intro: '#9bb7ff', verse: '#8fe3c2', 'pre-chorus': '#ffd591', chorus: '#ff9fb4', bridge: '#d3a8ff',
  solo: '#ffb36b', instrumental: '#ffb36b', interlude: '#b6c8d9', outro: '#9bb7ff', transition: '#b6c8d9',
  theme: '#8fe3c2', fadeout: '#b6c8d9', ending: '#9bb7ff', coda: '#9bb7ff',
};
export function sectionColor(label: string): string {
  const l = label.toLowerCase();
  const key = Object.keys(SECTION_COLORS).find((k) => l.includes(k));
  return key ? SECTION_COLORS[key] : '#b6c8d9';
}

/**
 * Dominant vivid colour of RGBA pixel data as an `hsl()` string, or null when the image is
 * effectively greyscale. Pixels are bucketed by hue and weighted by saturation and mid lightness.
 */
export function dominantHsl(data: Uint8ClampedArray | Uint8Array): string | null {
  const bins = Array.from({ length: 12 }, () => ({ w: 0, h: 0, s: 0, l: 0 }));
  for (let i = 0; i + 3 < data.length; i += 4) {
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const dlt = max - min;
    if (dlt < 0.08 || l < 0.08 || l > 0.95) continue;
    const s = dlt / (1 - Math.abs(2 * l - 1));
    let h = max === r ? ((g - b) / dlt) % 6 : max === g ? (b - r) / dlt + 2 : (r - g) / dlt + 4;
    h = ((h * 60) + 360) % 360;
    const w = s * (1 - Math.abs(l - 0.5) * 1.4);
    const bin = bins[Math.floor(h / 30) % 12];
    bin.w += w; bin.h += h * w; bin.s += s * w; bin.l += l * w;
  }
  const best = bins.reduce((a, b) => (b.w > a.w ? b : a));
  if (best.w <= 0) return null;
  const h = Math.round(best.h / best.w);
  const s = Math.round(Math.min(78, Math.max(38, (best.s / best.w) * 100)));
  const l = Math.round(Math.min(48, Math.max(30, (best.l / best.w) * 100)));
  return `hsl(${h} ${s}% ${l}%)`;
}

const SHARP_TO_FLAT: Record<string, string> = { 'C#': 'Db', 'D#': 'Eb', 'F#': 'Gb', 'G#': 'Ab', 'A#': 'Bb' };
/** Respell a sharp note name with a flat (`A#` → `Bb`); naturals and flats pass through. */
export function flatName(note: string): string { return SHARP_TO_FLAT[note] ?? note; }

/**
 * Conventional spelling of a key's tonic: the parsers name pitch classes with sharps, but B♭ major
 * is not written A♯ major. Sharp majors become their flat twins except F♯ (6 sharps either way);
 * sharp minors keep the sharp except D♯/A♯ minor, which are written E♭/B♭ minor.
 */
export function spellTonic(tonic: string, mode: 'major' | 'minor' = 'major'): string {
  if (mode === 'minor') return tonic === 'D#' || tonic === 'A#' ? flatName(tonic) : tonic;
  return tonic === 'F#' ? tonic : flatName(tonic);
}

/** Whether chords in this key are conventionally spelled with flats (F, B♭, E♭ ... majors and their relative minors). */
export function prefersFlats(tonic: string | undefined, mode: 'major' | 'minor' = 'major'): boolean {
  if (!tonic) return false;
  const t = spellTonic(tonic, mode);
  if (t.endsWith('b')) return true;
  return mode === 'major' ? t === 'F' : ['D', 'G', 'C', 'F'].includes(t);
}

const accidental = (a: string | undefined) => (a === '#' ? '♯' : a === 'b' ? '♭' : '');
function prettyNote(letter: string, acc: string | undefined, flats: boolean): string {
  const name = flats && acc === '#' ? flatName(letter + acc) : letter + (acc ?? '');
  return name[0] + accidental(name[1]);
}

/** Display form of a key: `A#` + `major` → `B♭ major`. */
export function keyName(tonic: string, mode: 'major' | 'minor' = 'major'): string {
  const t = spellTonic(tonic, mode);
  return `${t[0]}${accidental(t[1])} ${mode}`;
}

/**
 * Display form of a Strudel chord symbol: `^` becomes maj, `#`/`b` become ♯/♭ on the root and bass,
 * and with `flats` set (a flat key) sharp roots are respelled (`A#^7/A` in D minor → `B♭maj7/A`).
 */
export function prettyChord(symbol: string, flats = false): string {
  const m = /^([A-G])([#b]?)([^/]*)(?:\/([A-G])([#b]?))?$/.exec(symbol);
  if (!m) return symbol;
  const q = m[3].replace(/\^(\d*)/, (_, n: string) => `maj${n || '7'}`);
  return `${prettyNote(m[1], m[2], flats)}${q}${m[4] ? `/${prettyNote(m[4], m[5], flats)}` : ''}`;
}

/**
 * Shorter spellings of a display chord, longest first: `B♭maj7/A` → `B♭maj7` → `B♭`. A block that is too
 * narrow for the full symbol shows the widest form that fits inside it, never one that runs over the
 * neighbouring block.
 */
export function chordVariants(label: string): string[] {
  const out = [label];
  const noBass = label.replace(/\/.*$/, '');
  if (noBass !== label) out.push(noBass);
  const m = /^([A-G][♯♭#b]?)(m(?!aj))?/.exec(noBass);
  const short = m ? m[1] + (m[2] ?? '') : null; // the mode survives abbreviation: Dm7 → Dm, never D
  if (short && short !== noBass) out.push(short);
  return out;
}

const PITCH_CLASS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/**
 * Hue for a chord symbol from its root on the circle of fifths (C 200°, G 230°, D 260° …), so neighbouring
 * keys get neighbouring colours and the chord lane reads as a harmonic map even where no label fits.
 * Null for "N" (no chord) or anything unparseable.
 */
export function chordHue(symbol: string): number | null {
  const m = /^([A-G])([#b])?/.exec(symbol);
  if (!m) return null;
  const pc = (PITCH_CLASS[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
  return (((pc * 7) % 12) * 30 + 200) % 360; // offset so the common keys land on blues, violets and greens
}

/** The first of `variants` whose measured width plus `pad` fits in `width`, or null when none does. */
export function fitLabel(variants: readonly string[], width: number, measure: (text: string) => number, pad = 8): string | null {
  for (const v of variants) if (measure(v) + pad <= width + 0.5) return v;
  return null;
}

export interface BarCapOption { value: number; label: string }
export const ALL_BARS = 1_000_000;
/**
 * Choices for the bar cap of a `totalBars`-long song: only caps that actually cut the song, plus "All".
 * The compiler counts a cap in bars of 4/4 (a length in beats whatever the metre), so the labels say how
 * many of the song's own bars each cap keeps: in 2/4, "200" of 4/4 is the first 400 bars, and a 212-bar
 * song is not cut by it at all. `quartersPerBar` is the song's bar length in quarter notes (4 in 4/4, 2 in
 * 2/4, 3 in 6/8). The default keeps the compile bounded (200 bars of 4/4) unless the song is shorter.
 */
export function barCapOptions(totalBars: number, quartersPerBar = 4, caps: readonly number[] = [16, 32, 64, 128, 200, 400], dflt = 200): { options: BarCapOption[]; value: number } {
  const songBars = (c: number) => Math.max(1, Math.round((c * 4) / (quartersPerBar || 4)));
  const options = caps.filter((c) => songBars(c) < totalBars).map((c) => ({ value: c, label: `First ${songBars(c)} bars` }));
  options.push({ value: ALL_BARS, label: totalBars > 0 ? `All ${totalBars} bars` : 'All bars' });
  const value = totalBars > songBars(dflt) && caps.includes(dflt) ? dflt : ALL_BARS;
  return { options, value };
}

/** Bars between ruler ticks so that consecutive ticks are at least `minPx` apart. */
export function rulerStep(pxPerBar: number, minPx = 44): number {
  for (const s of [1, 2, 4, 8, 16, 32, 64, 128, 256]) if (s * pxPerBar >= minPx) return s;
  return 512;
}

/** Hero title size bucket by length: long titles are set smaller so they stay within three lines. */
export function titleSize(title: string): 'lg' | 'md' | 'sm' {
  const n = title.trim().length;
  return n <= 28 ? 'lg' : n <= 48 ? 'md' : 'sm';
}

/**
 * Section markers for a MIDI song that also has a human-annotated structure (McGill), laid on the
 * rendered bar grid from bar 0 and clipped to `bars`. The two transcriptions are of the same record,
 * but not guaranteed to be cut identically, so a structure whose length disagrees with the MIDI by
 * more than a quarter is not shown rather than shown wrong. `songBars` is the song's full length when
 * `bars` is a capped rendering, so the check is made against the whole song.
 */
export function structureSections(structure: Section[] | undefined, bars: number, songBars = bars): TimelineSection[] {
  if (!structure?.length || bars <= 0) return [];
  const total = structure.reduce((n, s) => n + s.bars, 0);
  if (total < songBars * 0.75 || total > songBars * 1.25) return [];
  const out: TimelineSection[] = [];
  let at = 0;
  for (const s of structure) {
    if (at >= bars) break;
    const n = Math.min(s.bars, bars - at);
    if (n > 0) out.push({ label: s.raw ?? s.label, startBar: at, bars: n });
    at += n;
  }
  return out;
}

const COMPILATION = /\b(best of|greatest|hits|collection|anthology|essential|essentials|live|remix|compilation|definitive|ultimate|box set|singles|retrospective|gold|platinum|megamix|karaoke|tribute)\b/i;
const EDITION = /\s*[([][^)\]]*\b(remaster|remastered|deluxe|edition|expanded|anniversary|version|bonus|reissue|mono|stereo)\b[^)\]]*[)\]]/gi;

export interface AlbumInfo { album?: string; year?: number; kind?: string }
/**
 * The hero eyebrow: "1979 · The Wall". The year comes from the database when it has one. The album name
 * is shown only when the art lookup matched the track on a studio release: compilations, live takes and
 * remixes are dropped (the art chain falls back to them when a service is rate-limited), as is a release
 * whose year is more than three years off the database's, so the same song reads the same on every load.
 */
export function albumLine(info: AlbumInfo, entry: { year?: number }): string {
  const year = entry.year ?? info.year;
  const raw = info.kind === 'track' ? info.album ?? '' : '';
  let album = raw.replace(EDITION, '').trim();
  const reissue = album !== raw.trim(); // a remaster/anniversary edition legitimately carries a later year
  if (COMPILATION.test(album)) album = '';
  if (album && !reissue && entry.year && info.year && Math.abs(info.year - entry.year) > 3) album = '';
  return [year ? String(year) : '', album].filter(Boolean).join(' · ');
}

/** Words of a song id, for a "did you mean" search: `nirvana--smells-like-teen-spirit` → `nirvana smells like teen spirit`. */
export function idWords(id: string): string {
  return id.replace(/--/g, ' ').replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Timeline width in px: the full viewport when every bar gets at least `minPxPerBar`, otherwise the
 * zoomed width so that lanes stay legible and the timeline scrolls sideways (phones, 400-bar songs).
 */
export function timelineWidth(bars: number, viewport: number, minPxPerBar: number): number {
  if (bars <= 0 || viewport <= 0) return viewport;
  return Math.max(viewport, Math.round(bars * minPxPerBar));
}

/**
 * Scroll offset that keeps `x` visible in a `visible`-wide window over `total` px: unchanged while
 * `x` is inside the window (with a small margin), otherwise a page flip that puts `x` a quarter in.
 */
export function followScroll(x: number, scrollLeft: number, visible: number, total: number, margin = 8): number {
  if (total <= visible) return 0;
  if (x >= scrollLeft + margin && x <= scrollLeft + visible - margin) return scrollLeft;
  return Math.max(0, Math.min(total - visible, Math.round(x - visible * 0.25)));
}

/**
 * Root and triad quality of a chord symbol, the part a musician reads first: `Fsus4/C` → `F`,
 * `A#m7/G#` → `A#m`, `C#^7` → `C#`. Null for "N" (no chord) or anything unparseable.
 */
export function chordFamily(symbol: string | null | undefined): string | null {
  if (!symbol) return null;
  const m = /^([A-G][#b]?)(m(?!aj))?/.exec(symbol);
  return m ? m[1] + (m[2] ?? '') : null;
}

/** Root of a chord symbol (`A#m7/G#` → `A#`), null for "N" or anything unparseable. */
export function chordRoot(symbol: string | null | undefined): string | null {
  const m = symbol ? /^([A-G][#b]?)/.exec(symbol) : null;
  return m ? m[1] : null;
}

export interface ChordPhrase {
  start: number;
  /** Inclusive. */
  end: number;
  /** Bars per repetition of `cycle` (1 for a plain run). */
  period: number;
  /**
   * Label of each slot of one repetition: the chord family (root + triad quality) when the bars in that
   * slot agree on it, else the bare root. A single null for a run of bars without a chord.
   */
  cycle: (string | null)[];
}

/** Whether `key[i..i+p)` is not itself made of a shorter repeating cycle (`F A♭ F A♭` is period 2, not 4). */
function primitiveCycle(key: (string | null)[], i: number, p: number): boolean {
  for (let d = 1; d < p; d++) {
    let periodic = true;
    for (let k = d; k < p && periodic; k++) if (key[i + k] !== key[i + k - d]) periodic = false;
    if (periodic) return false;
  }
  return true;
}

/** The family most bars of a slot agree on (`Fm` for Fsus4 Fm Fm Fm), or the root when they tie. */
function slotLabel(fam: (string | null)[], root: string | null, at: number[]): string | null {
  const count = new Map<string, number>();
  for (const i of at) { const f = fam[i]; if (f) count.set(f, (count.get(f) ?? 0) + 1); }
  let best: string | null = null, n = 0, tie = false;
  for (const [f, c] of count) { if (c > n) { best = f; n = c; tie = false; } else if (c === n) tie = true; }
  return tie ? root : best ?? root;
}

/**
 * Segment per-bar chords into harmonic phrases: runs on one root, or repeating cycles of up to `maxPeriod`
 * roots that last at least two repetitions (`F A♭ F A♭ F A♭` → one phrase, cycle F · A♭). Bars are matched
 * by root so that a riff whose detected quality flickers (C♯7, C♯m, C♯7 …) still reads as one phrase; the
 * label of each slot carries the quality only when its bars agree on it. The segmentation with the fewest
 * phrases wins (longest phrases first, then the shortest period), so an alternating riff becomes one
 * labelled block instead of a barcode of one-bar stripes. Bars without a chord form their own runs and
 * never join a cycle.
 */
export function chordPhrases(chords: readonly (string | null | undefined)[], maxPeriod = 4): ChordPhrase[] {
  const key = chords.map((c) => chordRoot(c));
  const fam = chords.map((c) => chordFamily(c));
  const n = key.length;
  const cost = new Array<number>(n + 1).fill(Number.POSITIVE_INFINITY);
  const pick = new Array<{ p: number; len: number }>(n);
  cost[n] = 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let p = 1; p <= maxPeriod && i + p <= n; p++) {
      if (p > 1 && (key.slice(i, i + p).some((f) => f === null) || !primitiveCycle(key, i, p))) continue;
      let maxLen = p;
      while (i + maxLen < n && key[i + maxLen] === key[i + maxLen - p]) maxLen++;
      for (let len = p > 1 ? 2 * p : 1; len <= maxLen; len++) {
        const c = 1 + cost[i + len];
        if (c < cost[i] || (c === cost[i] && len > pick[i].len)) { cost[i] = c; pick[i] = { p, len }; }
      }
    }
  }
  const out: ChordPhrase[] = [];
  for (let i = 0; i < n;) {
    const { p, len } = pick[i];
    const cycle = Array.from({ length: p }, (_, k) => {
      const at: number[] = [];
      for (let b = i + k; b < i + len; b += p) at.push(b);
      return slotLabel(fam, key[i + k], at);
    });
    out.push({ start: i, end: i + len - 1, period: p, cycle });
    i += len;
  }
  return out;
}

/**
 * Per-bar chords of a human-annotated structure laid on the rendered bar grid (the rule `structureSections`
 * uses for the section lane), so the chord lane, the readout and the `// chords:` line of the generated code
 * all show the same chart. Null when the structure is not laid out, i.e. when its length disagrees with
 * the notes by more than a quarter.
 */
export function structureChords(structure: Section[] | undefined, bars: number, beatsPerBar: number, songBars = bars): (string | null)[] | null {
  if (!structure?.length || bars <= 0 || beatsPerBar <= 0) return null;
  const total = structure.reduce((n, s) => n + s.bars, 0);
  if (total < songBars * 0.75 || total > songBars * 1.25) return null;
  const perBar: (string | null)[] = [];
  let pos = 0; // beats
  for (const s of structure) {
    for (const c of s.chords) {
      const end = pos + c.beats;
      while (pos < end - 1e-9) {
        const bar = Math.floor(pos / beatsPerBar + 1e-9);
        if (perBar[bar] === undefined) perBar[bar] = c.symbol ?? null;
        pos = Math.min(end, (bar + 1) * beatsPerBar);
      }
    }
  }
  return Array.from({ length: bars }, (_, i) => perBar[i] ?? null);
}

const SECTION_ABBR: [RegExp, string][] = [
  [/pre-?chorus/, 'pre'], [/pre-?verse/, 'pre'], [/instrumental/, 'inst'], [/interlude/, 'inter'], [/^trans/, 'trans'],
  [/fade/, 'fade'], [/intro/, 'in'], [/outro/, 'out'], [/verse/, 'vs'], [/chorus/, 'ch'], [/bridge/, 'br'],
  [/ending|coda/, 'end'], [/solo/, 'solo'], [/theme/, 'th'], [/vocal/, 'vox'], [/spoken/, 'spk'],
];
/**
 * Short form of a section label for a block too narrow for the full word: the abbreviations chord
 * charts use (vs, ch, br, pre, inter, trans, out, fade, inst), else the first three letters. Never a lone
 * capital, which reads as a code rather than a word.
 */
export function sectionAbbr(label: string): string {
  const l = label.toLowerCase();
  const hit = SECTION_ABBR.find(([re]) => re.test(l));
  return hit ? hit[1] : l.replace(/[^a-z]/g, '').slice(0, 3) || '';
}

const sectionWord = (label: string) => label.toLowerCase().replace(/[^a-z]/g, '');
/**
 * Abbreviations for every section label of one song, chosen so that no short form is also the start of
 * a *different* section's name in that song: next to a full "intro", "in" and "int" would read as more
 * intros, so intro stays "intro" and interlude becomes "inter". A clashing abbreviation is replaced by the
 * whole label when it is five letters or fewer, else by its first five, six … letters until it is unambiguous.
 */
export function sectionAbbrs(labels: readonly string[]): Map<string, string> {
  const distinct = [...new Set(labels)];
  const first = new Map(distinct.map((l) => [l, sectionAbbr(l)]));
  const out = new Map<string, string>();
  for (const label of distinct) {
    const word = sectionWord(label);
    const clashes = (abbr: string) => distinct.some((o) => o !== label && first.get(o) !== abbr && sectionWord(o).startsWith(abbr));
    const candidates = [first.get(label)!, ...(word.length <= 5 ? [word] : []), ...[5, 6, 7, 8].map((n) => word.slice(0, n)), word];
    out.set(label, candidates.find((c) => c && !clashes(c)) ?? word);
  }
  return out;
}

// ---------- generated code, respelled the way the UI reads it ----------
/**
 * Every chord token of the code's `// chords:` line in the display spelling the readout and the lane use
 * (`A#^7/A` → `B♭maj7/A` in a flat key). Section separators (`|`) and `N` (no chord) pass through. Only that
 * comment line changes: the note patterns are untouched, so the code plays exactly as before.
 */
export function respellChordLine(code: string, flats: boolean): string {
  return code.replace(/^(\/\/ chords: )(.*)$/m, (_, head: string, rest: string) =>
    head + rest.split(' ').map((t) => (t === '|' || t === 'N' || !t ? t : prettyChord(t, flats))).join(' '));
}

/** The code's header `key X` in the display spelling of the key chip (`key A# major` → `key B♭ major`). */
export function respellKeyLine(code: string, tonic: string | undefined, mode: 'major' | 'minor' | undefined): string {
  if (!tonic) return code;
  return code.replace(/^(\/\/ .*\bkey )(?:[A-G][#b]?(?: (?:major|minor))?|unknown)(\.)/m, (_, head: string, tail: string) => `${head}${keyName(tonic, mode ?? 'major')}${tail}`);
}

/**
 * Replace the code's `// chords:` line (or insert one after the `setcpm` line) with `summary`, followed by the
 * `notes` as `// note:` lines. Used when the chart the code would print is not the one the song plays.
 */
export function replaceChordLine(code: string, summary: string, notes: readonly string[] = []): string {
  const block = [`// chords: ${summary}`, ...notes.map((n) => `// note: ${n}`)].join('\n');
  if (/^\/\/ chords: .*$/m.test(code)) return code.replace(/^\/\/ chords: .*$/m, block);
  return code.replace(/^(setcpm\([^\n]*\)\n\n)/m, `$1${block}\n\n`);
}

/**
 * The key of a MIDI transcription estimated from its notes (Krumhansl-Schmuckler over a duration-weighted
 * pitch-class histogram of every pitched track), or undefined when nothing is clear. Used when the annotated
 * chart cannot be aligned with the notes and the annotated key may not be the key the notes are in.
 */
export function midiKey(tracks: readonly { role: string; notes: readonly { pitch: number; duration: number }[] }[]): { tonic: string; mode: 'major' | 'minor' } | undefined {
  const hist = new Array<number>(12).fill(0);
  for (const t of tracks) if (t.role !== 'drums') for (const n of t.notes) hist[((n.pitch % 12) + 12) % 12] += n.duration;
  if (!hist.some((v) => v > 0)) return undefined;
  const k = estimateKey(hist);
  return k.confidence > 0.5 ? { tonic: pcName(k.tonic), mode: k.mode } : undefined;
}

/** Pitch-class weights of the chord roots of `sections`, each root weighted by how long it sounds. */
function rootHistogram(sections: readonly Section[]): number[] {
  const hist = new Array<number>(12).fill(0);
  for (const s of sections) for (const c of s.chords) {
    const root = chordRoot(c.symbol);
    if (root) hist[pitchClass(root)] += c.beats;
  }
  return hist;
}

/**
 * How many semitones the chords read from the notes sit above the annotated chart: the rotation of the chart's
 * root histogram that best matches the detected one. A transcription that is a semitone below the record
 * (In-A-Gadda-Da-Vida: the chart is in D minor, the MIDI plays in C♯) gives -1. Zero when either side is empty.
 */
export function chartShift(chart: readonly Section[], detected: readonly Section[]): number {
  const a = rootHistogram(chart), b = rootHistogram(detected);
  if (!a.some(Boolean) || !b.some(Boolean)) return 0;
  let best = 0, bestScore = -Infinity;
  for (let shift = 0; shift < 12; shift++) {
    let score = 0;
    for (let pc = 0; pc < 12; pc++) score += a[pc] * b[(pc + shift) % 12];
    if (score > bestScore) { bestScore = score; best = shift; }
  }
  return best > 6 ? best - 12 : best;
}

/** `tonic` moved by `semitones` (`D` − 1 → `C#`); undefined stays undefined. */
export function shiftTonic(tonic: string | undefined, semitones: number): string | undefined {
  return tonic ? pcName((pitchClass(tonic) + semitones + 120) % 12) : undefined;
}

// ---------- parts ----------
/**
 * The parts of the generated code as "role · instrument" lines, read from the comment that precedes each
 * `const x = note(...)` (the compiler writes `// role · gm_instrument · …`), for the Parts chip tooltip.
 */
export function partList(code: string): string[] {
  const out: string[] = [];
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^const \w+ = (?:note|n|mini|s|chord|arrange)\(/.test(lines[i])) continue;
    const m = /^\/\/ ([^·\n]+?)(?: · ([^·\n]+?))?(?: · |$)/.exec(lines[i - 1] ?? '');
    if (/^const \w+ = arrange\(/.test(lines[i]) && !m) continue;
    if (/^const \w+_riff\d+ = /.test(lines[i]) && !['bass', 'chords', 'melody', 'drums', 'other'].includes(m?.[1]?.trim() ?? '')) continue;
    const role = m?.[1]?.trim() ?? (lines[i].includes('.pickRestart(') ? /^const (\w+) = /.exec(lines[i])?.[1]?.replace(/_/g, ' ') : undefined) ?? 'part';
    const instrument = (m?.[2] ?? '').trim().replace(/^gm_/, '').replace(/_/g, ' ');
    out.push(instrument && !/^(gain|pan)\b/.test(instrument) ? `${role} · ${instrument}` : role);
  }
  return out;
}

const LEAD_FAMILIES = ['guitar', 'piano', 'sax', 'flute', 'trumpet', 'organ', 'violin', 'strings', 'synth', 'harmonica', 'clarinet', 'oboe', 'trombone', 'horn', 'vibraphone', 'marimba', 'banjo', 'sitar', 'accordion', 'harp', 'cello', 'choir', 'voice', 'brass', 'recorder', 'bass', 'whistle', 'ocarina', 'fiddle', 'bagpipe', 'kalimba', 'koto', 'shamisen', 'shakuhachi', 'tuba', 'bassoon', 'piccolo', 'xylophone', 'celesta', 'glockenspiel', 'dulcimer', 'clavinet', 'harpsichord', 'lead', 'pad', 'bells'];
/**
 * The word a listener uses for a General MIDI instrument label ("electric guitar jazz" → "guitar",
 * "alto sax" → "sax", "lead 2 sawtooth" → "synth"), for the melody switch of an instrumental lead.
 */
export function leadName(instrument: string): string {
  const words = instrument.toLowerCase().split(/\s+/);
  if (/^(lead|pad|fx|synth)\b/.test(instrument.toLowerCase())) return 'synth';
  return words.find((w) => LEAD_FAMILIES.includes(w)) ?? words.slice(0, 2).join(' ');
}

// ---------- derived form ----------
/** Letters for the parts of a derived form, in order of first appearance. */
const FORM_LETTERS = 'ABCDEFGH';
/** More parts than this and the reading is noise, not a form. */
const MAX_FORM_PARTS = 5;
/**
 * Song form read from the chords alone, for MIDI songs that come without an annotated structure: the bars
 * are cut into 8-bar windows (4-bar ones for short songs) and windows whose chord roots agree on at least
 * three quarters of their bars get the same letter, in order of first appearance. Consecutive windows of one
 * letter merge into one part. The 4-bar offset that yields the simplest reading (fewest parts) is used, so a
 * 4-bar intro does not shift every phrase. Nothing is returned when the chords are too sparse, when the song
 * reads as one repeated part (no structure to show) or as more than five different ones (no repetition).
 */
export function deriveForm(chords: readonly (string | null | undefined)[], bars: number = chords.length): TimelineSection[] {
  const n = Math.min(bars, chords.length);
  if (n < 16) return [];
  const roots = Array.from({ length: n }, (_, i) => chordRoot(chords[i]));
  if (roots.filter(Boolean).length < n * 0.5) return [];
  const win = n >= 40 ? 8 : 4;
  let best: { parts: TimelineSection[]; score: number } = { parts: [], score: -1 };
  for (const offset of win === 8 ? [0, 4] : [0]) {
    const r = formParts(roots, n, win, offset);
    if (r.parts.length && r.score > best.score) best = r;
  }
  return best.parts;
}

/**
 * One reading of the form: windows of `win` bars from `offset`. The score is the summed similarity of every
 * window to the part it was matched with (a window that starts a new part scores nothing), so the offset that
 * cuts the song at its real phrase boundaries, where the repeats are exact, reads best.
 */
function formParts(roots: (string | null)[], n: number, win: number, offset: number): { parts: TimelineSection[]; score: number } {
  const none = { parts: [], score: 0 };
  const protos: (string | null)[][] = [];
  const windows: { start: number; bars: number }[] = [];
  for (let b = offset; b < n; b += win) windows.push({ start: b, bars: Math.min(win, n - b) });
  let score = 0, matched = 0;
  const match = (sig: (string | null)[]): number => {
    let best = -1, bestSim = 0;
    for (let p = 0; p < protos.length; p++) {
      const proto = protos[p];
      const len = Math.min(proto.length, sig.length);
      if (len < Math.max(proto.length, sig.length) * 0.5) continue; // a short tail is not compared with a whole part
      let same = 0;
      for (let i = 0; i < len; i++) if (proto[i] === sig[i]) same++;
      if (same >= len * 0.75 && same / len > bestSim) { best = p; bestSim = same / len; }
    }
    score += bestSim;
    if (best >= 0) matched++;
    return best;
  };
  const labelOf = windows.map((w) => {
    const sig = roots.slice(w.start, w.start + w.bars);
    let found = match(sig);
    if (found < 0) { found = protos.length; protos.push(sig); }
    return found;
  });
  // Only a confident reading is shown: few parts, most windows a repeat of an earlier one, and the repeats
  // near-exact. Chords read from noisy MIDI seldom pass, and then no lane is better than a wrong one.
  const distinct = new Set(labelOf).size;
  if (distinct < 2 || distinct > MAX_FORM_PARTS || matched < windows.length * 0.6 || score < matched * 0.85) return none;
  // The bars before the first full window (a 4-bar lead-in): their own part when they carry chords that match
  // no other part, otherwise the head of the first part.
  if (offset > 0) {
    const sig = roots.slice(0, offset);
    const found = sig.filter(Boolean).length * 2 >= sig.length ? match(sig) : labelOf[0];
    windows.unshift({ start: 0, bars: offset });
    labelOf.unshift(found >= 0 ? found : protos.push(sig) - 1);
    if (new Set(labelOf).size > MAX_FORM_PARTS) return none;
  }
  const out: TimelineSection[] = [];
  const letters = new Map<number, string>();
  windows.forEach((w, i) => {
    let label = letters.get(labelOf[i]);
    if (!label) { label = FORM_LETTERS[letters.size]; letters.set(labelOf[i], label); }
    const last = out[out.length - 1];
    if (last && last.label === label) last.bars += w.bars;
    else out.push({ label, startBar: w.start, bars: w.bars });
  });
  return { parts: out, score };
}

/** Whether a section label is one of the derived form letters (as opposed to an annotated "verse"). */
export const isFormLabel = (label: string) => label.length === 1 && FORM_LETTERS.includes(label);
/** Colour of a derived part: a calm palette that never clashes with the annotated section colours. */
const FORM_COLORS = ['#8fb8de', '#c9a8e8', '#a9d9b8', '#e8c48f', '#e39fb0', '#9fd3d8', '#d2c48f', '#b8b8d8'];
export function formColor(label: string): string { return FORM_COLORS[FORM_LETTERS.indexOf(label)] ?? '#b6c8d9'; }

// ---------- chord lane packing ----------
export interface PhraseItem {
  start: number;
  /** Inclusive. */
  end: number;
  /** A run of bars without a chord. */
  none: boolean;
  /** Whether a label fits inside this phrase at the current zoom. */
  fits: boolean;
  period: number;
  /** Display chord of each slot of one repetition. */
  pretty: string[];
}
export interface LaneBlock<T extends PhraseItem = PhraseItem> {
  start: number;
  end: number;
  kind: '' | 'cycle' | 'mixed' | 'none';
  /** The phrase whose label and tint the block carries (null for `none` and `mixed`). */
  main: T | null;
  /** Short phrases folded into this block (passing chords of a `main`, or every phrase of a `mixed` block). */
  extra: T[];
}
/**
 * Pack zoomed-out chord phrases into lane blocks. Labelled phrases and phrases of three bars or more (tinted,
 * their colour still says what they are built on) become blocks of their own. Shorter unlabelled phrases are
 * passing chords: a single one is folded into the labelled block before it (drawn there as a stripe in its own
 * colour, and listed in the tooltip), and a run of two or more becomes "mixed" blocks that read as quick changes.
 * A passing chord with nothing before it to join (the pickup bar of a song, the chord after a silence) is a
 * sliver of its own, so what the lane highlights under the playhead is always the chord the readout names.
 * A long run (a progression that changes chord every bar) is cut into blocks of at most `maxMixedBars`, so each
 * carries the chord it starts on; the caller cuts at section boundaries so a block never straddles two sections.
 */
export function packPhrases<T extends PhraseItem>(items: readonly T[], maxMixedBars = 8): LaneBlock<T>[] {
  const out: LaneBlock<T>[] = [];
  const short = (it: PhraseItem) => !it.none && !it.fits && it.end - it.start + 1 < 3;
  const push = (b: LaneBlock<T>) => { out.push(b); };
  for (let i = 0; i < items.length;) {
    const it = items[i];
    if (it.none) { push({ start: it.start, end: it.end, kind: 'none', main: null, extra: [] }); i++; continue; }
    if (!short(it)) { push({ start: it.start, end: it.end, kind: it.period > 1 ? 'cycle' : '', main: it, extra: [] }); i++; continue; }
    let j = i;
    while (j < items.length && short(items[j])) j++;
    const run = items.slice(i, j);
    const prev = out[out.length - 1];
    if (run.length === 1 && prev && prev.main && prev.kind !== 'mixed') { prev.end = it.end; prev.extra.push(it); }
    else if (run.length === 1) push({ start: it.start, end: it.end, kind: '', main: it, extra: [] });
    else {
      // Chunks of at most maxMixedBars, as even as the phrase boundaries allow.
      const total = run[run.length - 1].end - run[0].start + 1;
      const target = Math.ceil(total / Math.ceil(total / maxMixedBars));
      let chunk: T[] = [];
      for (const r of run) {
        if (chunk.length && r.end - chunk[0].start + 1 > target) { push({ start: chunk[0].start, end: chunk[chunk.length - 1].end, kind: 'mixed', main: null, extra: chunk }); chunk = []; }
        chunk.push(r);
      }
      if (chunk.length) push({ start: chunk[0].start, end: chunk[chunk.length - 1].end, kind: 'mixed', main: null, extra: chunk });
    }
    i = j;
  }
  return out;
}

/**
 * Labels for a phrase whose chords cycle, widest first. Repeats inside one cycle are collapsed (`Am Am C C` →
 * `Am · C`: the block's hairlines already say how long each repetition is), and when the whole cycle does not
 * fit, its head is kept and the rest stands as an ellipsis: `F · B♭ · C · Dm` → `F · B♭ · C …` → `F · B♭ …` →
 * `F …`. The ellipsis is the one sign everybody reads as "and more" (the tooltip lists every chord).
 */
export function cycleLabels(chords: readonly string[]): string[] {
  const cycle = chords.filter((c, i) => c && c !== chords[i - 1]);
  if (cycle.length > 1 && cycle[cycle.length - 1] === cycle[0]) cycle.pop(); // C Am C → C · Am (the cycle wraps)
  if (!cycle.length) return [];
  const out = [cycle.join(' · ')];
  // Narrower variants name the chords that still fit and count the ones dropped, so a truncated label
  // still says how much of the cycle it is hiding ("F · B♭ +2") rather than trailing off into an ellipsis.
  for (let k = cycle.length - 1; k >= 1; k--) out.push(`${cycle.slice(0, k).join(' · ')} +${cycle.length - k}`);
  return out;
}

/** Longest title that keeps a browser tab and a history entry readable. */
const TITLE_MAX = 60;
/**
 * The document title of a song page: "Song — Artist · Strudelify", with a very long song title cut at a word
 * boundary and finished with an ellipsis, so the tab and the history entry still name the song.
 */
export function pageTitle(title: string, artist: string): string {
  let t = title.trim();
  if (t.length > TITLE_MAX) {
    const cut = t.slice(0, TITLE_MAX - 1);
    const space = cut.lastIndexOf(' ');
    t = `${(space > TITLE_MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s,:;–—-]+$/, '')}…`;
  }
  return `${t} — ${artist} · Strudelify`;
}
