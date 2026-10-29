import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url)));
test('old root and prefixed paths redirect without changing the rest', () => {
  for (const [path, rest] of [ ['/', '/'], ['/strudelify', '/'], ['/strudelify/', '/'], ['/song/a/', '/song/a/'], ['/strudelify/song/a/', '/song/a/'], ['/strudelify/assets/a%20b.js', '/assets/a%20b.js'], ['/strudelify/db/build.json', '/db/build.json'], ['/strudelify/artist/a', '/artist/a'], ['/strudelify-not-a-prefix/', '/strudelify-not-a-prefix/'] ]) {
    const rule = config.routes.find(r => new RegExp(r.src).test(path));
    assert.equal(rule.status, 308);
    const destination = path.replace(new RegExp(rule.src), rule.dest);
    assert.equal(destination, 'https://strudelify.pages.dev' + rest);
  }
});
test('Vercel build needs no dependencies or catalogue', () => {
  assert.equal(config.installCommand, '');
  assert.equal(config.buildCommand, 'node tools/vercel-redirect-build.mjs');
  execFileSync(process.execPath, ['tools/vercel-redirect-build.mjs'], { cwd: new URL('../', import.meta.url) });
  assert.deepEqual(readdirSync(new URL('../dist/vercel-redirect/', import.meta.url)), ['index.html']);
});
