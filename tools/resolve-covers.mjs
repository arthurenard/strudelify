#!/usr/bin/env node
/**
 * Resolve every song's cover once, ahead of time, with the web app's own chain (packages/web/src/art.ts), into
 * packages/data/covers.tsv (committed): the site ships the result, so a visitor's browser shows a cover without
 * asking iTunes, Deezer or MusicBrainz, whose rate limits a page of search results overruns.
 *
 * Two lanes share one request queue (the per-host limits of the browser's, at the pace of a batch), both in order
 * of popularity (the landing page's pool first):
 *   - every song takes the chain without iTunes (Deezer, then MusicBrainz and the Cover Art Archive), the path a
 *     browser takes whenever iTunes turns it away: fast, so popular songs have a cover within minutes;
 *   - meanwhile the most popular songs take the full chain, iTunes first, at iTunes's ~20 requests a minute, and
 *     its answer replaces the first one (the last line of a song wins).
 * The file is appended to as songs resolve and read back on the next run, which resumes where this one stopped:
 * a popular song whose cover did not come from iTunes takes the iTunes lane again.
 *
 *   node tools/resolve-covers.mjs                    # every song not in covers.tsv yet
 *   node tools/resolve-covers.mjs --itunes-top 3000  # how many popular songs take the iTunes lane (default 3000)
 *   node tools/resolve-covers.mjs --retry-misses     # also retry songs that found no cover last time
 *   node tools/resolve-covers.mjs --limit 50         # stop after 50 songs (a trial run)
 */
import { register } from 'tsx/esm/api';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

register();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const art = await import(path.join(root, 'packages/web/src/art.ts'));
const { SPOTIFY_POPULAR_IDS } = await import(path.join(root, 'packages/web/src/popular-ids.ts'));
const { readCovers, COVERS_HEADER, coverLine } = await import(path.join(root, 'packages/web/src/covers.ts'));

const args = process.argv.slice(2);
const val = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback; };
const itunesTop = Number(val('--itunes-top', 3000));
const limit = Number(val('--limit', Infinity));
const retryMisses = args.includes('--retry-misses');
const dbIndex = val('--db', path.join(root, 'packages/data/public/db/index.json'));
const out = path.join(root, 'packages/data/covers.tsv');

const entries = JSON.parse(fs.readFileSync(dbIndex, 'utf8'));
if (!fs.existsSync(out)) fs.writeFileSync(out, COVERS_HEADER);
const known = readCovers(fs.readFileSync(out, 'utf8'));
const pool = new Map(SPOTIFY_POPULAR_IDS.map((id, i) => [id, i]));
const order = [...entries].sort((a, b) => (pool.get(a.id) ?? Infinity) - (pool.get(b.id) ?? Infinity) || (b.popularity ?? 0) - (a.popularity ?? 0) || a.id.localeCompare(b.id));
const deezerLane = order.filter((e) => { const c = known.get(e.id); return !c || (retryMisses && c.kind === 'none'); }).slice(0, limit);
const fullLane = order.slice(0, itunesTop).filter((e) => !known.get(e.id)?.source?.startsWith('itunes')).slice(0, limit);
const todo = new Set([...deezerLane, ...fullLane].map((e) => e.id));
console.log(`${entries.length} songs, ${known.size} in covers.tsv, ${todo.size} to resolve: ${deezerLane.length} without iTunes, ${fullLane.length} popular ones with iTunes first`);

// One queue for both lanes: iTunes at ~20 a minute, Deezer under its 50 requests per 5 s, MusicBrainz at 1 a second.
const policy = art.DEFAULT_HOST_POLICY;
const queue = new art.RequestQueue({ hostPolicy: {
  ...policy,
  'itunes.apple.com': { ...policy['itunes.apple.com'], gap: 3000, burst: 1, maxRetries: 1 },
  'api.deezer.com': { ...policy['api.deezer.com'], gap: 130 },
} });
const adapter = art.createFetchAdapter({ queue, timeout: 15_000, userAgent: 'Strudelify/1.0 (cover catalogue; https://www.arthurenard.me/strudelify/)' });
// The popular lane waits for iTunes rather than skip it while it cools down (nobody is waiting for a batch); the
// Deezer lane sees iTunes as unavailable, as a browser does while iTunes turns it away.
const withItunes = { ...adapter, cooldown: (url) => (url.includes('itunes.apple.com') ? 0 : adapter.cooldown(url)) };
const withoutItunes = { ...adapter, cooldown: (url) => (url.includes('itunes.apple.com') ? 3_600_000 : adapter.cooldown(url)) };

const started = Date.now();
const lanes = { deezer: { done: 0, total: deezerLane.length, counts: {} }, itunes: { done: 0, total: fullLane.length, counts: {} } };
/** Songs the iTunes lane has answered: the Deezer lane leaves them alone (and never overwrites them). */
const answered = new Set();
async function resolve(e, lane, name) {
  if (name === 'deezer' && answered.has(e.id)) return;
  const info = await art.resolveArt({ artist: e.artist, title: e.title, year: e.year }, lane, { budget: 60_000 }).catch(() => ({}));
  if (name === 'deezer' && answered.has(e.id)) return;
  if (name === 'itunes') answered.add(e.id);
  fs.appendFileSync(out, coverLine(e.id, info));
  const l = lanes[name], kind = info.art && info.kind !== 'placeholder' ? info.kind : 'none';
  l.counts[kind] = (l.counts[kind] ?? 0) + 1;
  if (++l.done % 100 === 0 || l.done === l.total) {
    const rate = l.done / ((Date.now() - started) / 60_000);
    console.log(`${name} lane ${l.done}/${l.total}  ${Object.entries(l.counts).map(([k, n]) => `${k} ${n}`).join(', ')}  ${rate.toFixed(0)}/min, ~${Math.ceil((l.total - l.done) / rate)} min left`);
  }
}
async function run(list, lane, name, workers) {
  let next = 0;
  await Promise.all(Array.from({ length: workers }, async () => { while (next < list.length) await resolve(list[next++], lane, name); }));
}
await Promise.all([run(fullLane, withItunes, 'itunes', 3), run(deezerLane, withoutItunes, 'deezer', 8)]);
console.log(`done in ${Math.round((Date.now() - started) / 60_000)} min`);
