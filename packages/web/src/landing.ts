/**
 * The landing page's example cards and song count, as HTML strings. Used in the browser (search.ts renders the
 * same card for the not-found page; main.ts fills the landing cards once the index is in) and by the Vite
 * plugin in vite.config.ts, which bakes the song count and fallback cards into index.html at dev/build time.
 * Keep this module free of DOM access.
 */
import type { IndexEntry } from '@strudelify/core';
import { esc, displayArtist, byPopularity } from './ui.js';
import { songTint, initial } from './tint.js';
import { SPOTIFY_POPULAR_IDS } from './popular-ids.js';

export const LANDING_EXAMPLE_COUNT = 4;
export const LANDING_EXAMPLE_POOL = 200;

/**
 * Four songs to put on the landing page: a uniform sample from the 200 library tracks with the most
 * Spotify streams, or from the catalogue's own popularity ranking when those ids are not in `entries`.
 */
export function pickLandingExamples(
  entries: readonly IndexEntry[],
  count = LANDING_EXAMPLE_COUNT,
  random: () => number = Math.random,
): IndexEntry[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const preferred = SPOTIFY_POPULAR_IDS.map((id) => byId.get(id)).filter((e): e is IndexEntry => !!e);
  const pool = (preferred.length >= count ? preferred : byPopularity(entries)).slice(0, LANDING_EXAMPLE_POOL);
  if (pool.length <= count) return pool.slice();
  const shuffled = pool.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, count);
}

/** Card subtitle: artist and year, the two things a listener knows a song by (the dataset is not one of them). */
export const cardSubtitle = (e: IndexEntry) => [displayArtist(e.artist), e.year].filter(Boolean).join(' · ');

/** Example-card HTML shared by the landing page, the not-found page and the baked index.html. */
export function exampleCard(e: IndexEntry): string {
  return `<a class="ex" href="#${encodeURIComponent(e.id)}" style="--tile:${songTint(e)}" title="${esc(`${e.title} — ${displayArtist(e.artist)}`)}">` +
    `<span class="ex-tile" aria-hidden="true">${esc(initial(e.title))}</span>` +
    `<span class="ex-text"><span class="ex-t">${esc(e.title)}</span><span class="ex-a">${esc(cardSubtitle(e))}</span></span></a>`;
}

/** Count catalogue entries: alternate transcriptions do not constitute distinct songs. */
export const browseLabel = (count: number | null) => (count !== null ? `Browse ${count.toLocaleString('en-US')} library ${count === 1 ? 'entry' : 'entries'}` : 'Browse songs');
export const searchPlaceholder = (count: number | null) => (count !== null ? `Search ${count.toLocaleString('en-US')} library ${count === 1 ? 'entry' : 'entries'}` : 'Search a song or artist');

/** The `<a class="ex" href="#id">` cards of an HTML document, in order (their ids). */
export const exampleIds = (html: string): string[] => [...html.matchAll(/<a class="ex" href="#([^"]+)"[^>]*>[\s\S]*?<\/a>/g)].map((m) => decodeURIComponent(m[1]));

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
  const byId = new Map(entries.map((e) => [e.id, e]));
  out = out.replace(/<a class="ex" href="#([^"]+)"[^>]*>[\s\S]*?<\/a>/g, (whole, id: string) => {
    const e = byId.get(decodeURIComponent(id));
    return e ? exampleCard(e) : '';
  });
  return out;
}
