import { describe, expect, it } from 'vitest';
import { compile } from '../src/strudel.js';
import type { Song, NoteEvent } from '../src/types.js';
// @ts-expect-error Node-only audit helper, shared with the full library check.
import { evaluatePattern } from '../../../tools/strudel-runtime.mjs';

function makeSong(notes: NoteEvent[]): Song {
  return {
    meta: { id: 'held', title: 'Held notes', artist: 'Test', bpm: 120, beatsPerBar: 4, beatUnit: 4, sources: ['midi'] },
    sections: [], tracks: [{ name: 'Piano', role: 'melody', program: 0, notes }],
  };
}
const n = (pitch: number, start: number, duration: number): NoteEvent => ({ pitch, start, duration, velocity: 0.8 });

describe('generated note durations in the Strudel runtime', () => {
  it('keeps track names from shadowing the player’s generated helper calls', () => {
    for (const name of ['M', 'New', 'Stack', 'Undefined', 'Pure', 'Gain', 'Timecat']) {
      const song = makeSong([n(60, 0, 1), n(64, 1, 1)]);
      song.tracks[0].role = 'other';
      song.tracks[0].name = name;
      expect(evaluatePattern(compile(song)).queryArc(0, 1)).toHaveLength(2);
    }
  });
  it('keeps full-bar notes to one cycle each', () => {
    const pattern = evaluatePattern(compile(makeSong([n(60, 0, 4), n(64, 4, 4)])));
    const events = pattern.queryArc(0, 2).filter((event: { hasOnset(): boolean }) => event.hasOnset());
    expect(events.map((event: { value: { note: string } }) => event.value.note)).toEqual(['c4', 'e4']);
    expect(events.map((event: { whole: { begin: { valueOf(): number } } }) => Number(event.whole.begin))).toEqual([0, 1]);
  });
  it('holds a note across a bar line without retriggering it', () => {
    const pattern = evaluatePattern(compile(makeSong([n(60, 0, 8)])));
    const events = pattern.queryArc(0, 2);
    expect(events).toHaveLength(1);
    expect(events[0].value.note).toBe('c4');
    expect(events[0].value.duration).toBe(2);
  });
  it('keeps independently held chord tones and overlapping onsets', () => {
    const pattern = evaluatePattern(compile(makeSong([n(60, 0, 8), n(64, 0, 1), n(67, 1, 2)])));
    const values = pattern.queryArc(0, 2).map((event: { value: unknown }) => event.value);
    expect(values).toEqual(expect.arrayContaining([
      expect.objectContaining({ note: 'c4', duration: 2 }),
      expect.objectContaining({ note: 'e4', duration: 0.25 }),
      expect.objectContaining({ note: 'g4', duration: 0.5 }),
    ]));
    expect(values).toHaveLength(3);
  });
  it('caps a held note at the requested excerpt end', () => {
    const pattern = evaluatePattern(compile(makeSong([n(60, 0, 32)]), { maxBars: 1 }));
    expect(pattern.queryArc(0, 1)[0].value.duration).toBe(1);
  });
  it('pads partial chord-chart bars without stretching the song loop', () => {
    const song = makeSong([]);
    song.tracks = [];
    song.sections = [
      { label: 'intro', bars: 0.5, chords: [{ symbol: 'C', beats: 2 }] },
      { label: 'verse', bars: 1, chords: [{ symbol: 'G', beats: 4 }] },
    ];
    const pattern = evaluatePattern(compile(song));
    const bass = (bar: number) => pattern.queryArc(bar, bar + 1).filter((event: { value: { s: string } }) => event.value.s === 'gm_electric_bass_finger');
    expect(bass(0)[0].value.note).toBe('c2');
    expect(Number(bass(0)[0].whole.end)).toBe(0.5);
    expect(bass(1)[0].value.note).toBe('g2');
    expect(bass(2)[0].value.note).toBe('c2');
  });
});
