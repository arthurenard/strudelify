import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { download, problem, type Source } from '../src/download.js';

const archive = zlib.gzipSync(Buffer.from('a tar archive, as far as gzip is concerned'.repeat(100)));
const csv = Buffer.from('id,chart_date,title,artist\n1,1987-07-11,,\n');
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
let server: http.Server, base = '', dir = '';

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strudelify-download-'));
  server = http.createServer((req, res) => {
    if (req.url === '/archive.tar.gz') res.end(archive);
    else if (req.url === '/cut.tar.gz') res.end(archive.subarray(0, archive.length - 10));
    else if (req.url === '/damaged.tar.gz') { const b = Buffer.from(archive); b[b.length - 6] ^= 0xff; res.end(b); }
    else if (req.url === '/index.csv') res.end(csv);
    else if (req.url === '/error-page') res.end('<html>Sign in to download</html>'.padEnd(csv.length));
    else if (req.url === '/stall') res.write('x'); // never ends
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const src = (name: string, url: string, body: Buffer, extra: Partial<Source> = {}): Source => ({ name, url: `${base}${url}`, bytes: body.length, ...extra });

describe('dataset download', () => {
  it('keeps a file only once its size, checksum and gzip stream verify', async () => {
    const dest = path.join(dir, 'archive.tar.gz');
    await download(src('archive.tar.gz', '/archive.tar.gz', archive, { extractsTo: 'x' }), dest);
    expect(fs.readFileSync(dest).equals(archive)).toBe(true);
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
    const table = path.join(dir, 'index.csv');
    await download(src('index.csv', '/index.csv', csv, { sha256: sha(csv) }), table);
    expect(await problem(table, src('index.csv', '/index.csv', csv, { sha256: sha(csv) }))).toBeNull();
  });
  it('rejects a cut or damaged archive and a page served in place of the data, keeping nothing', async () => {
    const cases: [string, Source, RegExp][] = [
      ['cut', src('cut.tar.gz', '/cut.tar.gz', archive, { extractsTo: 'x' }), /bytes instead of/],
      ['damaged', src('damaged.tar.gz', '/damaged.tar.gz', archive, { extractsTo: 'x' }), /damaged gzip archive/],
      ['page', src('index.csv', '/error-page', csv, { sha256: sha(csv) }), /SHA-256 mismatch/],
      ['missing', src('gone.csv', '/gone', csv), /HTTP 404/],
    ];
    for (const [label, source, error] of cases) {
      const dest = path.join(dir, `${label}.bin`);
      await expect(download(source, dest), label).rejects.toThrow(error);
      expect(fs.existsSync(dest), label).toBe(false);
      expect(fs.existsSync(`${dest}.part`), label).toBe(false);
    }
  });
  it('gives up on a download that stalls', async () => {
    const dest = path.join(dir, 'stall.bin');
    await expect(download(src('stall.bin', '/stall', csv), dest, 200)).rejects.toThrow(/no data for 0.2 s/);
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
  });
});
