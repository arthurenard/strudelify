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

export default defineConfig({
  // Served under arthurenard.me/strudelify/ (the portfolio forwards that path here); override with STRUDELIFY_BASE.
  base: process.env.STRUDELIFY_BASE ?? '/strudelify/',
  // The song database is built into packages/data/public/db and served as static files.
  publicDir: path.resolve(__dirname, '..', 'data', 'public'),
  plugins: [landingPlugin(), {
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
  server: { port: 5173 },
});
