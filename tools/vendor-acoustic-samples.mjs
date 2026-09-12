/** Vendor the selected CC0 VCSL hits so reviewed arrangements do not depend on live sample downloads. */
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { ACOUSTIC_DRUMS } from '../packages/core/dist/acoustic-drums.js';
const root = new URL('../packages/data/public/audio/acoustic/', import.meta.url);
const bank = JSON.parse(await fs.readFile(new URL('../packages/core/test/fixtures/acoustic-drums.json', import.meta.url), 'utf8'));
await fs.mkdir(root, { recursive: true });
const selected = [...new Map(Object.values(ACOUSTIC_DRUMS).map(d => [`${d.sample}-${d.index}`, d])).values()];
const manifest = {};
const provenance = [];
for (const {sample,index} of selected) {
  const url = bank._base + bank[sample][index];
  const response = await fetch(url);
  if (!response.ok) throw Error(`${response.status}: ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.toString('ascii',0,4) !== 'RIFF' || bytes.toString('ascii',8,12) !== 'WAVE') throw Error(`Invalid WAV: ${url}`);
  const file = `${sample}-${index}.wav`;
  await fs.writeFile(new URL(file,root),bytes);
  manifest[sample] ??= bank[sample].map(p => bank._base + p);
  manifest[sample][index] = `/audio/acoustic/${file}`;
  provenance.push({file,source:url,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});
}
await fs.writeFile(new URL('samples.json',root),JSON.stringify(manifest,null,2)+'\n');
await fs.writeFile(new URL('provenance.json',root),JSON.stringify({license:'CC0-1.0',author:'Versilian Studios LLC',source:'https://github.com/sgossner/VCSL',files:provenance},null,2)+'\n');
console.log(`${selected.length} samples, ${provenance.reduce((n,e)=>n+e.bytes,0)} bytes`);
