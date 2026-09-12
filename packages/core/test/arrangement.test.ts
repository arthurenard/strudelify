import { it, expect } from 'vitest';
import fs from 'node:fs';
import { compile, timeline, barRange } from '../src/strudel.js';
import { prepareArrangement } from '../src/arrangement.js';
import { loadSong } from '../src/load.js';
import { gmName, percName, drumName } from '../src/gm.js';
import { ACOUSTIC_DRUMS } from '../src/acoustic-drums.js';
import type { Song } from '../src/types.js';
// @ts-expect-error Shared Node-only runtime harness.
import { evaluatePattern, queryPattern } from '../../../tools/strudel-runtime.mjs';
const options = { timing: 'patterns', simplify: true, maxBars: 10000, maxTracks: 1000 } as const;
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
for (const file of ['smells-like-teen-spirit.mid','love-me-do.mid']) it(`plays every cleaned pitched attack across the complete ${file}`,async()=>{
  const manifest=JSON.parse(fs.readFileSync(new URL('../../data/curated/manifest.json',import.meta.url),'utf8'));
  const entry=manifest.entries.find((e:any)=>e.file===file);
  const song=await loadSong({...entry,title:file,artist:'Test',sources:['midi'],files:{midi:file}},async()=>fs.readFileSync(new URL(`../../data/curated/${file}`,import.meta.url)));
  const prepared=prepareArrangement(song), code=compile(song,options), pattern=evaluatePattern(code), bars=timeline(song,options).bars;
  expect(bars).toBe(barRange(song,10000)!.nBars);
  const length=prepared.meta.beatsPerBar*4/prepared.meta.beatUnit;
  for (let b=0;b<bars;b++) {
    const es=onsets(pattern,b,b+1);
    const actual=es.filter((e:any)=>e.value.note!==undefined).map((e:any)=>JSON.stringify([e.value.s,midi(e.value.note),(Number(e.whole.begin)).toFixed(6), (e.value.duration ?? Number(e.whole.end.sub(e.whole.begin))*(e.value.clip??1)).toFixed(6)])).sort();
    const expected=prepared.tracks.filter(t=>t.role!=='drums').flatMap(t=>t.notes.filter(n=>n.start/length>=b&&n.start/length<b+1).map(n=>JSON.stringify([gmName(t.program),n.pitch,(n.start/length).toFixed(6),(n.duration/length).toFixed(6)]))).sort();
    expect(actual,`bar ${b+1}`).toEqual(expected);
    const drums = prepared.tracks.filter(t=>t.role==='drums').flatMap(t=>t.notes.filter(n=>n.start/length>=b&&n.start/length<b+1).map(n=>{
      const acoustic = ACOUSTIC_DRUMS[n.pitch], perc = percName(n.pitch);
      return JSON.stringify([acoustic?.sample ?? perc?.sample ?? drumName(n.pitch), acoustic?.index ?? Number(perc?.token.split(':')[1] ?? 0), (n.start/length).toFixed(6)]);
    }));
    const playedDrums = es.filter((e:any)=>e.value.note===undefined).map((e:any)=>JSON.stringify([e.value.s, Number(e.value.n), Number(e.whole.begin).toFixed(6)])).sort();
    expect(playedDrums,`drums at bar ${b+1}`).toEqual([...new Set(drums)].sort());
    expect(es.every((e:any)=>['gain','velocity','duration','pan'].every(k=>e.value[k]===undefined||Number.isFinite(e.value[k])))).toBe(true);
  }
  expect(snapshot(pattern,bars,bars+8)).toEqual(snapshot(pattern,0,8));
  if(file.startsWith('smells')) {
    expect(bars).toBe(131);
    expect(code.length).toBeLessThan(11000);
    expect(code.split('\n').length).toBeLessThan(140);
    expect(code).toContain('pickRestart');
    expect(code).not.toContain('gm_lead_2_sawtooth');
    const es=onsets(pattern,0,bars);
    for(const pitch of [46,49,51]) expect(es.some((e:any)=>e.value.s===ACOUSTIC_DRUMS[pitch].sample&&e.value.n===ACOUSTIC_DRUMS[pitch].index)).toBe(true);
  }
});

it('treats swallowed Strudel query errors as failures rather than valid silence',()=>{
  expect(()=>queryPattern(evaluatePattern("mini('<a>').pickRestart({b:note('c')})"),0,1)).toThrow('Strudel query failed');
});
