import { describe, it, expect } from 'vitest';
import { compile, barRange } from '../src/strudel.js';
import { riffLabel, OVERLAP_BEATS } from '../src/patterns.js';
import type { Song, Track, NoteEvent } from '../src/types.js';
// @ts-expect-error Shared Node-only runtime harness.
import { evaluatePattern } from '../../../tools/strudel-runtime.mjs';

const n = (pitch: number, start: number, duration: number, velocity = 0.8): NoteEvent => ({ pitch, start, duration, velocity });
const part = (notes: NoteEvent[], program = 0, role: Track['role'] = 'chords', name = 'Keys'): Track => ({ name, program, role, notes });
const song = (...tracks: Track[]): Song => ({ meta: { id: 'p', title: 'Patterns', artist: 'Test', bpm: 120, beatsPerBar: 4, beatUnit: 4, sources: ['midi'] }, sections: [], tracks });
const full = (s: Song) => compile(s, { timing: 'patterns', maxBars: 10000, maxTracks: 1000 });
const loop = (s: Song) => compile(s, { form: 'loop', timing: 'patterns' });
/** Every onset in `bars` bars of the code: [note or sound, start and length in beats]. */
function played(code: string, bars: number): [string, number, number][] {
  return evaluatePattern(code).queryArc(0, bars).filter((e: any) => e.hasOnset())
    .map((e: any) => [String(e.value.note ?? e.value.s), Number(e.whole.begin) * 4, Number(e.duration) * 4] as [string, number, number])
    .sort((a: any, b: any) => a[1] - b[1] || a[0].localeCompare(b[0]));
}
/** The generated code of the part called `name`, from its comment to its last line. */
const partOf = (code: string, name: string) => code.slice(code.lastIndexOf('//', code.indexOf(`const ${name} =`)), code.indexOf('\n\n', code.indexOf(`const ${name} =`)));

