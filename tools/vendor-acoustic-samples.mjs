/**
 * Vendor the selected CC0 VCSL hits so reviewed arrangements do not depend on live sample downloads.
 * Each source WAV is re-encoded losslessly as FLAC (`flac`, or macOS's `afconvert`) and decoded back to check
 * that the samples are unchanged; provenance.json keeps the SHA-256 of both the source and the shipped file.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ACOUSTIC_DRUMS } from '../packages/core/dist/acoustic-drums.js';
const root = new URL('../packages/data/public/audio/acoustic/', import.meta.url);
const bank = JSON.parse(await fs.readFile(new URL('../packages/core/test/fixtures/acoustic-drums.json', import.meta.url), 'utf8'));
await fs.mkdir(root, { recursive: true });
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const has = (cmd) => { try { execFileSync('which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; } };
const encoder = has('flac') ? 'flac' : has('afconvert') ? 'afconvert' : null;
if (!encoder) throw Error('A FLAC encoder is needed: install `flac` (or run on macOS, which has `afconvert`).');

/** The PCM data chunk of a WAV file: what must survive the round trip. */
function pcm(wav) {
  for (let p = 12; p + 8 <= wav.length;) {
    const id = wav.toString('ascii', p, p + 4), size = wav.readUInt32LE(p + 4);
    if (id === 'data') return wav.subarray(p + 8, p + 8 + size);
    p += 8 + size + (size & 1);
  }
  throw Error('WAV without a data chunk');
}
/** Encode `wav` as FLAC, decode it again and check the samples match; returns the FLAC bytes. */
async function toFlac(wav, name) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vendor-acoustic-'));
  try {
    const src = path.join(dir, `${name}.wav`), flac = path.join(dir, `${name}.flac`), back = path.join(dir, `${name}.back.wav`);
    await fs.writeFile(src, wav);
    if (encoder === 'flac') {
      execFileSync('flac', ['--best', '--silent', '-o', flac, src]);
      execFileSync('flac', ['--decode', '--silent', '-o', back, flac]);
    } else {
      execFileSync('afconvert', ['-f', 'flac', '-d', 'flac', src, flac]);
      execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16', flac, back]);
    }
    if (!pcm(wav).equals(pcm(await fs.readFile(back)))) throw Error(`FLAC round trip changed the samples of ${name}`);
    return await fs.readFile(flac);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const selected = [...new Map(Object.values(ACOUSTIC_DRUMS).map(d => [`${d.sample}-${d.index}`, d])).values()];
const manifest = {};
const provenance = [];
for (const { sample, index } of selected) {
  const url = bank._base + bank[sample][index];
  const response = await fetch(url);
  if (!response.ok) throw Error(`${response.status}: ${url}`);
  const wav = Buffer.from(await response.arrayBuffer());
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw Error(`Invalid WAV: ${url}`);
  const file = `${sample}-${index}.flac`;
  const flac = await toFlac(wav, `${sample}-${index}`);
  await fs.writeFile(new URL(file, root), flac);
  manifest[sample] ??= bank[sample].map(p => bank._base + p);
  manifest[sample][index] = `/audio/acoustic/${file}`;
  provenance.push({ file, source: url, sourceSha256: sha256(wav), sourceBytes: wav.length, sha256: sha256(flac), bytes: flac.length });
}
await fs.writeFile(new URL('samples.json', root), JSON.stringify(manifest, null, 2) + '\n');
await fs.writeFile(new URL('provenance.json', root), JSON.stringify({ license: 'CC0-1.0', author: 'Versilian Studios LLC', source: 'https://github.com/sgossner/VCSL', files: provenance, encoding: 'FLAC: each source WAV re-encoded losslessly, so it decodes to exactly the source samples.' }, null, 2) + '\n');
console.log(`${selected.length} samples, ${provenance.reduce((n, e) => n + e.bytes, 0)} bytes (${provenance.reduce((n, e) => n + e.sourceBytes, 0)} as WAV), encoded with ${encoder}`);
