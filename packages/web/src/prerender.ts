/**
 * The site's static pages, as HTML strings, for search engines and link previews (see the prerender plugin in
 * vite.config.ts, which writes them into the build):
 * - a page per song at `song/<id>/`: the app itself (the built index.html), opened on the song, with its own
 *   title, description, canonical address, Open Graph card and structured data, and the start of the song's
 *   code (the Full arrangement the app opens on) as text until the editor loads;
 * - a page per artist at `artist/<slug>/` and an A–Z index at `artists/`, plain pages linking to the songs;
 * - the sitemap and robots.txt.
 * Paths are under the site's base path (see `setBase`). Addresses are absolute when the site's origin is known
 * (`site`, e.g. `https://www.arthurenard.me`), as canonical links, Open Graph and the sitemap require; without it
 * those are left out. Keep this module free of DOM access.
 */
import type { IndexEntry } from '@strudelify/core';
import { esc, pageTitle, displayArtist, prettyKey, titleSize, songPath, artistPath, artistSlug, sitePath, byPopularity, albumLine, type ArtistGroup } from './ui.js';
import { artistSongCard, moreByArtist, cardCover, LANDING_POOL_ID, type Covers } from './landing.js';
import { coverInfo } from './covers.js';

export const SITE_NAME = 'Strudelify';
/** The Open Graph image every page shares (1200 x 630, see tools/make-icons.mjs), at the site's root. */
export const OG_IMAGE = 'og.png';

/** The landing pool's `<script>` is only for the home page's cards (see `bakeLanding`). */
export const LANDING_POOL_SCRIPT = new RegExp(`\\s*<script type="application/json" id="${LANDING_POOL_ID}">[\\s\\S]*?<\\/script>`);

/** What a song page shows beyond its index entry: the code the app opens the song on. */
export interface SongFacts { code?: string }
/** How much of the code a page carries as text: its start (the editor, which holds all of it, replaces the text). */
export const STATIC_CODE_LINES = 200;
/** An artist's songs as cards, each with its cover from the catalogue. */
const songCards = (songs: readonly IndexEntry[], covers?: Covers | null) => songs.map((e) => artistSongCard({ ...e, cover: cardCover(covers, e.id) })).join('');

/** A song's key in the display spelling ("B♭ major"), or undefined when the index has none. */
const keyOf = (e: Pick<IndexEntry, 'key'>): string | undefined => prettyKey(e.key) || undefined;
/** Where a song's notes come from, as a listener reads it. */
const origin = (e: Pick<IndexEntry, 'sources' | 'provenance'>) =>
  e.provenance?.provider === 'pdmx' ? 'a score arrangement' : e.sources.includes('midi') ? 'a MIDI transcription' : 'a chord chart';

/** A song page's title, as the app sets it (see `pageTitle`). */
export const songTitle = (e: Pick<IndexEntry, 'title'>, artist: string): string => pageTitle(e.title, artist);

/** A song page's description (about 155 characters or fewer): what the page gives, and the song's facts. */
export function songDescription(e: Pick<IndexEntry, 'title' | 'bpm' | 'key' | 'sources' | 'provenance'>, artist: string): string {
  const facts = [keyOf(e), e.bpm ? `${Math.round(e.bpm)} bpm` : ''].filter(Boolean).join(', ');
  const text = `${e.title} by ${artist} as Strudel live-coding code: play it, edit it, open it in strudel.cc. From ${origin(e)}${facts ? ` (${facts})` : ''}.`;
  return text.length <= 160 ? text : `${text.slice(0, 157).replace(/\s+\S*$/, '')}…`;
}

/** The `<head>` tags that name a page: canonical address, description, Open Graph and Twitter cards. */
function metaTags(p: { site: string | null; path: string; title: string; description: string; type: string }): string {
  const url = p.site ? `${p.site}${p.path}` : null;
  return [
    `<meta name="description" content="${esc(p.description)}" />`,
    url && `<link rel="canonical" href="${esc(url)}" />`,
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    `<meta property="og:type" content="${p.type}" />`,
    `<meta property="og:title" content="${esc(p.title)}" />`,
    `<meta property="og:description" content="${esc(p.description)}" />`,
    url && `<meta property="og:url" content="${esc(url)}" />`,
    p.site && `<meta property="og:image" content="${esc(p.site + sitePath(OG_IMAGE))}" />`,
    p.site && '<meta property="og:image:width" content="1200" /><meta property="og:image:height" content="630" />',
    `<meta name="twitter:card" content="${p.site ? 'summary_large_image' : 'summary'}" />`,
  ].filter(Boolean).join('\n    ');
}

