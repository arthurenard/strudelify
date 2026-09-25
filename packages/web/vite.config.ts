import { defineConfig, type Connect, type Plugin } from 'vite';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import type { IndexEntry } from '@strudelify/core';
import { bakeLanding } from './src/landing.js';
import { songPath, sitePath, setBase, setArtistAliases, canonicalArtists } from './src/ui.js';
import { homePage, songPage, notFoundPage, artists, artistPage, artistsPage, sitemap, robots, compact, LETTERS } from './src/prerender.js';
import { readCovers, coverShards, COVER_SHARDS, type Cover } from './src/covers.js';

const DB = path.resolve(import.meta.dirname, '..', 'data', 'public', 'db');

/**
 * Where the site is published: www.arthurenard.me/strudelify/ (the portfolio forwards that folder here, see
 * vercel.json). STRUDELIFY_BASE moves it to another folder (`/` for a domain of its own) and SITE_URL names
 * another origin; SITE_URL= (empty) leaves the absolute addresses out.
 */
const PUBLISHED = { origin: 'https://www.arthurenard.me', base: '/strudelify/' };
const BASE = process.env.STRUDELIFY_BASE ?? PUBLISHED.base;
// Every address the app and its pages make starts at the base, in the build as in the browser (see main.ts).
setBase(BASE);

/**
 * The cover catalogue (packages/data/covers.tsv, see tools/resolve-covers.mjs and src/covers.ts), read when first
 * needed; without it the app looks every cover up in the browser.
 */
const COVERS = path.resolve(import.meta.dirname, '..', 'data', 'covers.tsv');
let covers: Map<string, Cover> | null = null;
const readCatalogue = (fresh = false): Map<string, Cover> => {
  if (!covers || fresh) covers = fs.existsSync(COVERS) ? readCovers(fs.readFileSync(COVERS, 'utf8')) : new Map();
  return covers;
};

/**
 * Bake the database's facts into index.html (song count, fallback example cards' years and tile colours).
 * The browser then replaces those cards with a random sample from the Spotify-popular pool. Read once per
 * run; a missing index leaves the markup for the browser to fill in.
 */
function landingPlugin(): Plugin {
  let entries: Parameters<typeof bakeLanding>[1] = null;
  let read = false;
  return {
    name: 'strudelify-landing',
    transformIndexHtml(html) {
      if (!read) {
        read = true;
        try { entries = JSON.parse(fs.readFileSync(path.join(DB, 'index.json'), 'utf8')); } catch { entries = null; }
      }
      return bakeLanding(html, entries, readCatalogue());
    },
  };
}

/**
 * The production page's Content Security Policy, as a meta tag (a server can send the same as a header, and add
 * `frame-ancestors`, which a meta tag cannot carry). Scripts come only from the site, except the Deezer JSONP of
 * the cover-art lookup and the data: URLs of Strudel's audio worklets; `'unsafe-eval'` is Strudel's own: the REPL
 * evaluates the code in the editor, and its soundfont loader evaluates the fonts it fetches. No inline script runs. Images, samples, soundfonts and the cover-art APIs come from
 * many HTTPS hosts, so those are allowed by scheme. Styles allow inline attributes (the per-song tile colours)
 * and the editor's injected styles. Only production gets it: the dev server's hot reload needs inline scripts.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval' https://api.deezer.com",
  // Strudel's audio engine (superdough) loads its AudioWorklet processors from data: URLs, which script-src-elem governs.
  "script-src-elem 'self' data: https://api.deezer.com",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https:",
  "media-src 'self' data: blob: https:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

/**
 * The site lives in a folder (BASE), so the dev and preview servers answer only inside it: an address outside it
 * that names no file (`/`, an old `/song/<id>/` link) is sent into the folder, and 127.0.0.1:5173 opens the app.
 */
