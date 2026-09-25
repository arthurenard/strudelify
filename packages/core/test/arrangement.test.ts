import { it, expect } from 'vitest';
import fs from 'node:fs';
import { compile, timeline, barRange } from '../src/strudel.js';
import { prepareArrangement } from '../src/arrangement.js';
import { loadSong } from '../src/load.js';
import { gmName, percName, drumName } from '../src/gm.js';
import { OVERLAP_BEATS } from '../src/patterns.js';
import { ACOUSTIC_DRUMS } from '../src/acoustic-drums.js';
import type { Song } from '../src/types.js';
// @ts-expect-error Shared Node-only runtime harness.
import { evaluatePattern, queryPattern } from '../../../tools/strudel-runtime.mjs';
const options = { timing: 'patterns', maxBars: 10000, maxTracks: 1000 } as const;
const fixture = (): Song => ({meta:{id:'test',title:'Test',artist:'Test',bpm:120,beatsPerBar:4,beatUnit:4,sources:['midi']},sections:[],tracks:[{name:'Guitar',role:'chords',program:27,notes:[0,4,12,16,20,28].map((start,i)=>({pitch:60+i%2,start,duration:1,velocity:.8}))}]});
function midi(value: string | number) {
  if (typeof value === 'number') return value;
  const m = /^([a-g])([#b]*)(-?\d+)$/i.exec(value)!;
  return (Number(m[3])+1)*12 + 'c d ef g a b'.indexOf(m[1].toLowerCase()) + [...m[2]].reduce((n,a)=>n+(a==='#'?1:-1),0);
}
const onsets = (p: any, start: number, end: number) => queryPattern(p,start,end).filter((e: any)=>e.hasOnset());
const snapshot = (p: any, start: number, end: number) => onsets(p,start,end).map((e: any)=>JSON.stringify([Number(e.whole.begin.sub(start)).toFixed(6),e.value])).sort();
it('restarts phrases, preserves holes and repeats the whole form, without changing the input',()=>{
  const song=fixture(), original=structuredClone(song), code=compile(song,options), pattern=evaluatePattern(code);
  expect(timeline(song,options).bars).toBe(8);
  expect(onsets(pattern,0,8).map((e:any)=>Number(e.whole.begin)*4).sort((a:number,b:number)=>a-b)).toEqual([0,4,12,16,20,28]);
  expect(snapshot(pattern,8,16)).toEqual(snapshot(pattern,0,8));
  expect(compile(song,{...options,maxBars:1})).toContain('rendering stops at bar 1 of 8');
  expect(song).toEqual(original);
});
it('merges coincident attacks and matching doubled guitars but keeps complementary parts',()=>{
  const song=fixture();
  song.tracks.push({...song.tracks[0],name:'Double',program:30,notes:song.tracks[0].notes.slice(0,5).map(n=>({...n,pitch:n.pitch+12}))});
  song.tracks.push({...song.tracks[0],name:'Countermelody',program:29,notes:[{pitch:71,start:2,duration:1,velocity:.8}]});
  song.tracks[0].notes.push({...song.tracks[0].notes[0]});
  const prepared=prepareArrangement(song);
  expect(prepared.tracks.map(t=>t.name)).toEqual(['Guitar','Countermelody']);
  expect(prepared.tracks[0].notes).toHaveLength(6);
});
it('retains unique solo notes on a mostly doubled guitar track',()=>{
  const song=fixture();
  song.tracks[0].notes.push({pitch:62,start:29,duration:1,velocity:.8});
  const notes=song.tracks[0].notes.slice(0,5).map(n=>({...n,pitch:n.pitch+12}));
  notes.push({pitch:79,start:30,duration:1,velocity:.8});
  song.tracks.push({...song.tracks[0],name:'Solo and double',program:30,notes});
  expect(prepareArrangement(song).tracks[1].notes).toMatchObject([{pitch:79,start:30}]);
});
it('keeps ghost notes as a second, softer level when they are a feature of the part',()=>{
  const hits=(ghostEvery:number)=>Array.from({length:32},(_,i)=>({pitch:38,start:i,duration:.25,velocity:i%ghostEvery===1?.3:.9}));
  const song=(notes:any[]):Song=>({meta:{id:'g',title:'G',artist:'G',bpm:120,beatsPerBar:4,beatUnit:4,sources:['midi']},sections:[],tracks:[{name:'Kit',role:'drums',program:-1,notes}]});
  const busy=compile(song(hits(4)),options);
  expect(busy).toContain('const snare_soft = s("sd")');
  expect(busy).toContain('ghost notes are separate "_soft" parts');
  const gain=(code:string,name:string)=>Number(new RegExp(`const ${name} = [^\\n]*\\.gain\\(([\\d.]+)\\)`).exec(code)![1]);
  expect(gain(busy,'snare_soft')/gain(busy,'snare')).toBeCloseTo(.3/.9,1);
  // One soft hit in 32 is not a feature of the part: it plays at the part's level.
  const rare=compile(song(hits(32)),options);
  expect(rare).not.toContain('_soft');
  expect(rare).not.toContain('ghost notes');
});
it('keeps silent notes silent when a track later unmutes',()=>{
  const song=fixture(); song.tracks[0].notes.forEach((n,i)=>n.volume=i<4?0:.5);
  const es=onsets(evaluatePattern(compile(song,options)),0,8);
  expect(es.map((e:any)=>Number(e.whole.begin)*4)).toEqual([20,28]);
  expect(es.every((e:any)=>e.value.gain>0)).toBe(true);
});
it('combines equivalent kick and crash samples without double-triggering them',()=>{
  const song=fixture();song.meta.drumKit='acoustic';
  song.tracks=[{role:'drums',name:'Kit',program:-1,notes:[35,36,49,57].map(pitch=>({pitch,start:0,duration:4,velocity:.8}))}];
  const es=onsets(evaluatePattern(compile(song,options)),0,1);
  expect(es.map((e:any)=>e.value.s).sort()).toEqual(['bassdrum1','sus_cymbal2']);
  expect(es.every((e:any)=>e.value.duration===undefined)).toBe(true);
});
for (const file of ['smells-like-teen-spirit.mid','love-me-do.mid']) it(`plays every cleaned pitched note across the complete ${file}, each for its length`,async()=>{
  const manifest=JSON.parse(fs.readFileSync(new URL('../../data/curated/manifest.json',import.meta.url),'utf8'));
  const entry=manifest.entries.find((e:any)=>e.file===file);
  const song=await loadSong({...entry,title:file,artist:'Test',sources:['midi'],files:{midi:file}},async()=>fs.readFileSync(new URL(`../../data/curated/${file}`,import.meta.url)));
  const prepared=prepareArrangement(song), code=compile(song,options), pattern=evaluatePattern(code), bars=timeline(song,options).bars;
  expect(bars).toBe(barRange(song,10000)!.nBars);
  const length=prepared.meta.beatsPerBar*4/prepared.meta.beatUnit;
  // A note may lose or gain up to OVERLAP_BEATS, and no more than a third of itself, where it overlaps the next one.
  const close=(got:number,want:number)=>got===want||(Math.abs(got-want)<=OVERLAP_BEATS/length+1e-9&&Math.abs(got-want)*3<=want+1e-9);
  let exact=0,all=0;
  for (let b=0;b<bars;b++) {
    const es=onsets(pattern,b,b+1);
    const key=(x:[string,number,string,number])=>x.slice(0,3).join('|');
    const actual=es.filter((e:any)=>e.value.note!==undefined).map((e:any)=>[e.value.s,midi(e.value.note),Number(e.whole.begin).toFixed(6),Number(e.duration)] as [string,number,string,number]).sort((x:any,y:any)=>key(x).localeCompare(key(y)));
    const expected=prepared.tracks.filter(t=>t.role!=='drums').flatMap(t=>t.notes.filter(n=>n.start/length>=b&&n.start/length<b+1).map(n=>[gmName(t.program),n.pitch,(n.start/length).toFixed(6),Math.min(n.duration/length,bars-n.start/length)] as [string,number,string,number])).sort((x,y)=>key(x).localeCompare(key(y)));
    expect(actual.map(key),`bar ${b+1}`).toEqual(expected.map(key));
    actual.forEach((a:[string,number,string,number],i:number)=>{ all++; if(Math.abs(a[3]-expected[i][3])<1e-9) exact++; expect(close(a[3],expected[i][3]),`${key(a)} lasts ${a[3]}, not ${expected[i][3]}`).toBe(true); });
    const drums = prepared.tracks.filter(t=>t.role==='drums').flatMap(t=>t.notes.filter(n=>n.start/length>=b&&n.start/length<b+1).map(n=>{
      const acoustic = ACOUSTIC_DRUMS[n.pitch], perc = percName(n.pitch);
      return JSON.stringify([acoustic?.sample ?? perc?.sample ?? drumName(n.pitch), acoustic?.index ?? Number(perc?.token.split(':')[1] ?? 0), (n.start/length).toFixed(6)]);
    }));
    const playedDrums = es.filter((e:any)=>e.value.note===undefined).map((e:any)=>JSON.stringify([e.value.s, Number(e.value.n ?? 0), Number(e.whole.begin).toFixed(6)])).sort();
    expect(playedDrums,`drums at bar ${b+1}`).toEqual([...new Set(drums)].sort());
    expect(es.every((e:any)=>['gain','velocity','duration','pan'].every(k=>e.value[k]===undefined||Number.isFinite(e.value[k])))).toBe(true);
  }
  expect(snapshot(pattern,bars,bars+8)).toEqual(snapshot(pattern,0,8));
  expect(exact/all).toBeGreaterThan(0.97);
  if(file.startsWith('smells')) {
    expect(bars).toBe(131);
    expect(code.length).toBeLessThan(8500);
    expect(code.split('\n').length).toBeLessThan(140);
    expect(code).not.toMatch(/[a-g]#?\d:[\d.]|\.as\(|mini\(/);
    expect(code).toContain('pickRestart');
    expect(code).not.toContain('gm_lead_2_sawtooth');
    const es=onsets(pattern,0,bars);
    for(const pitch of [46,49,51]) expect(es.some((e:any)=>e.value.s===ACOUSTIC_DRUMS[pitch].sample&&e.value.n===ACOUSTIC_DRUMS[pitch].index)).toBe(true);
  }
}, 30_000); // a whole song through the Strudel runtime: about 2.5 s here, several times that on a CI runner

it('treats swallowed Strudel query errors as failures rather than valid silence',()=>{
  expect(()=>queryPattern(evaluatePattern("mini('<a>').pickRestart({b:note('c')})"),0,1)).toThrow('Strudel query failed');
});