describe('editable patterns', () => {
  it('writes each note for its steps and fills the gaps with rests, with no number on a note', () => {
    const s = song(part([n(60, 0, 1), n(64, 2, 1), n(67, 3, 0.5)]));
    const code = full(s);
    expect(code).toContain('note("c4@2 ~@2 e4@2 g4 ~")');
    expect(code).not.toMatch(/[a-g]#?\d:[\d.]/);
    expect(played(code, 1)).toEqual([['c4', 0, 1], ['e4', 2, 1], ['g4', 3, 0.5]]);
  });

  it('writes notes struck together for the same length as a chord', () => {
    const code = full(song(part([n(60, 0, 2), n(64, 0, 2), n(67, 0, 2), n(62, 2, 2)])));
    expect(code).toContain('note("[c4,e4,g4] d4")');
  });

  it('puts a note still sounding when the next one starts into a second voice, after the main line', () => {
    const s = song(part([n(48, 0, 4), n(64, 1, 1), n(67, 2, 1)]));
    const code = full(s);
    expect(code).toContain('note("~ e4 g4 ~, c3")');
    expect(played(code, 1)).toEqual([['c3', 0, 4], ['e4', 1, 1], ['g4', 2, 1]]);
  });

  it('trims a note that runs only slightly into the next one instead of opening a voice', () => {
    const code = full(song(part([n(36, 0, 2.25), n(43, 2, 2)], 33, 'bass', 'Bass')));
    expect(code).toContain('note("c2 g2")');
    expect(played(code, 1).map((e) => e[2])).toEqual([2, 2]);
    expect(OVERLAP_BEATS).toBe(0.25);
  });

  it('holds a note across the bar line in a riff of several bars, at its full length', () => {
    const notes = [n(57, 0, 8), n(60, 0, 8), n(64, 0, 8), n(55, 8, 4), n(59, 8, 4), n(62, 8, 4), n(57, 12, 8), n(60, 12, 8), n(64, 12, 8)];
    const code = full(song(part(notes, 48, 'chords', 'Strings')));
    expect(code).toContain('A: "[a3,c4,e4]/2"');
    expect(code).toContain('"<A@2 B A@2>".pickRestart(');
    expect(played(code, 5).filter((e) => e[0] === 'a3')).toEqual([['a3', 0, 8], ['a3', 12, 8]]);
  });

  it('names each distinct bar once, in order of appearance, and plays the riffs in order', () => {
    const bar = (b: number, pitch: number) => [n(pitch, b * 4, 1), n(pitch + 7, b * 4 + 1, 1), n(pitch + 12, b * 4 + 2, 2)];
    const order = [0, 0, 5, 0, 7, 7, 5, 0, 0, 5, 7, 0, 5, 5];
    const s = song(part(order.flatMap((step, b) => bar(b, 36 + step)), 33, 'bass', 'Bass'));
    const code = full(s);
    expect(code).toContain('const bass = note("<A@2 B A C@2 B A@2 B C A B@2>".pickRestart({');
    expect(code).toContain('A: "c2 g2 c3@2", B: "f2 c3 f3@2", C: "g2 d3 g3@2",');
    expect(played(code, order.length)).toHaveLength(s.tracks[0].notes.length);
  });

  it('labels riffs A to Z, then AA, AB..., never like a note name', () => {
    expect([0, 25, 26, 27, 51, 52, 701, 702].map(riffLabel)).toEqual(['A', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
  });

  it('writes a short part as one sequence of bars', () => {
    const s = song(part([n(60, 0, 4), n(62, 4, 4), n(62, 8, 4), n(64, 12, 2)]));
    expect(full(s)).toContain('note("<c4 d4!2 [e4 ~]>")');
  });

  it('writes drums as each sound with its rhythm, one part per sound', () => {
    const kit = part([n(36, 0, 0.1), n(36, 1.5, 0.1), n(36, 2, 0.1), n(38, 1, 0.1), n(38, 3, 0.1), n(42, 0, 0.1), n(44, 2, 0.1)], -1, 'drums', 'Kit');
    const code = full(song(kit));
    expect(code).toContain('const kick = s("bd").struct("x ~@2 x!2 ~@3")');
    expect(code).toContain('const snare = s("sd").struct("~ x ~ x")');
    // Closed and pedal hi-hat play the same sample: one part.
    expect(code).toContain('const hihat = s("hh").struct("x!2")');
    expect(played(code, 1).filter((e) => e[0] === 'bd').map((e) => e[1])).toEqual([0, 1.5, 2]);
    expect(code).not.toContain('pedal_hat');
  });

  it('gives each part one level, velocity included, and a loop\'s ghost notes a softer part of their own', () => {
    const hats = Array.from({ length: 16 }, (_, i) => n(42, i / 2, 0.1, i % 2 ? 0.3 : 0.9));
    const code = loop(song(part(hats, -1, 'drums', 'Kit')));
    expect(code).toContain('const hihat = s("hh").struct("x!4")');
    expect(code).toContain('const hihat_soft = s("hh").struct("~ x ~ x ~ x ~ x")');
    const gain = (name: string) => Number(/\.gain\(([\d.]+)\)/.exec(partOf(code, name))![1]);
    expect(gain('hihat_soft')).toBeCloseTo(gain('hihat') / 2, 1);
    expect(code).toContain('ghost notes are separate "_soft" parts');
  });

  it('writes a loop with a note held over its bar line as one pattern, a line per bar when long', () => {
    const bass = part([n(36, 0, 3), n(43, 3.5, 1), n(41, 5, 3)], 33, 'bass', 'Bass');
    const code = loop(song(bass, part([n(60, 0, 1), n(60, 4, 1)])));
    expect(partOf(code, 'bass')).toContain('const bass = note("[c2@6 ~ g2@2 ~ f2@6]/2")');
    expect(played(code, 2).filter((e) => e[0] !== 'c4')).toEqual([['c2', 0, 3], ['g2', 3.5, 1], ['f2', 5, 3]]);
    // A run of sixteenths in every bar and a note held over each bar line: too long for one line. The run is
    // the main voice, a line per bar; the held note, still sounding when the next run starts, is a second voice.
    const busy = part(Array.from({ length: 4 }, (_, b) => [...Array.from({ length: 12 }, (_, i) => n(48 + (i % 5), b * 4 + i / 4, 0.25)), n(43, b * 4 + 3, 2)]).flat(), 33, 'bass', 'Bass');
    expect(partOf(loop(song(busy)), 'bass')).toContain([
      'const bass = note(`[',
      '  c3 c#3 d3 d#3 e3 c3 c#3 d3 d#3 e3 c3 c#3 ~@4',
      '  c3 c#3 d3 d#3 e3 c3 c#3 d3 d#3 e3 c3 c#3 g2@4,',
      '  ~@3 g2@2',
      '  ~@3',
      ']/2`)',
    ].join('\n'));
  });

  it('keeps source names from shadowing the functions the code uses', () => {
    const s = song(part([n(60, 0, 1), n(60, 4, 1), n(60, 8, 1)], 0, 'other', 'n'), part([n(64, 0, 1)], 0, 'other', 'note'));
    const code = full(s);
    expect(played(code, 3)).toHaveLength(4);
  });

  it('excludes vocals and respects the melody choice', () => {
    const s = song(part([n(60, 0, 32)], 0, 'chords'), { ...part([n(80, 0, 32)], 53, 'melody', 'Vocal'), vocal: true }, part([n(72, 0, 32)], 73, 'melody', 'Lead'));
    const code = compile(s, { timing: 'patterns', melody: false, maxBars: 1 });
    expect(played(code, 1).map((e) => e[0])).toEqual(['c4']);
    expect(barRange(s, 1)!.nBars).toBe(1);
  });
});
