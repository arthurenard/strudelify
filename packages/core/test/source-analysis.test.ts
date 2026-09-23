/**
 * The analysis and renderers the product uses: `songFromMidi` with its default source timing and
 * `compile` with source or pattern timing (midi.test.ts and strudel.test.ts cover the optional grid path).
 */
import { describe, it, expect } from 'vitest';
import { songFromMidi } from '../src/midi.js';
import { compile, timeline } from '../src/strudel.js';
import { parseMcgill } from '../src/mcgill.js';
import type { Song, Track, NoteEvent } from '../src/types.js';
import { PPQ, smf, rawNote, rawTempo, type RawEvent } from './smf.js';

const ID = { id: 't', title: 'T', artist: 'A' };
const BAR = 4 * PPQ;

/** A quarter note on `pitch` in every beat of bars `from` to `to` (exclusive), on `channel`. */
function quarters(channel: number, pitch: number, from: number, to: number): RawEvent[] {
  return Array.from({ length: (to - from) * 4 }, (_, i) => rawNote(channel, pitch, from * 4 + i, 0.9)).flat();
}

describe('controller timelines', () => {
  it('merges program and volume changes from different tracks in time order', () => {
    // Track 1 sets the channel up at tick 0 after track 0's later changes in file order; a player
    // merges the tracks by time, so from bar 20 the channel plays strings, and from bar 10 quietly.
    const data = smf([
      [{ tick: 0, bytes: [0xc0, 0] }, { tick: 0, bytes: [0xb0, 7, 100] }, { tick: 10 * BAR, bytes: [0xb0, 7, 40] }, { tick: 20 * BAR, bytes: [0xc0, 48] }, ...quarters(0, 60, 0, 40)],
      [{ tick: 0, bytes: [0xc0, 0] }, { tick: 0, bytes: [0xb0, 7, 100] }],
    ]);
    const song = songFromMidi(data, ID);
    const strings = song.tracks.find((t) => t.program === 48)!;
    const piano = song.tracks.find((t) => t.program === 0)!;
    expect(strings.notes).toHaveLength(80);
    expect(Math.min(...strings.notes.map((n) => n.start))).toBeCloseTo(80, 6);
    expect(piano.notes).toHaveLength(80);
    const volumeAt = (beat: number) => [...strings.notes, ...piano.notes].find((n) => Math.abs(n.start - beat) < 1e-6)!.volume!;
    expect(volumeAt(4)).toBeCloseTo((100 / 127) * 1, 6);
    expect(volumeAt(44)).toBeCloseTo(40 / 127, 6);
    expect(volumeAt(100)).toBeCloseTo(40 / 127, 6);
  });
});

describe('key signatures', () => {
  const withSignature = (sf: number, minor: boolean) => songFromMidi(smf([[{ tick: 0, bytes: [0xff, 0x59, 0x02, sf & 0xff, minor ? 1 : 0] }, ...quarters(0, 57, 0, 4)]]), ID).meta;
  it('reads a minor signature as the relative minor of the major key it shares its accidentals with', () => {
    expect(withSignature(0, true)).toMatchObject({ tonic: 'A', mode: 'minor' });
    expect(withSignature(1, true)).toMatchObject({ tonic: 'E', mode: 'minor' });
    expect(withSignature(-1, true)).toMatchObject({ tonic: 'D', mode: 'minor' });
    expect(withSignature(-3, true)).toMatchObject({ tonic: 'C', mode: 'minor' });
    expect(withSignature(3, true)).toMatchObject({ tonic: 'F#', mode: 'minor' });
  });
  it('reads a major signature as written', () => {
    expect(withSignature(2, false)).toMatchObject({ tonic: 'D', mode: 'major' });
    expect(withSignature(-2, false)).toMatchObject({ tonic: 'Bb', mode: 'major' });
  });
});

