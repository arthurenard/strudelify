#!/usr/bin/env node
/**
 * Cover-art coverage harness.
 *
 * Runs the web app's exact resolution chain (packages/web/src/art.ts – iTunes → Deezer → MusicBrainz/CAA →
 * Deezer artist picture → placeholder) from Node against a sample of the song database and reports coverage,
 * per-source counts, latency percentiles, request/retry/cool-down statistics and the misses. Requests go
 * through the same per-host queue as the browser (spacing, one quick retry on iTunes, host cool-down, 8 s
 * budget), so a run is a faithful measurement of what a user sees – except that the iTunes spacing defaults
 * to 2 s here (≈ 30 req/min, close to Apple's documented ~20/min) because the harness fires hundreds of
 * requests in a row, while the browser resolves one song at a time and keeps 350 ms.
 *
 *   node tools/art-check.mjs                       # 100 most popular songs + 20 random ones (seed 1)
 *   node tools/art-check.mjs --n 40 --random 10    # smaller sample
 *   node tools/art-check.mjs --ids nirvana--smells-like-teen-spirit,brown-james--cold-sweat
 *   node tools/art-check.mjs --query "Pink Floyd|Another Brick in the Wall, Part 2" --verbose
 *   node tools/art-check.mjs --json out.json --verify   # machine-readable details + HEAD-check every image
 *
 * Options: --n <total=120> --random <count=20> --seed <n=1> --concurrency <songs in flight=1>
 *          --gap-itunes <ms=2000> (latency is also reported net of this spacing, --concurrency 1 only) --budget <ms=8000>
 *          --no-year (drop the database year ranking hint; on by default because main.ts passes { year }) --no-artist
 *          (skip the artist-picture fallback) --block <hosts> (simulate an outage / rate limit: those hosts answer
 *          403 – aliases itunes, deezer, musicbrainz, coverart – so the chain, retries and cool-downs run exactly as
 *          in a rate-limited browser; e.g. --block itunes measures the Deezer path) --verify (HEAD-request every
 *          chosen image) --verbose (print every request) --db <index.json> --min <pct> (exit 1 when track-art
 *          coverage is below it)
 */
import { register } from 'tsx/esm/api';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

register();
const here = path.dirname(fileURLToPath(import.meta.url));
const art = await import(path.join(here, '../packages/web/src/art.ts'));

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : d;
};
const total = Number(val('--n', 120));
const randomCount = Number(val('--random', 20));
const seed = Number(val('--seed', 1));
const concurrency = Number(val('--concurrency', 1));
const gapItunes = Number(val('--gap-itunes', 2000));
const budget = val('--budget', String(art.DEFAULT_BUDGET));
const budgetMs = /^inf/i.test(budget) ? Infinity : Number(budget);
const useYear = !flag('--no-year');
const HOST_ALIAS = { itunes: 'itunes.apple.com', deezer: 'api.deezer.com', musicbrainz: 'musicbrainz.org', coverart: 'coverartarchive.org' };
const blocked = (val('--block', '') || '').split(',').map((s) => s.trim()).filter(Boolean).map((h) => HOST_ALIAS[h] ?? h);
const verbose = flag('--verbose');
const noArtist = flag('--no-artist');
const verify = flag('--verify');
const minCoverage = Number(val('--min', 0));
const jsonOut = val('--json');
const dbPath = val('--db', path.join(here, '../packages/data/public/db/index.json'));

// ---------------------------------------------------------------- sample selection
function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let sample;
const single = val('--query');
if (single) {
  const [artist, title, year] = single.split('|');
  if (!artist || !title) {
    console.error('--query expects "Artist|Title[|year]"');
    process.exit(2);
  }
  sample = [{ id: 'query', artist: artist.trim(), title: title.trim(), year: year ? Number(year) : undefined, popularity: 0 }];
} else {
  const index = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  const ids = val('--ids');
  if (ids) {
    const want = new Set(ids.split(',').map((s) => s.trim()).filter(Boolean));
    sample = index.filter((e) => want.has(e.id));
    for (const id of want) if (!sample.some((e) => e.id === id)) console.error(`unknown id: ${id}`);
  } else {
    const sorted = [...index].sort((a, b) => b.popularity - a.popularity || a.id.localeCompare(b.id));
    const topN = Math.max(0, total - randomCount);
    const top = sorted.slice(0, topN);
    const rest = sorted.slice(topN);
    const rnd = mulberry32(seed);
    const picked = [];
    while (picked.length < Math.min(randomCount, rest.length)) {
      const i = Math.floor(rnd() * rest.length);
      if (!picked.includes(rest[i])) picked.push(rest[i]);
    }
    sample = [...top, ...picked];
  }
}

