#!/usr/bin/env node
/** Dedicated allowlisted static-only payloads. Neither repository root nor arbitrary dist files publish. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const TOP = ['index.html', '404.html', 'sitemap.xml', 'robots.txt', 'og.png', 'apple-touch-icon.png', 'favicon-96.png', 'favicon.svg'];
const safe = (file) => !path.isAbsolute(file) && !file.split('/').some((s) => !s || s.startsWith('.') || s === 'node_modules');

export function prepare({ source = path.join(ROOT, 'packages/web/dist'), out = path.join(ROOT, 'dist/cloudflare'), dataOrigin = 'https://strudelify-catalogue.arthurenard.workers.dev' } = {}) {
  const origin = new URL(dataOrigin);
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('dataOrigin must be an HTTPS origin');
  const index = JSON.parse(fs.readFileSync(path.join(source, 'db/index.json'), 'utf8'));
  if (!Array.isArray(index) || !index.length) throw new Error('Empty catalogue');
  // Validate before removing only our dedicated output, never the source or repository.
  if (path.resolve(out) === path.resolve(source) || !path.resolve(out).startsWith(path.join(ROOT, 'dist') + path.sep)) throw new Error('Output must be a dedicated directory inside root dist/');
  fs.rmSync(out, { recursive: true, force: true });
  const app = path.join(out, 'app');
  const data = path.join(out, 'catalogue');
  const counts = { app: 0, catalogue: 0 };
  const copy = (file, target, group) => {
    if (!safe(file)) throw new Error(`Unsafe path: ${file}`);
    const src = path.join(source, file);
    const stat = fs.lstatSync(src);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 25 * 1024 * 1024) throw new Error(`Not a permitted static file: ${file}`);
    fs.mkdirSync(path.dirname(path.join(target, file)), { recursive: true });
    fs.copyFileSync(src, path.join(target, file));
    counts[group]++;
  };
  const tree = (dir, allow, target, group) => {
    for (const e of fs.readdirSync(path.join(source, dir), { withFileTypes: true })) {
      const file = `${dir}/${e.name}`;
      if (e.isSymbolicLink()) throw new Error(`Symlink: ${file}`);
      if (e.isDirectory()) tree(file, allow, target, group);
      else if (allow(file)) copy(file, target, group);
      else throw new Error(`Unexpected file in allowlisted tree: ${file}`);
    }
  };
  for (const file of TOP) copy(file, app, 'app');
  tree('assets', (f) => /\.(js|css|woff2?|ttf|svg|png)$/.test(f), app, 'app');
  tree('audio', (f) => /\.(flac|wav|mp3|ogg|json|md)$/.test(f), app, 'app');
  for (const dir of ['song', 'artist', 'artists']) tree(dir, (f) => /^(song|artist|artists)\/[a-z0-9_-]+\/index\.html$/i.test(f) || f === 'artists/index.html', app, 'app');
  const dbFiles = new Set(['index.json', 'build.json', 'moved.json']);
  for (const entry of index) {
    if (!entry.files || !Object.keys(entry.files).length) throw new Error(`No source: ${entry.id}`);
    for (const file of Object.values(entry.files)) {
      if (!/^songs\/[a-z0-9_-]+\.(mid|txt)$/i.test(file)) throw new Error(`Unexpected catalogue source: ${file}`);
      dbFiles.add(file);
    }
  }
  for (const file of dbFiles) copy(`db/${file}`, data, 'catalogue');
  tree('db/covers', (f) => /^db\/covers\/\d+\.json$/.test(f), data, 'catalogue');
  const html = fs.readFileSync(path.join(source, 'index.html'), 'utf8');
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1];
  if (!csp) throw new Error('Missing CSP in generated app');
  fs.writeFileSync(path.join(app, '_headers'), `/*\n  Content-Security-Policy: ${csp}; frame-ancestors 'none'\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  Cache-Control: public, max-age=0, must-revalidate\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n`);
  fs.writeFileSync(path.join(app, '_redirects'), `/db/* ${origin.origin}/db/:splat 302\n`);
  fs.writeFileSync(path.join(data, '_headers'), '/*\n  Access-Control-Allow-Origin: *\n  X-Content-Type-Options: nosniff\n  Cache-Control: public, max-age=0, must-revalidate\n  X-Robots-Tag: noindex\n');
  // No Worker code executes: asset requests and redirects are served by the static-assets layer.
  for (const [group, count] of Object.entries(counts)) if (count + 2 > 20000) throw new Error(`${group}: ${count} assets exceed the Free limit`);
  console.log(JSON.stringify({ source, out, dataOrigin: origin.origin, songs: index.length, files: counts }));
  return counts;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) prepare();