describe('tempo', () => {
  it('uses the typical tempo when no tempo holds for a whole bar', () => {
    // A tempo event on every beat: 32 bars at 120 bpm and a final beat at 60.
    const tempos = Array.from({ length: 128 }, (_, beat) => rawTempo(beat, beat === 127 ? 60 : 120));
    const song = songFromMidi(smf([[...tempos, ...quarters(0, 60, 0, 32)]]), ID);
    expect(song.meta.bpm).toBe(120);
    // Every beat at 120 bpm lands on its own beat; the last one, at half speed, lasts twice as long.
    const notes = song.tracks[0].notes;
    notes.forEach((n, i) => expect(n.start).toBeCloseTo(i, 6));
    expect(notes[127].duration).toBeCloseTo(1.8, 6);
  });
  it('ignores a tempo event of zero microseconds per beat instead of producing an infinite tempo', () => {
    const song = songFromMidi(smf([[rawTempo(0, 120), rawTempo(8, 0, 0), ...quarters(0, 60, 0, 8)]]), ID);
    expect(song.meta.bpm).toBe(120);
    expect(song.meta.remarks?.join(' ')).toContain('1 invalid tempo event');
    const starts = song.tracks[0].notes.map((n) => n.start);
    expect(starts.every(Number.isFinite)).toBe(true);
    expect(starts[starts.length - 1]).toBeCloseTo(31, 6);
    const code = compile(song);
    expect(code).not.toMatch(/Infinity|NaN/);
  });
  it('rejects SMPTE-timed files with a clear error rather than silent NaN timing', () => {
    // Division 0xE7 0x28: -25 frames per second, 40 ticks per frame.
    const data = smf([quarters(0, 60, 0, 2)], [0xe7, 0x28]);
    expect(() => songFromMidi(data, ID)).toThrow(/SMPTE/);
  });
});

describe('part statistics', () => {
  /** A part: `held` (pitch 50, from beat 0, `heldBeats` long) under a line of `count` notes from `lineStart`. */
  const partWith = (heldBeats: number, lineStart: number, count: number, program = 0) => {
    const line = Array.from({ length: count }, (_, i) => rawNote(0, 64 + (i % 3) * 3, lineStart + i, 0.9)).flat();
    return songFromMidi(smf([[{ tick: 0, bytes: [0xc0, program] }, ...rawNote(0, 50, 0, heldBeats), ...line]]), ID).tracks[0];
  };
  it('counts a held note as harmony for the line it holds up', () => {
    expect(partWith(12, 1, 11).role).toBe('chords');
    expect(partWith(30, 1, 11).role).toBe('chords');
  });
  it('does not let a stuck note turn the line played over it into chords', () => {
    // A note-off that comes sixty beats later is cut at eight bars; how long the note really rang is unknown.
    const part = partWith(60, 1, 48, 11);
    expect(Math.max(...part.notes.map((n) => n.duration))).toBe(32);
    expect(part.role).not.toBe('chords');
  });
});