// ---------------------------------------------------------------- run
const stats = { requests: {}, failures: {}, skips: {}, retries: 0, retryByHost: {}, cooldowns: [] };
let waitedNow = 0;
const queue = new art.RequestQueue({
  hostPolicy: { ...art.DEFAULT_HOST_POLICY, 'itunes.apple.com': { ...art.DEFAULT_HOST_POLICY['itunes.apple.com'], gap: gapItunes } },
  onRetry: ({ host, attempt, delay, error }) => {
    stats.retries++;
    stats.retryByHost[host] = (stats.retryByHost[host] ?? 0) + 1;
    if (verbose) console.error(`   retry ${host} #${attempt + 1} in ${delay}ms (${error?.message ?? error})`);
  },
  onStart: ({ waited }) => {
    waitedNow += waited; // with --concurrency 1 this is the current song's lane wait (harness pacing, not the resolver)
  },
  onCooldown: ({ host, streak, ms, error }) => {
    stats.cooldowns.push({ host, streak, ms, at: Date.now() });
    if (verbose) console.error(`   cool-down ${host} ${Math.round(ms / 1000)}s (streak ${streak}: ${error?.message ?? error})`);
  },
});
// Outage simulation: a blocked host answers 403 at the fetch level, so the queue's retry / cool-down / skip logic
// runs as it would in a browser that tripped the iTunes rate limit.
const blockingFetch = blocked.length
  ? (url, init) => (blocked.includes(new URL(url).host) ? Promise.resolve(new Response('blocked', { status: 403 })) : fetch(url, init))
  : undefined;
const adapter = art.createFetchAdapter({ queue, fetch: blockingFetch, userAgent: 'strudelify-art-check/0.3 (https://github.com/strudelify)' });

const results = [];
const started = Date.now();
let next = 0;
let done = 0;
const pad = (s, n) => String(s).padEnd(n).slice(0, n);

async function worker() {
  while (next < sample.length) {
    const entry = sample[next++];
    const t0 = Date.now();
    waitedNow = 0;
    const events = [];
    // Hard cap per song: whatever a host does, the run must finish. (The resolver's own budget is much lower.)
    let hangTimer;
    const hangCap = Number.isFinite(budgetMs) ? budgetMs + art.ARTIST_GRACE_MS + 10_000 : 90_000;
    const hung = new Promise((res) => { hangTimer = setTimeout(() => res({ kind: 'placeholder', source: 'hang', art: undefined }), hangCap); });
    const info = await Promise.race([hung, art.resolveArt(
      { artist: entry.artist, title: entry.title, year: useYear ? entry.year : undefined },
      adapter,
      {
        noArtistFallback: noArtist,
        budget: budgetMs,
        onEvent: (e) => {
          events.push(e);
          if (e.skipped) {
            stats.skips[e.source] = (stats.skips[e.source] ?? 0) + 1;
          } else {
            stats.requests[e.source] = (stats.requests[e.source] ?? 0) + 1;
            if (!e.ok) stats.failures[e.source] = (stats.failures[e.source] ?? 0) + 1;
          }
          if (verbose) console.error(`   ${e.skipped ? 'SKP' : e.ok ? 'ok ' : 'ERR'} ${pad(e.source, 17)} ${String(e.ms).padStart(5)}ms cand=${e.candidates ?? '-'} ${e.status ?? ''} ${e.url}${e.note ? ' ' + e.note : ''}`);
        },
      },
    )]);
    clearTimeout(hangTimer);
    if (info.source === 'hang') stats.hangs = (stats.hangs ?? 0) + 1;
    const ms = Date.now() - t0;
    const net = concurrency === 1 ? Math.max(0, ms - waitedNow) : null; // time-to-art without the harness's own spacing
    done++;
    const mark = info.kind === 'track' ? 'OK ' : info.kind === 'artist' ? 'ART' : info.source === 'hang' ? 'HANG' : 'MISS';
    const detail = info.kind === 'track' ? `${info.album ?? ''}${info.year ? ' ' + info.year : ''}  <${info.matched?.artist} — ${info.matched?.title}> score ${info.matched?.score}` : '';
    console.log(`[${String(done).padStart(3)}/${sample.length}] ${mark} ${pad(info.source ?? '-', 13)} ${String(net ?? ms).padStart(5)}ms  ${entry.artist} — ${entry.title}  ${detail}`);
    results.push({ id: entry.id, artist: entry.artist, title: entry.title, year: entry.year, popularity: entry.popularity, ms, net, requests: events.filter((e) => !e.skipped).length, skips: events.filter((e) => e.skipped).length, info });
  }
}
await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