function folderPlugin(): Plugin {
  const intoFolder: Connect.NextHandleFunction = (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const last = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
    if (BASE === '/' || url.pathname.startsWith(BASE) || last.includes('.') || (req.method !== 'GET' && req.method !== 'HEAD')) return next();
    res.statusCode = 302;
    res.setHeader('Location', (`${url.pathname}/` === BASE ? BASE : sitePath(url.pathname.slice(1))) + url.search);
    res.end();
  };
  // The catalogue's files, which the build writes, made from covers.tsv as it is now (the batch may be running).
  const coverFile: Connect.NextHandleFunction = (req, res, next) => {
    const m = new RegExp(`^${sitePath('db/covers/')}(\\d+)\\.json$`).exec(new URL(req.url ?? '/', 'http://localhost').pathname);
    const n = m ? Number(m[1]) : -1;
    if (n < 0 || n >= COVER_SHARDS) return next();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(coverShards(readCatalogue(true)).get(n)));
  };
  return {
    name: 'strudelify-folder',
    configureServer: (server) => { server.middlewares.use(intoFolder); server.middlewares.use(coverFile); },
    configurePreviewServer: (server) => { server.middlewares.use(intoFolder); },
  };
}

function securityPlugin(): Plugin {
  return {
    name: 'strudelify-csp',
    apply: 'build',
    transformIndexHtml: (html) => html.replace('<meta charset="utf-8" />', `<meta charset="utf-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}" />`),
  };
}

/**
 * The site's origin for canonical links, Open Graph and the sitemap (the pages' paths carry the base): SITE_URL,
 * or where the site is published when it is built for that folder. Unknown, those are left out of the pages.
 */
function siteUrl(): string | null {
  const url = process.env.SITE_URL ?? (BASE === PUBLISHED.base ? PUBLISHED.origin : '');
  if (!url) return null;
  if (!/^https?:\/\/[^/]+/.test(url)) throw new Error(`SITE_URL must be an address like https://example.com, not "${url}"`);
  const { origin, pathname } = new URL(url);
  if (pathname !== '/' && pathname.replace(/\/?$/, '/') !== sitePath()) {
    throw new Error(`SITE_URL names the folder ${pathname}, but the site is built for ${sitePath()}: set STRUDELIFY_BASE to match`);
  }
  return origin;
}

/** Every song's code as the app first shows it, compiled in worker threads (a song whose code fails maps to null). */
async function compileCodes(entries: IndexEntry[]): Promise<Map<string, string | null>> {
  // Every core (the main thread only waits): Vercel's Hobby builds have two.
  const workers = Math.max(1, Math.min(8, os.availableParallelism()));
  const shares = Array.from({ length: workers }, (_, w) => entries.filter((_, i) => i % workers === w)).filter((s) => s.length);
  const results = await Promise.all(shares.map((share) => new Promise<[string, string | null][]>((resolve, reject) => {
    const worker = new Worker(path.resolve(import.meta.dirname, 'scripts/code-worker.mjs'), { workerData: { db: DB, entries: share } });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => { if (code) reject(new Error(`A song-page worker exited with code ${code}`)); });
  })));
  return new Map(results.flat());
}

/**
 * The pages search engines and link previews read (see prerender.ts), written after the build: the home page's
 * head, a page per song (the app opened on it, with the start of its code) and per artist, the A–Z index, the
 * sitemap, robots.txt, the 404 page and the icon files (packages/web/static).
 */