describe('part cap in the source and pattern renderers', () => {
  const note = (pitch: number, start: number, duration: number): NoteEvent => ({ pitch, start, duration, velocity: 0.8 });
  const part = (name: string, program: number, role: Track['role'], pitch: number): Track => ({ name, program, role, notes: Array.from({ length: 16 }, (_, i) => note(pitch, i, 1)) });
  const song = (tracks: Track[]): Song => ({ meta: { id: 's', title: 'T', artist: 'A', bpm: 120, beatsPerBar: 4, beatUnit: 4, sources: ['midi'] }, sections: [], tracks });
  // Twelve pads come first in the file, then the bass and the tune.
  const crowded = song([...Array.from({ length: 12 }, (_, i) => part(`Pad ${i + 1}`, 88, 'other', 60 + i)), part('Bass', 33, 'bass', 36), part('Flute', 73, 'melody', 76)]);
  for (const timing of ['source', 'patterns'] as const) {
    it(`keeps the bass and the melody when there are more parts than the cap (${timing})`, () => {
      const code = compile(crowded, { timing, maxTracks: 12 });
      const sound = (name: string) => new RegExp(`\\.s\\(["']${name}["']\\)`, 'g');
      expect(code).toMatch(sound('gm_electric_bass_finger'));
      expect(code).toMatch(sound('gm_flute'));
      expect(code.match(sound('gm_pad_new_age'))).toHaveLength(10);
      // The kept parts stay in file order.
      expect(code.search(sound('gm_pad_new_age'))).toBeLessThan(code.search(sound('gm_electric_bass_finger')));
      expect(code.search(sound('gm_electric_bass_finger'))).toBeLessThan(code.search(sound('gm_flute')));
    });
  }
  it('leaves the parts alone when the cap is not reached', () => {
    const code = compile(song(crowded.tracks.slice(10)), { maxTracks: 12 });
    expect(code.match(/'gm_pad_new_age'/g)).toHaveLength(2);
  });
  for (const timing of ['source', 'patterns'] as const) {
    it(`names a part written in another script after its patch, not "part" (${timing})`, () => {
      const code = compile(song([part('ギター', 25, 'chords', 60), part('Гитара', 25, 'other', 64)]), { timing });
      expect(code).toContain('const acoustic_guitar_steel =');
      expect(code).toContain('const acoustic_guitar_steel_2 =');
      expect(code).not.toMatch(/const part(_\d+)? =/);
    });
  }
  it('renders silence, not a made-up groove, when a song has neither parts nor chords', () => {
    const empty = song([]);
    const code = compile(empty);
    expect(code.trim().split('\n').pop()).toBe('silence');
    expect(code).not.toMatch(/\bbd\b|arrange\(/);
    expect(timeline(empty).bars).toBe(0);
  });
});

describe('McGill metre and key', () => {
  const chart = (body: string) => `# title: T\n# artist: A\n${body}`;
  it('takes the key and metre from the header, not from a later modulation or metre change', () => {
    const song = parseMcgill(chart(`# metre: 4/4\n# tonic: C\n\n0.0\tsilence\n1.0\tA, verse, | C:maj | F:maj | G:maj | C:maj |\n9.0\t| C:maj | F:maj | G:maj | C:maj |\n# tonic: D\n17.0\tB, chorus, | D:maj | G:maj |\n21.0\tend\n`), 'k');
    expect(song.meta.tonic).toBe('C');
    expect(song.meta.beatsPerBar).toBe(4);
  });
  it('keeps each bar its own length when the metre changes, on the grid of the longest-lasting metre', () => {
    // Four bars of 7/4, then eight of 4/4: 28 quarters against 32, so the grid is 4/4.
    const song = parseMcgill(chart(`# metre: 7/4\n# tonic: B\n\n0.0\tA, intro, | B:min | B:min | B:min | B:min |\n# metre: 4/4\n14.0\tB, solo, | B:min | B:min | B:min | B:min | E:min | E:min | E:min | E:min |\n30.0\tend\n`), 'm');
    expect([song.meta.beatsPerBar, song.meta.beatUnit]).toEqual([4, 4]);
    const beats = (label: string) => song.sections.find((s) => s.label === label)!.chords.reduce((n, c) => n + c.beats, 0);
    expect(beats('intro')).toBe(28);
    expect(beats('solo')).toBe(32);
    expect(song.meta.remarks?.[0]).toContain('7/4 at bar 1, 4/4 at bar 5');
  });
  it('counts an inline bar metre in the song\'s beat unit', () => {
    const song = parseMcgill(chart(`# metre: 4/4\n# tonic: E\n\n0.0\tA, verse, | E:maj | (3/8) A:maj | E:maj |\n5.0\tend\n`), 'e');
    expect(song.sections[0].chords).toEqual([{ symbol: 'E', beats: 4 }, { symbol: 'A', beats: 1.5 }, { symbol: 'E', beats: 4 }]);
    const waltz = parseMcgill(chart(`# metre: 6/8\n# tonic: E\n\n0.0\tA, verse, | E:maj | (2/4) A:maj |\n5.0\tend\n`), 'w');
    expect(waltz.sections[0].chords).toEqual([{ symbol: 'E', beats: 6 }, { symbol: 'A', beats: 4 }]);
  });
});

describe('render', () => {
  it('gives the same code and timeline as compile and timeline, preparing the song once', async () => {
    const { render } = await import('../src/strudel.js');
    const note = (pitch: number, start: number): NoteEvent => ({ pitch, start, duration: 0.5, velocity: 0.8 });
    const bass: Track = { name: 'Bass', program: 33, role: 'bass', notes: Array.from({ length: 64 }, (_, i) => note(36 + (i % 4), i / 2)) };
    const drums: Track = { name: 'Drums', program: -1, role: 'drums', notes: Array.from({ length: 64 }, (_, i) => note(i % 2 ? 38 : 36, i / 2)) };
    const song: Song = { meta: { id: 's', title: 'T', artist: 'A', bpm: 120, beatsPerBar: 4, beatUnit: 4, sources: ['midi'] }, sections: [], tracks: [bass, drums] };
    for (const opts of [{ form: 'loop', timing: 'patterns' }, { timing: 'patterns' }, { timing: 'source' }] as const) {
      const r = render(song, opts);
      expect(r.code).toBe(compile(song, opts));
      expect(r.timeline).toEqual(timeline(song, opts));
    }
  });
});