// ---------------------------------------------------------------- optional image verification
let verified = null;
if (verify) {
  verified = { ok: 0, failed: [] };
  for (const r of results) {
    const url = r.info.art;
    if (!url || !/^https?:/.test(url)) continue;
    try {
      const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
      const type = res.headers.get('content-type') ?? '';
      if (res.ok && /^image\//.test(type)) verified.ok++;
      else verified.failed.push({ id: r.id, url, status: res.status, type });
    } catch (e) {
      verified.failed.push({ id: r.id, url, error: String(e?.message ?? e) });
    }
    await new Promise((res) => setTimeout(res, 150));
  }
}

// ---------------------------------------------------------------- report
const n = results.length;
const track = results.filter((r) => r.info.kind === 'track');
const artist = results.filter((r) => r.info.kind === 'artist');
const misses = results.filter((r) => r.info.kind !== 'track');
const pct = (x) => (n ? ((100 * x) / n).toFixed(1) : '0.0');
const bySource = {};
for (const r of results) bySource[r.info.source ?? 'none'] = (bySource[r.info.source ?? 'none'] ?? 0) + 1;
const summarise = (xs) => {
  const lat = [...xs].sort((a, b) => a - b);
  const pctl = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.ceil((p / 100) * lat.length) - 1)] : 0);
  return { p50: pctl(50), p95: pctl(95), max: lat[lat.length - 1] ?? 0, avg: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : 0, over8s: lat.filter((x) => x > 8000).length };
};
const latency = summarise(results.map((r) => r.ms));
const latencyNet = concurrency === 1 ? summarise(results.map((r) => r.net)) : null;
const fmtLat = (l) => `p50 ${l.p50}ms   p95 ${l.p95}ms   max ${l.max}ms   avg ${l.avg}ms   >8s: ${l.over8s}`;

console.log('\n=== cover art coverage ===');
console.log(`songs: ${n}   elapsed: ${((Date.now() - started) / 1000).toFixed(1)}s   year hint: ${useYear ? 'on (as in the web app)' : 'off'}   budget: ${budgetMs}ms   itunes gap: ${gapItunes}ms   concurrency: ${concurrency}${blocked.length ? '   blocked: ' + blocked.join(',') : ''}`);
console.log(`track art:            ${track.length}/${n}  (${pct(track.length)}%)`);
console.log(`track or artist art:  ${track.length + artist.length}/${n}  (${pct(track.length + artist.length)}%)`);
console.log('by source:            ' + Object.entries(bySource).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  '));
if (latencyNet) console.log(`time-to-art per song: ${fmtLat(latencyNet)}   (net of the harness's ${gapItunes} ms iTunes spacing – what a browser user sees)`);
console.log(`wall time per song:   ${fmtLat(latency)}   (including harness pacing)`);
console.log('requests:             ' + Object.entries(stats.requests).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}${stats.failures[k] ? ` (${stats.failures[k]} failed)` : ''}`).join('  '));
console.log(`retries:              ${stats.retries}${stats.retries ? '  ' + Object.entries(stats.retryByHost).map(([h, c]) => `${h}=${c}`).join('  ') : ''}`);
console.log(`cool-downs:           ${stats.cooldowns.length}${stats.cooldowns.length ? '  ' + stats.cooldowns.map((c) => `${c.host} ${Math.round(c.ms / 1000)}s`).join(', ') : ''}`);
console.log(`skipped (cooling):    ${Object.keys(stats.skips).length ? Object.entries(stats.skips).map(([h, c]) => `${h}=${c}`).join('  ') : '0'}`);
if (stats.hangs) console.log(`HUNG past the hard cap: ${stats.hangs} song(s) – the resolver did not return within budget + grace + 10 s`);
if (verified) console.log(`images verified:      ${verified.ok} ok, ${verified.failed.length} failed${verified.failed.length ? '  ' + verified.failed.map((f) => `${f.id} (${f.status ?? f.error})`).join(', ') : ''}`);
if (misses.length) {
  console.log('\nwithout track art:');
  for (const r of misses) console.log(`  ${r.info.kind === 'artist' ? '(artist image)' : '(placeholder) '} ${r.id}   ${r.artist} — ${r.title}`);
}
if (verbose && single) console.log('\nresult:', JSON.stringify(results[0].info, null, 2));
if (jsonOut) {
  fs.writeFileSync(jsonOut, JSON.stringify({ sample: n, options: { useYear, budget: budgetMs, gapItunes, concurrency, blocked }, coverage: { track: track.length, artist: artist.length }, bySource, latency, latencyNet, stats, verified, results }, null, 2));
  console.log(`\nwrote ${jsonOut}`);
}
if (minCoverage && (100 * track.length) / n < minCoverage) process.exit(1);