/** Structured data as a `<script type="application/ld+json">` (data, never run: the CSP does not apply to it). */
const jsonLd = (data: unknown) => `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
const crumbs = (site: string, items: [string, string][]) => ({
  '@type': 'BreadcrumbList',
  itemListElement: items.map(([name, path], i) => ({ '@type': 'ListItem', position: i + 1, name, item: `${site}${path}` })),
});

/** The icons a page links: search results and home screens take files, not the data: URL the dev page uses. */
const icons = () => [
  `<link rel="icon" href="${sitePath('favicon.svg')}" type="image/svg+xml" />`,
  `<link rel="icon" href="${sitePath('favicon-96.png')}" sizes="96x96" type="image/png" />`,
  `<link rel="apple-touch-icon" href="${sitePath('apple-touch-icon.png')}" />`,
].join('\n    ');

/** The shell's `<head>`: its title and description replaced, the given tags added, the favicon files linked. */
function withHead(shell: string, title: string, tags: string): string {
  return shell
    .replace(/<link rel="icon" href="data:[^"]*" \/>/, icons())
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
    .replace(/\s*<meta name="description" content="[^"]*" \/>/, '')
    .replace('</head>', `    ${tags}\n  </head>`);
}

/** The home page (the built index.html) with its canonical address, cards and structured data (a site with a search). */
export function homePage(shell: string, site: string | null): string {
  const description = 'Type a song name, get Strudel live-coding code that plays it: an instrumental loop and the full arrangement, compiled from open transcriptions. No AI.';
  const title = `${SITE_NAME}: play any song as Strudel live-coding code`;
  const home = sitePath();
  const tags = [metaTags({ site, path: home, title, description, type: 'website' }), site && jsonLd({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', name: SITE_NAME, url: `${site}${home}`, potentialAction: { '@type': 'SearchAction', target: `${site}${home}?q={search_term_string}`, 'query-input': 'required name=search_term_string' } },
      { '@type': 'WebApplication', name: SITE_NAME, url: `${site}${home}`, applicationCategory: 'MultimediaApplication', operatingSystem: 'Any', offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' } },
    ],
  })].filter(Boolean).join('\n    ');
  return withHead(shell, title, tags);
}

/**
 * A song's page: the app opened on the song. The landing's example pool is dropped (the app reads the index
 * instead), the song section shows the title, artist, key and tempo, the start of its code as text and the
 * artist's other songs, and the head names the page. The app takes over when it loads.
 */
export function songPage(shell: string, e: IndexEntry, group: readonly IndexEntry[], facts: SongFacts, site: string | null, covers?: Covers | null): string {
  const artist = displayArtist(e.artist);
  const title = songTitle(e, artist), description = songDescription(e, artist), path = songPath(e.id);
  const key = keyOf(e);
  const data = site && jsonLd({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'MusicComposition', name: e.title, url: `${site}${path}`, ...(key ? { musicalKey: key } : {}), ...(e.year ? { dateCreated: String(e.year) } : {}),
        recordedAs: { '@type': 'MusicRecording', name: e.title, byArtist: { '@type': 'MusicGroup', name: artist, url: `${site}${artistPath(artist)}` } } },
      crumbs(site, [['Home', sitePath()], ['Artists', sitePath('artists/')], [artist, artistPath(artist)], [e.title, path]]),
    ],
  });
  const chips = [key && ['Key', key], e.bpm && ['Tempo', `${Math.round(e.bpm)} bpm`]].filter((c): c is [string, string] => !!c)
    .map(([k, v]) => `<span class="chip"><span class="k">${k}</span>${esc(v)}</span>`).join('');
  const more = moreByArtist(e, group);
  // The cover the app would find (see covers.ts), drawn before any script runs; the app keeps it.
  const cover = coverInfo(covers?.get(e.id));
  let html = withHead(shell, title, [metaTags({ site, path, title, description, type: 'music.song' }), data].filter(Boolean).join('\n    '))
    .replace(LANDING_POOL_SCRIPT, '')
    .replace('<section id="song" class="song" hidden aria-label="Song">', '<section id="song" class="song" aria-label="Song">')
    .replace('<section id="empty" class="empty" aria-label="Introduction">', '<section id="empty" class="empty" hidden aria-label="Introduction">')
    .replace('<p class="eyebrow" id="album"></p>', `<p class="eyebrow" id="album">${esc(albumLine(cover ?? {}, e))}</p>`)
    .replace('<h1 id="title" class="title"></h1>', `<h1 id="title" class="title ${titleSize(e.title)}">${esc(e.title)}</h1>`)
    .replace('<p class="artist" id="artist"></p>', `<p class="artist" id="artist"><a href="${artistPath(artist)}">${esc(artist)}</a></p>`)
    .replace('<div class="chips" id="chips"></div>', `<div class="chips" id="chips">${chips}</div>`);
  if (cover?.art) {
    html = html
      .replace('<img id="art" alt="" hidden decoding="async" />', `<img id="art" alt="${esc(`${e.title} cover art`)}" src="${esc(cover.art)}" data-song="${esc(e.id)}" decoding="async" />`)
      .replace('<div id="art-fallback" class="art-fallback" aria-hidden="true"></div>', '<div id="art-fallback" class="art-fallback" aria-hidden="true" hidden></div>');
  }
  if (facts.code) {
    const lines = facts.code.split('\n');
    const shown = lines.length > STATIC_CODE_LINES ? [...lines.slice(0, STATIC_CODE_LINES), `// … ${lines.length - STATIC_CODE_LINES} more lines`] : lines;
    html = html
      .replace('<span id="code-lines" class="code-lines"></span>', `<span id="code-lines" class="code-lines">${lines.length} lines</span>`)
      .replace('<div class="code-skel"', `<pre id="code-static" class="code-static">${esc(shown.join('\n'))}</pre>\n            <div class="code-skel"`);
  }
  if (more.length) {
    html = html.replace(/<section class="more" id="more" aria-labelledby="more-title" hidden>[\s\S]*?<\/section>/, [
      '<section class="more" id="more" aria-labelledby="more-title">',
      `          <h2 class="more-title" id="more-title">More by <a id="more-artist" href="${artistPath(artist)}">${esc(artist)}</a></h2>`,
      `          <div class="examples" id="more-songs">${songCards(more, covers)}</div>`,
      '        </section>',
    ].join('\n'));
  }
  return html;
}

