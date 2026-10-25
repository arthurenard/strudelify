import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { prepare } from './cloudflare-publish.mjs';

const root = path.resolve(import.meta.dirname, '..', 'dist');
fs.mkdirSync(root, { recursive: true });
function fixture() {
  const dir = fs.mkdtempSync(path.join(root, 'cf-test-'));
  const source = path.join(dir, 'source'), out = path.join(dir, 'publish');
  const write = (file, data = 'fixture') => { fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true }); fs.writeFileSync(path.join(source, file), data); };
  for (const file of ['404.html','sitemap.xml','robots.txt','og.png','apple-touch-icon.png','favicon-96.png','favicon.svg','assets/app-abc.js','audio/acoustic/sample.flac','song/example/index.html','artist/example/index.html','artists/index.html']) write(file);
  write('index.html', '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">');
  write('db/index.json', JSON.stringify([{ id: 'example', files: { midi: 'songs/example.mid' } }]));
  write('db/songs/example.mid'); write('db/build.json', '{}'); write('db/moved.json', '{}'); write('db/covers/0.json','{}');
  return {dir, source, out, write};
}

test('publishes allowlisted pages and referenced catalogue only, with CORS and static redirects', () => {
  const f = fixture();
  try {
    f.write('.env', 'DO_NOT_PUBLISH'); f.write('internal.md'); f.write('db/songs/unreferenced.mid');
    const counts = prepare(f);
    assert.ok(counts.app < 20000 && counts.catalogue < 20000);
    assert.ok(fs.existsSync(path.join(f.out, 'app/song/example/index.html')));
    assert.ok(fs.existsSync(path.join(f.out, 'catalogue/db/songs/example.mid')));
    assert.ok(!fs.existsSync(path.join(f.out, 'catalogue/db/songs/unreferenced.mid')));
    assert.ok(!fs.existsSync(path.join(f.out, 'app/.env')));
    assert.ok(!fs.existsSync(path.join(f.out, 'app/internal.md')));
    assert.match(fs.readFileSync(path.join(f.out, 'app/_redirects'),'utf8'), /^\/db\/\* https:\/\/strudelify-catalogue\.arthurenard\.workers\.dev\/db\/:splat 302\n$/);
    assert.match(fs.readFileSync(path.join(f.out, 'catalogue/_headers'),'utf8'), /Access-Control-Allow-Origin: \*/);
    assert.match(fs.readFileSync(path.join(f.out, 'app/_headers'),'utf8'), /frame-ancestors 'none'/);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('fails closed on traversal, unexpected assets, missing sources and symlinks', () => {
  for (const kind of ['traversal', 'unexpected', 'missing', 'symlink']) {
    const f = fixture();
    try {
      if (kind === 'traversal') f.write('db/index.json', JSON.stringify([{id:'bad',files:{midi:'../secret.mid'}}]));
      if (kind === 'unexpected') f.write('assets/secret.env');
      if (kind === 'missing') fs.unlinkSync(path.join(f.source, 'db/songs/example.mid'));
      if (kind === 'symlink') { fs.unlinkSync(path.join(f.source,'assets/app-abc.js')); fs.symlinkSync(path.join(f.source, 'index.html'),path.join(f.source,'assets/app-abc.js')); }
      assert.throws(() => prepare(f));
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  }
});

test('never removes a non-publish directory', () => {
  const f = fixture();
  try { assert.throws(() => prepare({...f, out: f.source})); assert.ok(fs.existsSync(path.join(f.source,'index.html'))); }
  finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});
