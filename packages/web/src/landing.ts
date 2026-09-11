/**
 * The landing page's example cards and song count, as HTML strings. Used in the browser (search.ts renders the
 * same card for the not-found page; main.ts re-hydrates the landing cards once the index is in) and by the Vite
 * plugin in vite.config.ts, which bakes them into index.html at dev/build time from the database index, so the
 * first paint already carries the count, the years and the tile colours: nothing changes width when the index
 * arrives. Keep this module free of DOM access.
 */
import type { IndexEntry } from '@strudelify/core';
import { esc, displayArtist } from './ui.js';
import { songTint, initial } from './tint.js';

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