function prerenderPlugin(): Plugin {
  let outDir = '';
  return {
    name: 'strudelify-prerender',
    apply: 'build',
    configResolved(config) { outDir = path.resolve(config.root, config.build.outDir); },
    async closeBundle() {
      const started = Date.now();
      const site = siteUrl();
      const entries: IndexEntry[] = JSON.parse(fs.readFileSync(path.join(DB, 'index.json'), 'utf8'));
      setArtistAliases(canonicalArtists(entries));
      const write = (file: string, text: string) => {
        fs.mkdirSync(path.dirname(path.join(outDir, file)), { recursive: true });
        fs.writeFileSync(path.join(outDir, file), text);
      };
      const shell = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
      const css = /<link rel="stylesheet"[^>]*href="([^"]+)"/.exec(shell)?.[1];
      if (!css) this.error('The built index.html links no stylesheet.');
      write('index.html', homePage(shell, site));
      write('404.html', notFoundPage(shell));
      const codes = await compileCodes(entries);
      const groups = artists(entries);
      const songsOf = new Map(groups.flatMap((g) => g.entries.map((e) => [e.id, g.entries] as const)));
      const known = readCatalogue(true);
      for (const e of entries) write(`song/${e.id}/index.html`, compact(songPage(shell, e, songsOf.get(e.id) ?? [], { code: codes.get(e.id) ?? undefined }, site, known)));
      for (const g of groups) write(`artist/${g.slug}/index.html`, compact(artistPage(g, css, site, known)));
      // Only the songs of this database: a catalogue made for a larger one carries no others.
      const listed = new Map([...known].filter(([id]) => songsOf.has(id)));
      if (listed.size) for (const [n, rows] of coverShards(listed)) write(`db/covers/${n}.json`, JSON.stringify(rows));
      write('artists/index.html', artistsPage(groups, css, site));
      for (const letter of LETTERS) write(`artists/${letter}/index.html`, artistsPage(groups, css, site, letter));
      write('robots.txt', robots(site));
      if (site) write('sitemap.xml', sitemap(site, [sitePath(), sitePath('artists/'), ...LETTERS.map((l) => sitePath(`artists/${l}/`)), ...groups.map((g) => sitePath(`artist/${g.slug}/`)), ...entries.map((e) => songPath(e.id))]));
      const icons = path.resolve(import.meta.dirname, 'static');
      for (const file of fs.readdirSync(icons)) fs.copyFileSync(path.join(icons, file), path.join(outDir, file));
      const failed = [...codes.values()].filter((c) => c === null).length;
      this.info?.(`prerendered ${entries.length} song and ${groups.length} artist pages in ${((Date.now() - started) / 1000).toFixed(1)} s${failed ? ` (${failed} without code)` : ''}; covers for ${listed.size} of ${entries.length} songs`);
      if (!site) console.warn('[strudelify-prerender] SITE_URL is not set: pages have no canonical links, Open Graph addresses or sitemap.');
    },
  };
}

export default defineConfig({
  base: BASE,
  // The song database is built into packages/data/public/db and served as static files.
  publicDir: path.resolve(import.meta.dirname, '..', 'data', 'public'),
  plugins: [folderPlugin(), landingPlugin(), securityPlugin(), prerenderPlugin(), {
    name: 'strudelify-database-check',
    apply: 'build',
    buildStart() {
      // The database is deliberately gitignored. A fresh clone must not silently publish
      // a successful-looking build with an empty library or dangling song links.
      let entries: { files: Record<string, string> }[];
      try { entries = JSON.parse(fs.readFileSync(path.join(DB, 'index.json'), 'utf8')); }
      catch { this.error('Missing song database. Build or restore packages/data/public/db before building the website. See LAUNCH.md.'); }
      if (!Array.isArray(entries) || !entries.length) this.error('The song database index must be a nonempty array.');
      for (const entry of entries) {
        if (!entry.files || !Object.keys(entry.files).length) this.error('A database entry has no source files.');
        for (const file of Object.values(entry.files)) {
          if (!fs.existsSync(path.join(DB, file))) this.error(`Missing song source: ${file}. Restore the complete database before building.`);
        }
      }
    },
  }],
  // The Strudel REPL is code-split and loaded when a song is opened.
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 2600 },
  // IPv4, as tools/shot.mjs, tools/ui-check.mjs and .claude/launch.json expect (Node resolves "localhost" to ::1 first).
  server: { port: 5173, host: '127.0.0.1' },
  preview: { host: '127.0.0.1' },
});
