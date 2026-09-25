/**
 * The landing page's example cards and song count, as HTML strings. Used in the browser (search.ts renders the
 * same card for the not-found page; main.ts fills the landing cards once the index is in) and by the Vite
 * plugin in vite.config.ts, which bakes the song count and fallback cards into index.html at dev/build time.
 * Keep this module free of DOM access.
 */
import { normaliseText, type IndexEntry } from '@strudelify/core';
import { esc, displayArtist, byPopularity, canonicalArtists, setArtistAliases, songPath, rowFacts } from './ui.js';
import { songTint, initial } from './tint.js';
import { SPOTIFY_POPULAR_IDS } from './popular-ids.js';

export const LANDING_EXAMPLE_COUNT = 4;
export const LANDING_EXAMPLE_POOL = 200;

/**
 * Four songs to put on the landing page: a uniform sample from the 200 library tracks with the most
 * Spotify streams, or from the catalogue's own popularity ranking when those ids are not in `entries`.
 */
export function pickLandingExamples<E extends Pick<IndexEntry, 'id' | 'title' | 'popularity'>>(
  entries: readonly E[],
  count = LANDING_EXAMPLE_COUNT,
  random: () => number = Math.random,
): E[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const preferred = SPOTIFY_POPULAR_IDS.map((id) => byId.get(id)).filter((e): e is E => !!e);
  const pool = (preferred.length >= count ? preferred : byPopularity(entries)).slice(0, LANDING_EXAMPLE_POOL);
  if (pool.length <= count) return pool.slice();
  const shuffled = pool.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, count);
}

/**
 * What a landing card needs of a song, for every song the cards may show (see `pickLandingExamples`), baked into
 * index.html so the landing page can draw its cards without the 2.8 MB index. The artist is already the display
 * spelling (see `displayArtist`), which needs the whole index to decide.
 */
export interface LandingEntry extends Pick<IndexEntry, 'id' | 'title' | 'artist' | 'year' | 'sources'> {
  /** The artist as shown (`artist` stays as the index spells it: the tile colour is derived from it). */
  display: string;
}
export const LANDING_POOL_ID = 'landing-pool';
export function landingPool(entries: readonly IndexEntry[]): LandingEntry[] {
  return pickLandingExamples(entries, LANDING_EXAMPLE_POOL, () => 0).map((e) => ({ id: e.id, title: e.title, artist: e.artist, display: displayArtist(e.artist), ...(e.year ? { year: e.year } : {}), sources: e.sources }));
}
/** The pool as the `<script type="application/json">` index.html carries: `<` escaped, so no title can end the element. */
export const landingPoolScript = (pool: readonly LandingEntry[]) =>
  `<script type="application/json" id="${LANDING_POOL_ID}">${JSON.stringify(pool).replace(/</g, '\\u003c')}</script>`;

/** A song as a card shows it: an index entry, or a landing-pool entry that carries its display artist. */
export type CardEntry = Pick<IndexEntry, 'id' | 'title' | 'artist' | 'year'> & { display?: string };
const cardArtist = (e: CardEntry) => e.display ?? displayArtist(e.artist);

/** Card subtitle: artist and year, the two things a listener knows a song by (the dataset is not one of them). */
export const cardSubtitle = (e: CardEntry) => [cardArtist(e), e.year].filter(Boolean).join(' · ');

function card(e: CardEntry, subtitle: string): string {
  return `<a class="ex" href="${songPath(e.id)}" style="--tile:${songTint(e)}" title="${esc(`${e.title} — ${cardArtist(e)}`)}">` +
    `<span class="ex-tile" aria-hidden="true">${esc(initial(e.title))}</span>` +
    `<span class="ex-text"><span class="ex-t">${esc(e.title)}</span><span class="ex-a">${esc(subtitle)}</span></span></a>`;
}
/** Example-card HTML shared by the landing page, the not-found page and the baked index.html. */
export const exampleCard = (e: CardEntry): string => card(e, cardSubtitle(e));
/** A card in a list of one artist's songs (an artist page, "More by"): the song's year, key and tempo stand where the artist would repeat. */
export const artistSongCard = (e: CardEntry & Pick<IndexEntry, 'key' | 'bpm'>): string => card(e, rowFacts(e) || cardSubtitle(e));

/** Songs a song page suggests by the same artist. */
export const MORE_COUNT = 8;
/**
 * Up to `limit` other songs of `group` (the artist's songs), most popular first, one per title: alternate
 * transcriptions of the song on the page, or of another, are not suggested twice.
 */
export function moreByArtist<E extends Pick<IndexEntry, 'id' | 'title' | 'popularity'>>(entry: Pick<IndexEntry, 'id' | 'title'>, group: readonly E[], limit = MORE_COUNT): E[] {
  const seen = new Set([normaliseText(entry.title)]);
  return byPopularity(group).filter((e) => {
    const title = normaliseText(e.title);
    if (e.id === entry.id || seen.has(title)) return false;
    seen.add(title);
    return true;
  }).slice(0, limit);
}

/** Count catalogue entries: alternate transcriptions do not constitute distinct songs. */
export const browseLabel = (count: number | null) => (count !== null ? `Browse ${count.toLocaleString('en-US')} library ${count === 1 ? 'entry' : 'entries'}` : 'Browse songs');
export const searchPlaceholder = (count: number | null) => (count !== null ? `Search ${count.toLocaleString('en-US')} library ${count === 1 ? 'entry' : 'entries'}` : 'Search a song or artist');

/** An example card, `<a class="ex" href="…/song/<id>/">`: under the site's base path, or Vite's `%BASE_URL%` in the source. */
const CARD = /<a class="ex" href="[^"]*?song\/([^"/]+)\/"[^>]*>[\s\S]*?<\/a>/g;
/** The example cards of an HTML document, in order (their ids). */
export const exampleIds = (html: string): string[] => [...html.matchAll(CARD)].map((m) => decodeURIComponent(m[1]));

/**
 * index.html with the database's facts baked in: the song count in the CTA and the search placeholder, and each
 * example card rendered from its index entry (a card whose id is not in the index is dropped, as the browser would
 * hide it). Without entries the markup is left alone: the browser fills it in once the index loads.
 */
export function bakeLanding(html: string, entries: readonly IndexEntry[] | null): string {
  const count = entries?.length ?? null;
  let out = html
    .replace(/(<span id="cta-label">)[^<]*(<\/span>)/, `$1${esc(browseLabel(count))}$2`)
    .replace(/(<input id="q"[^>]*?placeholder=")[^"]*(")/, `$1${esc(searchPlaceholder(count))}$2`);
  if (!entries) return out;
  // Artists spelled the way the browser shows them once the index is in.
  setArtistAliases(canonicalArtists(entries));
  const byId = new Map(entries.map((e) => [e.id, e]));
  out = out.replace(CARD, (_card, id: string) => {
    const e = byId.get(decodeURIComponent(id));
    return e ? exampleCard(e) : '';
  });
  return out.replace('</body>', `  ${landingPoolScript(landingPool(entries))}\n  </body>`);
}
