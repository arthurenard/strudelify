import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { Midi } from '@tonejs/midi';
import { compile, barRange } from '../src/strudel.js';
import { loadSong } from '../src/load.js';
import { songFromMidi } from '../src/midi.js';
import type { Song, Track, NoteEvent } from '../src/types.js';
// @ts-expect-error Shared Node-only runtime harness.
import { evaluatePattern } from '../../../tools/strudel-runtime.mjs';
const note = (pitch: number, start: number, duration: number, velocity = 0.8): NoteEvent => ({ pitch, start, duration, velocity });
const song = (tracks: Track[]): Song => ({ meta: { id: 'test', title: 'Performance', artist: 'Test', bpm: 120, beatsPerBar: 4, beatUnit: 4, sources: ['midi'] }, sections: [], tracks });
const track = (notes: NoteEvent[], changes: Partial<Track> = {}): Track => ({ name: 'Guitar', program: 27, role: 'chords', notes, ...changes });
const events = (s: Song) => evaluatePattern(compile(s)).queryArc(0, barRange(s)!.nBars).filter((e: any) => e.hasOnset());

describe('instrumental performance rendering', () => {
  it('preserves microtiming, strums, flams, overlaps and individual dynamics', () => {
    const s = song([track([note(60, 0, 5, 0.2), note(64, 0.037, 0.4, 0.9), note(67, 0.083, 2, 0.6), note(60, 0.111, 0.01, 0.7)])]);
    const es = events(s).sort((a: any, b: any) => Number(a.whole.begin) - Number(b.whole.begin));
    expect(es).toHaveLength(4);
    s.tracks[0].notes.forEach((n, i) => {
      expect(Number(es[i].whole.begin) * 4).toBeCloseTo(n.start, 6);
      expect(es[i].value.duration * 4).toBeCloseTo(n.duration, 6);
      expect(es[i].value.velocity).toBeCloseTo(n.velocity, 6);
    });
  });
  it('removes lead and backing vocals on every patch, while keeping harmonica and guitar', () => {
    const s = song([track([note(60, 0, 4)]), track([note(67, 0, 4)], { name: 'Harmonica', program: 22, role: 'melody' }), ...(['melody', 'chords', 'other'] as const).map((role, i) => track([note(80 + i, 0, 4)], { name: 'Vocals', vocal: true, role, program: [52, 0, 81][i] }))]);
    expect(events(s).map((e: any) => e.value.s).sort()).toEqual(['gm_electric_guitar_clean', 'gm_harmonica']);
    const onlyVocals = song(s.tracks.filter(t => t.vocal));
    expect(events(onlyVocals)).toHaveLength(0);
  });
  it('preserves per-note channel fades and stereo positions', () => {
    const s = song([track([{ ...note(60, 0, 1), volume: 0.5, pan: 0 }, { ...note(60, 1, 1), volume: 0.25, pan: 1 }], { volume: 0.5 })]);
    const es = events(s);
    expect(es[0].value.gain / es[1].value.gain).toBeCloseTo(4, 6);
    expect(es.map((e: any) => e.value.pan)).toEqual([0, 1]);
  });
  it('preserves a channel that unmutes after silent notes even when its median volume is zero', () => {
    const s = song([track([{ ...note(60, 0, 1), volume: 0 }, { ...note(64, 1, 1), volume: 0.5 }], { volume: 0 })]);
    const es = events(s);
    expect(es[0].value.gain).toBe(0);
    expect(es[1].value.gain).toBeCloseTo(0.2, 6);
  });
  it('keeps quiet short instrumental details instead of discarding them', () => {
    const s = song([track([note(60, 0, 4)]), track([note(72, 0.3, 0.1, 0.1)], { name: 'Fill', volume: 0.2 })]);
    expect(events(s)).toHaveLength(2);
  });
  it('preserves drum flam timing and velocities without converting them to chords or ghost buckets', () => {
    const s = song([track([note(38, 0, 0.1, 0.2), note(38, 0.025, 0.1, 0.9)], { role: 'drums', program: -1 })]);
    const es = events(s);
    expect(es).toHaveLength(2);
    expect(Number(es[1].whole.begin) * 4).toBeCloseTo(0.025, 6);
    expect(es.map((e: any) => e.value.velocity)).toEqual([0.2, 0.9]);
  });
  it('keeps tempo changes in elapsed seconds and does not snap them to nearby ratios', () => {
    const m = new Midi(); m.header.setTempo(120);
    m.header.tempos.push({ ticks: 1920, bpm: 123 }); m.header.update();
    const t = m.addTrack(); t.name = 'Guitar'; t.instrument.number = 27;
    t.addNote({ midi: 60, ticks: 0, durationTicks: 960, velocity: 0.8 });
    t.addNote({ midi: 64, ticks: 3000, durationTicks: 20, velocity: 0.8 });
    const s = songFromMidi(m.toArray(), { id: 'tempo', title: 'Tempo', artist: 'Test' }, { sourceTiming: true });
    const n = s.tracks.flatMap(t => t.notes).find(n => n.pitch === 64)!;
    expect(n.start * 60 / s.meta.bpm).toBeCloseTo(m.header.ticksToSeconds(3000), 5);
    expect(n.duration * 60 / s.meta.bpm).toBeCloseTo(m.header.ticksToSeconds(3020) - m.header.ticksToSeconds(3000), 5);
  });
  for (const [file, title, artist, instruments] of [
    ['love-me-do.mid', 'Love Me Do', 'The Beatles', [22, 25, 32]],
    ['smells-like-teen-spirit.mid', 'Smells Like Teen Spirit', 'Nirvana', [25, 27, 29, 30, 34]],
  ] as const) it(`renders every retained instrumental note in the curated ${title}`, async () => {
    const data = fs.readFileSync(new URL(`../../data/curated/${file}`, import.meta.url));
    const manifest = JSON.parse(fs.readFileSync(new URL('../../data/curated/manifest.json', import.meta.url), 'utf8'));
    const review = manifest.entries.find((e: { file: string }) => e.file === file);
    const s = await loadSong({ id: file, title, artist, sources: ['midi'], files: { midi: file }, drumKit: 'acoustic', vocalChannels: review.vocalChannels, beatScale: review.beatScale }, async () => data);
    expect(s.tracks.filter(t => t.role !== 'drums' && !t.vocal).map(t => t.program).sort((a, b) => a - b)).toEqual(instruments);
    const raw = songFromMidi(data, { id: file, title, artist });
    const end = (song: Song) => Math.max(...song.tracks.flatMap(t => t.notes.map(n => n.start + n.duration))) * 60 / song.meta.bpm;
    expect(end(s)).toBeCloseTo(end(raw), 6);
    const es = events(s).filter((e: any) => e.value.note !== undefined);
    const original = s.tracks.filter(t => t.role !== 'drums' && !t.vocal).flatMap(t => t.notes);
    expect(es).toHaveLength(original.length);
    const range = barRange(s)!;
    const offset = range.firstBar * s.meta.beatsPerBar * 4 / s.meta.beatUnit + (s.meta.barOffset ?? 0);
    const length = s.meta.beatsPerBar * 4 / s.meta.beatUnit;
    const starts = es.map((e: any) => Number(e.whole.begin) * length + offset).sort((a: number, b: number) => a - b);
    original.map(n => n.start).sort((a, b) => a - b).forEach((start, i) => expect(starts[i]).toBeCloseTo(start, 5));
  });
});

describe('reviewed acoustic percussion', () => {
  it('uses recorded acoustic sounds while preserving drum events', () => {
    const s = song([track([note(36, 0, 0.1), note(38, 1, 0.1), note(42, 2, 0.1), note(49, 3, 0.1)], { role: 'drums' })]);
    s.meta.drumKit = 'acoustic';
    expect(events(s).map((e: any) => e.value.s)).toEqual(['bassdrum1', 'snare_modern', 'hihat', 'sus_cymbal2']);
  });
});
