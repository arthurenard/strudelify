import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { selectLoop, loopLength, LONGEST_SECONDS } from '../src/loop.js';
import { compile, timeline, barRange } from '../src/strudel.js';
import { loadSong } from '../src/load.js';
import type { Song, NoteEvent } from '../src/types.js';
// @ts-expect-error Node runtime harness.
import { evaluatePattern, validatePattern } from '../../../tools/strudel-runtime.mjs';
const note = (pitch: number, start: number, duration = .5): NoteEvent => ({ pitch, start, duration, velocity: .8 });
/** A one-bar intro, then a two-bar figure played twelve times. */
function fixture(): Song {
  const notes = [note(72, 0), ...Array.from({ length: 12 }, (_, repeat) => [note(48, 4 + repeat * 8), note(50, 8 + repeat * 8)]).flat()];
  return { meta: { id: 'any-id', title: 'Any title', artist: 'Any artist', bpm: 120, beatsPerBar: 4, beatUnit: 4, sources: ['midi'] }, sections: [], tracks: [
    { name: 'Bass', role: 'bass', program: 33, notes },
    { name: 'Guitar', role: 'chords', program: 27, notes: notes.map(n => ({ ...n, pitch: n.pitch + 12 })) },
    { name: 'Vocal', role: 'melody', program: 53, vocal: true, notes: [note(80, 0, 40)] },
  ] };
}
describe('automatic main loops', () => {
  it('finds an eight-bar phrase the band repeats, independent of song identity, without modifying the source', () => {
    const source = fixture(), before = structuredClone(source), picked = selectLoop(source);
    expect(picked.bars).toBe(8);
    expect(picked.firstBar).toBeGreaterThan(0); // not the intro
    expect(picked.repeats).toBeGreaterThanOrEqual(2);
    expect(source).toEqual(before);
    expect(picked.song.tracks.map(t => t.name)).toEqual(['Bass', 'Guitar']);
    expect(picked.song.tracks[0].notes.map(n => n.start)).toEqual([0, 4, 8, 12, 16, 20, 24, 28]);
    const renamed = structuredClone(source); renamed.meta.id = 'nirvana--smells-like-teen-spirit'; renamed.meta.title = 'Changed';
    expect(selectLoop(renamed).song.tracks).toEqual(picked.song.tracks);
  });
  it('retains the full selected period including trailing rests and repeats at that boundary', () => {
    const source = fixture(), opts = { form: 'loop', timing: 'patterns', maxBars: 1 } as const;
    expect(timeline(source, opts).bars).toBe(8);
    const events = evaluatePattern(compile(source, opts)).queryArc(0, 16).filter((e: any) => e.hasOnset());
    expect(events.map((e: any) => Number(e.whole.begin)).sort((a: number, b: number) => a - b)).toEqual(Array.from({ length: 16 }, (_, i) => [i, i]).flat());
    expect(validatePattern(compile(source, opts), 8)).toBe(16);
    const selected = selectLoop(source).song;
    selected.tracks.forEach(t => t.notes = t.notes.filter(n => n.start < 16));
    expect(barRange(selected)).toEqual({ firstBar: 0, nBars: 8, totalBars: 8 });
  });
  it('lasts a phrase: eight bars, sixteen when eight would be very short, four when very long', () => {
    const meta = fixture().meta;
    expect(loopLength(meta, 100)).toBe(8); // 16 s at 120 bpm
    expect(loopLength({ ...meta, bpm: 180, beatsPerBar: 2 }, 100)).toBe(16); // 5.3 s for eight bars of 2/4
    expect(loopLength({ ...meta, bpm: 40, beatsPerBar: 6 }, 100)).toBe(4); // 72 s for eight bars of 6/4
    expect(loopLength(meta, 5)).toBe(5);
  });
  it('drops a note played a hair before the next downbeat instead of ending the loop on a blip', () => {
    const source = fixture();
    // Every figure's first note comes a thirty-second early, so the next phrase's first note falls just before the loop's end.
    for (const t of source.tracks) t.notes = t.notes.map(n => (n.start >= 4 ? { ...n, start: n.start - 0.1 } : n));
    const picked = selectLoop(source).song, end = picked.meta.loopBars! * 4;
    for (const t of picked.tracks) expect(t.notes.every(n => n.start < end - 0.5)).toBe(true);
    expect(picked.tracks[0].notes[0].start).toBe(0);
  });
  it('uses one direct pattern across changing gates, voicings and empty bars', () => {
    const source = fixture();
    source.tracks = [{ name: 'Keys', program: 0, role: 'chords', notes: [note(60, 0, 1), note(64, 0, 1), note(60, 4, 2), note(67, 4, 2), note(62, 12, .5)] }];
    const picked = selectLoop(source).song;
    const code = compile(source, { form: 'loop', timing: 'patterns' });
    expect(code).not.toContain('arrange(');
    const events = evaluatePattern(code).queryArc(0, picked.meta.loopBars).filter((e: any) => e.hasOnset());
    expect(events).toHaveLength(picked.tracks[0].notes.length);
    expect(events.map((e: any) => Number(e.whole.begin) * 4).sort()).toEqual(picked.tracks[0].notes.map(n => n.start).sort());
    expect(events.map((e: any) => (e.value.duration ?? Number(e.whole.end.sub(e.whole.begin))) * 4).sort()).toEqual(picked.tracks[0].notes.map(n => n.duration).sort());
  });
  it('simplifies controls and merges unison attacks only in the sketch', () => {
    const source = fixture(); source.tracks[0].notes.push({ ...note(48, 8.01), velocity: .79, pan: .432, volume: .67 });
    const picked = selectLoop(source);
    for (const track of picked.song.tracks) {
      expect(new Set(track.notes.map(n => `${n.start}:${n.pitch}`)).size).toBe(track.notes.length);
      expect(new Set(track.notes.map(n => n.velocity)).size).toBeLessThanOrEqual(2);
      expect(track.notes.every(n => n.volume === undefined && n.pan === undefined)).toBe(true);
    }
    expect(compile(source, { form: 'loop', timing: 'patterns' })).toMatch(/Notes on a \d+-step grid, each part at one level/);
    expect(compile(source, { timing: 'source' })).not.toContain('Main loop:');
  });
  it('does not invent accompaniment when only vocal parts exist', () => {
    const source = fixture(); source.tracks = source.tracks.filter(t => t.vocal);
    expect(compile(source, { form: 'loop', timing: 'patterns' }).trim()).toMatch(/\nsilence$/);
  });
  it('keeps a single drum pattern when a long sample gate crosses the loop boundary', () => {
    const source = fixture();
    source.tracks = [{ name: 'Kit', program: -1, role: 'drums', notes: Array.from({ length: 3 }, (_, i) => [note(49, i * 8, 2), note(49, i * 8 + 7.5, 2)]).flat() }];
    const code = compile(source, { form: 'loop', timing: 'patterns' });
    expect(code).not.toContain('arrange(');
    expect(code).not.toContain('.duration(');
    validatePattern(code, timeline(source, { form: 'loop' }).bars);
  });
  it('limits secondary pitched parts but keeps the bass', () => {
    const source = fixture();
    source.tracks.push(...Array.from({ length: 8 }, (_, i) => ({ ...source.tracks[1], name: `Extra ${i}` })));
    const picked = selectLoop(source);
    expect(picked.song.tracks).toHaveLength(4);
    expect(picked.song.tracks[0].role).toBe('bass');
    expect(picked.omittedTracks).toBe(6);
  });
  it('keeps extreme source metres from becoming minute-long sketches', () => {
    const source = fixture(); source.meta.beatsPerBar = 149;
    const selected = selectLoop(source).song;
    expect(selected.meta.beatsPerBar).toBe(4);
    expect(source.meta.beatsPerBar).toBe(149);
    const loop = timeline(source, { form: 'loop' });
    expect(loop.bars * loop.secondsPerBar).toBeLessThanOrEqual(LONGEST_SECONDS);
    expect(compile(source, { form: 'loop', timing: 'patterns' })).toContain('Source metre 149/4 regrouped');
  });
  it('bounds percussion complexity while retaining kick and snare', () => {
    const source = fixture();
    source.tracks.push({ name: 'Kit', role: 'drums', program: -1, notes: Array.from({ length: 25 }, (_, b) => Array.from({ length: 20 }, (_, i) => note(35 + i, b * 4))).flat() });
    const drumNotes = selectLoop(source).song.tracks.filter(t => t.role === 'drums').flatMap(t => t.notes);
    expect(new Set(drumNotes.map(n => n.pitch)).size).toBeLessThanOrEqual(6);
    expect(drumNotes.some(n => n.pitch === 36)).toBe(true);
    expect(drumNotes.some(n => n.pitch === 38)).toBe(true);
  });
  it('selects a bounded chart chorus while keeping the full chart available', () => {
    const source = fixture(); source.tracks = []; source.meta.sources = ['mcgill'];
    source.sections = [{ label: 'verse', bars: 8, chords: [{ symbol: 'C', beats: 32 }] }, { label: 'chorus', bars: 8, chords: [{ symbol: 'F', beats: 16 }, { symbol: 'G', beats: 16 }] }];
    expect(timeline(source, { form: 'loop' }).bars).toBe(8);
    expect(timeline(source, { form: 'song' }).bars).toBe(16);
    expect(selectLoop(source).song.sections[0].chords).toEqual([{ symbol: 'F', beats: 16 }, { symbol: 'G', beats: 16 }]);
    validatePattern(compile(source, { form: 'loop' }), 8);
  });
  it('rejects invalid and non-repeating imported output in the runtime gate', () => {
    expect(() => validatePattern('silence', 2)).toThrow('No playable');
    expect(() => validatePattern('note("<c d e>")', 2)).toThrow('boundary');
    expect(() => validatePattern('note("c").gain(NaN)', 2)).toThrow('gain');
  });
  it('keeps multiline provider metadata inside comments during runtime validation', () => {
    const source = fixture(); source.meta.title = 'A title\nthrow new Error("metadata escaped")';
    source.meta.artist = 'Composer\u2028throw new Error("artist escaped")';
    source.meta.remarks = ['Transcription provider: test\nthrow new Error("remark escaped")'];
    validatePattern(compile(source, { form: 'loop', timing: 'patterns' }), timeline(source, { form: 'loop' }).bars);
  });
  it('automatically generates a small, executable Teen Spirit loop', async () => {
    const manifest = JSON.parse(fs.readFileSync(new URL('../../data/curated/manifest.json', import.meta.url), 'utf8'));
    const entry = manifest.entries.find((e: any) => e.file === 'smells-like-teen-spirit.mid');
    const data = fs.readFileSync(new URL('../../data/curated/smells-like-teen-spirit.mid', import.meta.url));
    const source = await loadSong({ ...entry, title: 'Test', artist: 'Test', sources: ['midi'], files: { midi: 'test.mid' } }, async () => data);
    const opts = { form: 'loop', timing: 'patterns' } as const, code = compile(source, opts);
    expect(code.length).toBeLessThan(4000);
    expect(code.split('\n').length).toBeLessThan(80);
    expect(timeline(source, opts).bars).toBe(8);
    expect(code).not.toMatch(/timecat\(|pure\(/);
    validatePattern(code, timeline(source, opts).bars);
  });
});
