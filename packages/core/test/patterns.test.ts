import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { compile, barRange } from '../src/strudel.js';
import { loadSong } from '../src/load.js';
import type { Song, NoteEvent } from '../src/types.js';
// @ts-expect-error Shared Node-only runtime harness.
import { evaluatePattern } from '../../../tools/strudel-runtime.mjs';
const n = (pitch: number, start: number, duration: number): NoteEvent => ({ pitch, start, duration, velocity: 0.8 });
const song = (notes: NoteEvent[]): Song => ({ meta: { id: 'patterns', title: 'Patterns', artist: 'Test', bpm: 120, beatsPerBar: 4, beatUnit: 4, sources: ['midi'] }, sections: [], tracks: [{ name: 'Guitar', program: 27, role: 'chords', notes }] });
const code = (s: Song) => compile(s, { timing: 'patterns', maxBars: 10000, maxTracks: 1000 });
const events = (s: Song) => evaluatePattern(code(s)).queryArc(0, barRange(s, 10000)!.nBars).filter((e: any) => e.hasOnset());
function pitch(note: string | number | undefined) {
  if (note === undefined || typeof note === 'number') return note;
  const m = /^([a-g])([#b]*)(-?\d+)$/i.exec(note)!;
  return (Number(m[3]) + 1) * 12 + 'c d ef g a b'.indexOf(m[1].toLowerCase()) + [...m[2]].reduce((n, x) => n + (x === '#' ? 1 : -1), 0);
}
function normalized(es: any[]) {
  const groups = new Map<string, any[]>();
  for (const e of es) {
    const k = JSON.stringify([e.value.s, e.value.n, pitch(e.value.note)]);
    const group = groups.get(k) ?? [];
    group.push({ start: Number(e.whole.begin), duration: e.value.duration ?? Number(e.whole.end.sub(e.whole.begin)) * (e.value.clip ?? 1), velocity: e.value.velocity, gain: e.value.gain, pan: e.value.pan });
    groups.set(k, group);
  }
  for (const group of groups.values()) group.sort((a, b) => a.start - b.start || a.duration - b.duration);
  return groups;
}

describe('editable Strudel phrases', () => {
  it('keeps weighted repetitions at the intended onsets', () => {
    const s = song([n(60, 0, 0.75), n(60, 0.75, 0.25), n(60, 1, 0.5), n(60, 1.5, 0.5), n(60, 2, 0.5), n(64, 2.5, 0.5), n(64, 3, 0.5), n(67, 3.5, 0.5)]);
    expect(events(s).map((e: any) => Number(e.whole.begin) * 4)).toEqual(s.tracks[0].notes.map(n => n.start));
  });
  it('keeps repetitions inside their bar when making multi-bar riffs', () => {
    const notes = Array.from({ length: 4 }, (_, b) => Array.from({ length: b % 2 ? 8 : 4 }, (_, i) => n(60 + b % 2, b * 4 + i * (b % 2 ? 0.5 : 1), 0.25))).flat();
    const s = song(notes);
    expect(events(s)).toHaveLength(notes.length);
    expect(events(s).map((e: any) => Number(e.whole.begin) * 4).sort((a: number, b: number) => a - b)).toEqual(notes.map(n => n.start));
  });
  it('factors chord voicings without losing pitches or independent releases', () => {
    const s = song([n(48, 0, 0.5), n(55, 0, 0.5), n(60, 0, 0.5), n(50, 1, 2), n(57, 1, 2), n(62, 1, 2)]);
    expect(code(s)).toContain('.transpose("0,7,12")');
    expect(events(s).map((e: any) => pitch(e.value.note)).sort((a: number, b: number) => a - b)).toEqual([48, 50, 55, 57, 60, 62]);
    expect(events(s).map((e: any) => e.value.duration).sort()).toEqual([0.125, 0.125, 0.125, 0.5, 0.5, 0.5]);
  });
  it('keeps arbitrary source names from shadowing n() or generated riff names', () => {
    const s = song([n(60, 0, 1), n(60, 4, 1), n(60, 8, 1)]);
    s.tracks[0].name = 'n';
    s.tracks.push({ ...s.tracks[0], name: 'part_n_riff1' });
    expect(events(s)).toHaveLength(6);
  });
  it('excludes vocals and respects instrumental-lead and excerpt choices', () => {
    const s = song([n(60, 0, 32)]);
    s.tracks.push({ ...s.tracks[0], name: 'Vocal', vocal: true }, { ...s.tracks[0], name: 'Lead', role: 'melody' });
    const c = compile(s, { timing: 'patterns', melody: false, maxBars: 1 });
    const es = evaluatePattern(c).queryArc(0, 1);
    expect(es).toHaveLength(1);
    expect(es[0].value.duration).toBeUndefined(); // Full-bar note uses legato(1).
    expect(Number(es[0].whole.end)).toBe(1);
  });
  for (const file of ['smells-like-teen-spirit.mid', 'love-me-do.mid']) it(`preserves every instrument event in ${file}, within the disclosed timing tolerance`, async () => {
    const manifest = JSON.parse(fs.readFileSync(new URL('../../data/curated/manifest.json', import.meta.url), 'utf8'));
    const review = manifest.entries.find((e: any) => e.file === file);
    const data = fs.readFileSync(new URL(`../../data/curated/${file}`, import.meta.url));
    const s = await loadSong({ ...review, title: file, artist: 'Test', sources: ['midi'], files: { midi: file } }, async () => data);
    const bars = barRange(s, 10000)!.nBars;
    const source = evaluatePattern(compile(s, { timing: 'source', maxBars: 10000, maxTracks: 1000 }));
    const editable = evaluatePattern(code(s));
    const original = normalized(source.queryArc(0, bars).filter((e: any) => e.hasOnset()));
    const actual = normalized(editable.queryArc(0, bars).filter((e: any) => e.hasOnset()));
    expect([...actual.keys()].sort()).toEqual([...original.keys()].sort());
    const secondsPerBar = s.meta.beatsPerBar * 4 / s.meta.beatUnit * 60 / s.meta.bpm;
    for (const [k, expected] of original) {
      const got = actual.get(k)!;
      expect(got.length, k).toBe(expected.length);
      expected.forEach((e, i) => {
        expect(Math.abs(got[i].start - e.start) * secondsPerBar, `${k} event ${i} onset`).toBeLessThan(0.01501);
        expect(Math.abs(got[i].duration - e.duration) * secondsPerBar, `${k} event ${i} duration`).toBeLessThan(0.01501);
        for (const control of ['velocity', 'gain', 'pan']) expect(got[i][control], control).toBeCloseTo(e[control], 5);
      });
    }
    const next = normalized(editable.queryArc(bars, bars + 1).filter((e: any) => e.hasOnset()).map((e: any) => ({ ...e, whole: { begin: e.whole.begin.sub(bars), end: e.whole.end.sub(bars) } })));
    expect(next).toEqual(normalized(editable.queryArc(0, 1).filter((e: any) => e.hasOnset())));
    if (file.startsWith('smells')) {
      // Compact full arrangements have their own size and playback regression tests.
      expect(code(s)).not.toMatch(/timecat\(|pure\(/);
      expect(code(s)).toContain('bass_riff1');
    }
  });
});
