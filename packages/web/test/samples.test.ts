import { it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { ACOUSTIC_DRUMS } from '../../core/src/acoustic-drums.js';
const root = new URL('../../data/public/audio/acoustic/',import.meta.url);
afterEach(()=>{vi.unstubAllGlobals();vi.resetModules();});
it('ships every selected acoustic hit at its original sample index with verified bytes',()=>{
  const bank=JSON.parse(fs.readFileSync(new URL('samples.json',root),'utf8'));
  const provenance=JSON.parse(fs.readFileSync(new URL('provenance.json',root),'utf8'));
  for(const {sample,index} of Object.values(ACOUSTIC_DRUMS)) {
    const path=bank[sample][index];
    expect(path).toMatch(/^\/audio\/acoustic\/.+\.flac$/);
    const file=path.split('/').pop(), bytes=fs.readFileSync(new URL(file,root));
    expect(bytes.toString('ascii',0,4)).toBe('fLaC');
    const row=provenance.files.find((f:any)=>f.file===file);
    expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(row.sha256);
    expect(row.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.source).toMatch(/^https:\/\/raw\.githubusercontent\.com\/sgossner\/VCSL\/.+\.wav$/);
  }
  // Nothing on disk that the bank does not name (a leftover WAV would be published for nothing).
  const shipped=fs.readdirSync(root).filter(f=>/\.(flac|wav)$/.test(f)).sort();
  expect(shipped).toEqual(provenance.files.map((f:any)=>f.file).sort());
});
it('waits for audio decoding before declaring the drum bank ready',async()=>{
  const map={snare_modern:['/audio/acoustic/test.wav']};
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>map})));
  vi.stubGlobal('samples',vi.fn(async()=>{}));
  vi.stubGlobal('getAudioContext',()=>({}));
  let finish!:()=>void;
  const load=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;}));
  vi.stubGlobal('loadBuffer',load);
  const {registerLocalDrums,preloadLocalDrums}=await import('../src/samples.js');
  await registerLocalDrums();
  let ready=false;
  const waiting=preloadLocalDrums().then(()=>{ready=true;});
  await Promise.resolve();expect(ready).toBe(false);
  finish();await waiting;expect(ready).toBe(true);
  await preloadLocalDrums();expect(load).toHaveBeenCalledTimes(1);
});
it('reports a missing drum bank before playback instead of accepting an error page',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:false,status:404})));
  const {registerLocalDrums}=await import('../src/samples.js');
  await expect(registerLocalDrums()).rejects.toThrow('Could not load drum bank (404)');
});
