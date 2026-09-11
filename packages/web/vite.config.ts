import { defineConfig, type Plugin } from 'vite';
import path from 'node:path';
import fs from 'node:fs';
import { bakeLanding } from './src/landing.js';

const DB = path.resolve(__dirname, '..', 'data', 'public', 'db');

/**
 * Bake the database's facts into index.html (song count, the example cards' years and tile colours), so the
 * landing page's first paint is its final paint. Read once per run; a missing index leaves the markup for the
 * browser to fill in.
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
  // The song database is built into packages/data/public/db and served as static files.
  publicDir: path.resolve(__dirname, '..', 'data', 'public'),
  plugins: [landingPlugin()],
  // The Strudel REPL is one 2 MB chunk by nature; it is code-split and loaded in idle time (see main.ts).
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 2600 },
  server: { port: 5173 },
});
