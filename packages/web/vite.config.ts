import { defineConfig, type Plugin } from 'vite';
import path from 'node:path';
import fs from 'node:fs';
import { bakeLanding } from './src/landing.js';

const DB = path.resolve(__dirname, '..', 'data', 'public', 'db');

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
      return bakeLanding(html, entries);
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

function securityPlugin(): Plugin {
  return {
    name: 'strudelify-csp',
    apply: 'build',
    transformIndexHtml: (html) => html.replace('<meta charset="utf-8" />', `<meta charset="utf-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}" />`),
  };
}

export default defineConfig({
  // The song database is built into packages/data/public/db and served as static files.
  publicDir: path.resolve(__dirname, '..', 'data', 'public'),
  plugins: [landingPlugin(), securityPlugin(), {
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