/** A page without its indentation (a tenth of a song page), the `<pre>` code left as it is. */
export const compact = (html: string) => html.split(/(<pre[\s\S]*?<\/pre>)/).map((part, i) => (i % 2 ? part : part.replace(/\n\s+/g, '\n'))).join('');

/** The 404 page: the app, which shows its "not found" view for an unknown song address; not for search engines. */
export const notFoundPage = (shell: string) => shell.replace('</head>', '    <meta name="robots" content="noindex" />\n  </head>');

// ---------- artist pages ----------

/**
 * The artists of the catalogue, each with its songs (most popular first) and its page's slug, in name order.
 * Songs group by slug, so every artist has a page, a name in another script too (see `artistSlug`).
 */
export function artists(entries: readonly IndexEntry[]): (ArtistGroup & { slug: string })[] {
  const bySlug = new Map<string, ArtistGroup & { slug: string }>();
  for (const e of entries) {
    const name = displayArtist(e.artist), slug = artistSlug(name);
    (bySlug.get(slug) ?? bySlug.set(slug, { name, slug, entries: [] }).get(slug)!).entries.push(e);
  }
  return [...bySlug.values()].map((g) => ({ ...g, entries: byPopularity(g.entries) })).sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
}

/** The letter an artist is filed under in the A–Z index: its first Latin letter, `0-9`, or `other`. */
export function letterOf(name: string): string {
  const c = name.normalize('NFKD').replace(/^(the|a|an)\s+/i, '').toLowerCase().match(/[a-z0-9]/)?.[0];
  return !c ? 'other' : /\d/.test(c) ? '0-9' : c;
}
export const LETTERS = [...'abcdefghijklmnopqrstuvwxyz', '0-9', 'other'];
const letterLabel = (l: string) => (l === 'other' ? 'Other' : l.toUpperCase());

/** The frame of a plain page: the site's header and footer, its stylesheet and a CSP without scripts. */
function plainPage(p: { css: string; site: string | null; path: string; title: string; description: string; data?: unknown; body: string }): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>${esc(p.title)}</title>
    <meta name="color-scheme" content="dark" />
    <meta name="theme-color" content="#0a0c10" />
    ${icons()}
    <link rel="stylesheet" href="${esc(p.css)}" />
    ${metaTags({ site: p.site, path: p.path, title: p.title, description: p.description, type: 'website' })}
    ${p.site && p.data ? jsonLd(p.data) : ''}
  </head>
  <body>
    <header class="top">
      <a class="brand" href="${sitePath()}" aria-label="${SITE_NAME} home">
        <svg class="brand-mark" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="14" fill="currentColor" opacity=".12"/><path d="M18 44V22l9 6v16zM29 44V16l9 6v22zM40 44V26l9 6v12z" fill="currentColor"/></svg>
        <span class="brand-name">${SITE_NAME}</span>
      </a>
      <form class="plain-search" action="${sitePath()}" method="get" role="search"><input name="q" type="search" aria-label="Search songs and artists" placeholder="Search a song or artist" /></form>
    </header>
    <main id="main" class="main plain">
${p.body}
    </main>
    <footer class="foot"><div class="foot-inner"><span class="foot-brand">${SITE_NAME}</span><span class="foot-links"><a href="${sitePath()}">Home</a> · <a href="${sitePath('artists/')}">All artists</a> · Player: <a href="https://strudel.cc" rel="noopener">Strudel</a> (AGPL-3.0)</span></div></footer>
  </body>
