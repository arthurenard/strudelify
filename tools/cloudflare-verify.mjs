#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const base = (process.env.SITE_URL || 'https://strudelify.pages.dev').replace(/\/$/, '');
const dist = path.resolve(import.meta.dirname, '../packages/web/dist');
const index = JSON.parse(fs.readFileSync(path.join(dist,'db/index.json'),'utf8'));
const build = JSON.parse(fs.readFileSync(path.join(dist,'db/build.json'),'utf8'));
assert.ok(build.songs >= 13622 && build.scores >= 3261, 'Full catalogue required');
if (process.env.GITHUB_SHA) assert.equal(build.commit, process.env.GITHUB_SHA);
const hash = (b) => createHash('sha256').update(b).digest('hex');
const checked = [];
async function same(file, urlPath = file) {
  const response = await fetch(`${base}/${urlPath}`);
  assert.equal(response.status, 200, `${urlPath}: HTTP status`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(hash(bytes), hash(fs.readFileSync(path.join(dist,file))), `${file}: deployed hash`);
  checked.push({path:urlPath, status:response.status, sha256:hash(bytes), finalUrl:response.url});
  return response;
}
const home = await same('index.html','');
assert.ok(home.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"));
assert.equal(home.headers.get('x-content-type-options'),'nosniff');
const sitemap = fs.readFileSync(path.join(dist,'sitemap.xml'),'utf8');
const urls = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map((m)=>m[1]);
assert.ok(urls.length >= 18088, `Sitemap shrank: ${urls.length}`);
for (const url of urls) {
  assert.equal(new URL(url).origin,base);
  assert.ok(fs.existsSync(path.join(dist,new URL(url).pathname,'index.html')), `Missing sitemap page: ${url}`);
}
await same('sitemap.xml'); await same('robots.txt'); await same('db/build.json');
const db = await same('db/index.json');
assert.equal(db.headers.get('access-control-allow-origin'), '*');
await same('db/moved.json'); await same('db/covers/0.json');
const song = index.find((e)=>e.id === 'nirvana--smells-like-teen-spirit') ?? index[0];
await same(`song/${song.id}/index.html`,`song/${song.id}/`);
for (const file of Object.values(song.files)) await same(`db/${file}`);
const artist = urls.find((url)=>new URL(url).pathname.startsWith('/artist/'));
await same(new URL(artist).pathname.slice(1)+'index.html',new URL(artist).pathname.slice(1));
const html=fs.readFileSync(path.join(dist,'index.html'),'utf8');
const js=/<script[^>]+src="\/([^"]+\.js)"/.exec(html)?.[1];
const css=/<link[^>]+href="\/([^"]+\.css)"/.exec(html)?.[1];
assert.ok(js && css);
await same(js); await same(css); await same('favicon.svg'); await same('og.png');
const audioDir=path.join(dist,'audio/acoustic');
await same('audio/acoustic/samples.json');
await same('audio/acoustic/'+fs.readdirSync(audioDir).find((s)=>s.endsWith('.flac')));
for (const file of ['not-a-song-419203/', '.env', '.git/config','package.json','cloudflare/wrangler.json','tools/cloudflare-publish.mjs']) {
  const response=await fetch(`${base}/${file}`);
  assert.equal(response.status,404, `Private/unknown path ${file}`);
}
console.log(JSON.stringify({base,build,sitemapUrls:urls.length,verified:checked,privateAndUnknownPaths:404},null,2));