</html>
`;
}

const letterNav = (current?: string) => `<nav class="letters" aria-label="Artists by letter">${LETTERS.map((l) => (l === current ? `<span aria-current="page">${letterLabel(l)}</span>` : `<a href="${sitePath(`artists/${l}/`)}">${letterLabel(l)}</a>`)).join('')}</nav>`;
const count = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

/** An artist's page: every song of the artist in the catalogue, as the landing page's cards. */
export function artistPage(g: ArtistGroup & { slug: string }, css: string, site: string | null, covers?: Covers | null): string {
  const path = sitePath(`artist/${g.slug}/`);
  const songs = g.entries.length;
  return plainPage({
    css, site, path,
    title: `${g.name}: ${count(songs, 'song')} as Strudel code · ${SITE_NAME}`,
    description: `Play ${count(songs, 'song')} by ${g.name} as Strudel live-coding code: instrumental loops and full arrangements to edit and open in strudel.cc.`,
    data: site && { '@context': 'https://schema.org', '@graph': [
      { '@type': 'MusicGroup', name: g.name, url: `${site}${path}`, track: g.entries.slice(0, 50).map((e) => ({ '@type': 'MusicRecording', name: e.title, url: `${site}${songPath(e.id)}` })) },
      crumbs(site, [['Home', sitePath()], ['Artists', sitePath('artists/')], [g.name, path]]),
    ] },
    body: `      <section class="plain-page">
        <nav class="crumbs" aria-label="Breadcrumb"><a href="${sitePath()}">Home</a> › <a href="${sitePath('artists/')}">Artists</a> › <span aria-current="page">${esc(g.name)}</span></nav>
        <h1>${esc(g.name)}</h1>
        <p class="lede">${count(songs, 'song')} to play as Strudel live-coding code. Open one to hear its loop, edit it, or take it to strudel.cc.</p>
        <div class="examples">${songCards(g.entries, covers)}</div>
      </section>`,
  });
}

/** An A–Z page of artists (`letter`), or the index of letters with the artists who have the most songs (none). */
export function artistsPage(all: (ArtistGroup & { slug: string })[], css: string, site: string | null, letter?: string): string {
  const listed = letter ? all.filter((g) => letterOf(g.name) === letter) : [...all].sort((a, b) => b.entries.length - a.entries.length).slice(0, 60);
  const path = sitePath(letter ? `artists/${letter}/` : 'artists/');
  const heading = letter ? `Artists: ${letterLabel(letter)}` : 'Artists';
  const songs = all.reduce((n, g) => n + g.entries.length, 0);
  return plainPage({
    css, site, path,
    title: `${heading} · ${SITE_NAME}`,
    description: letter ? `Artists under ${letterLabel(letter)} whose songs play as Strudel live-coding code on ${SITE_NAME}.`
      : `${count(all.length, 'artist')} and ${count(songs, 'song')} to play as Strudel live-coding code, A to Z.`,
    data: site && crumbs(site, letter ? [['Home', sitePath()], ['Artists', sitePath('artists/')], [letterLabel(letter), path]] : [['Home', sitePath()], ['Artists', path]]),
    body: `      <section class="plain-page">
        <nav class="crumbs" aria-label="Breadcrumb"><a href="${sitePath()}">Home</a> › ${letter ? `<a href="${sitePath('artists/')}">Artists</a> › <span aria-current="page">${letterLabel(letter)}</span>` : '<span aria-current="page">Artists</span>'}</nav>
        <h1>${esc(heading)}</h1>
        <p class="lede">${letter ? count(listed.length, 'artist') : `${count(all.length, 'artist')}, ${count(songs, 'song')}. The artists with the most songs:`}</p>
        ${letterNav(letter)}
        <ul class="artist-list">${listed.map((g) => `<li><a href="${sitePath(`artist/${g.slug}/`)}">${esc(g.name)}</a> <span class="n">${g.entries.length}</span></li>`).join('')}</ul>
      </section>`,
  });
}

// ---------- sitemap ----------

/** The sitemap: the home page, the artist index and pages, and every song page (paths under the site's base). */
export function sitemap(site: string, paths: readonly string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${paths.map((p) => `  <url><loc>${esc(site + p)}</loc></url>`).join('\n')}\n</urlset>\n`;
}
/**
 * robots.txt, which crawlers only read at the root of a host: under a base path it is a copy for the host's own
 * robots.txt, whose Sitemap line must name this sitemap (see LAUNCH.md).
 */
export const robots = (site: string | null) => `User-agent: *\nAllow: /\n${site ? `Sitemap: ${site}${sitePath('sitemap.xml')}\n` : ''}`;

