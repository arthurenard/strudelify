import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { selectLoop } from '../src/loop.js';
import { compile, timeline, barRange } from '../src/strudel.js';
import { loadSong } from '../src/load.js';
import type { Song, NoteEvent } from '../src/types.js';
// @ts-expect-error Node runtime harness.
import { evaluatePattern, validatePattern } from '../../../tools/strudel-runtime.mjs';
const note = (pitch: number, start: number, duration = .5): NoteEvent => ({ pitch, start, duration, velocity: .8 });
function fixture(): Song {
  const notes = [note(72, 0), ...Array.from({ length: 4 }, (_, repeat) => [note(48, 8 + repeat * 8), note(50, 12 + repeat * 8)]).flat()];
  return { meta: { id: 'any-id', title: 'Any title', artist: 'Any artist', bpm: 120, beatsPerBar: 4, beatUnit: 4, sources: ['midi'] }, sections: [], tracks: [
    { name: 'Bass', role: 'bass', program: 33, notes },
    { name: 'Guitar', role: 'chords', program: 27, notes: notes.map(n => ({ ...n, pitch: n.pitch + 12 })) },
    { name: 'Vocal', role: 'melody', program: 53, vocal: true, notes: [note(80, 0, 40)] },
  ] };
}
describe('automatic main loops', () => {
  it('finds one repeated band passage, independent of song identity, without modifying the source', () => {
    const source = fixture(), before = structuredClone(source), picked = selectLoop(source);
    expect(picked).toMatchObject({ firstBar: 2, bars: 2, repeats: 4 });
    expect(source).toEqual(before);
    expect(picked.song.tracks.map(t => t.name)).toEqual(['Bass', 'Guitar']);
    expect(picked.song.tracks[0].notes.map(n => n.start)).toEqual([0, 4]);
    const renamed = structuredClone(source); renamed.meta.id = 'nirvana--smells-like-teen-spirit'; renamed.meta.title = 'Changed';
    expect(selectLoop(renamed).song.tracks).toEqual(picked.song.tracks);
  });
  it('retains the full selected period including trailing rests and repeats at that boundary', () => {
    const source = fixture(), opts = { form: 'loop', timing: 'patterns', maxBars: 1 } as const;
    expect(timeline(source, opts).bars).toBe(2);
    const events = evaluatePattern(compile(source, opts)).queryArc(0, 4).filter((e: any) => e.hasOnset());
    expect(events.map((e: any) => Number(e.whole.begin)).sort()).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
    expect(validatePattern(compile(source, opts), 2)).toBe(4);
    const selected = selectLoop(source).song;
    selected.tracks.forEach(t => t.notes = t.notes.filter(n => n.start >= 4));
    expect(barRange(selected)).toEqual({ firstBar: 0, nBars: 2, totalBars: 2 });
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
    expect(compile(source, { form: 'loop', timing: 'patterns' })).toContain('Simplified automatically');
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
    validatePattern(code, 2);
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
    expect(timeline(source, { form: 'loop' }).bars).toBeLessThanOrEqual(4);
    expect(compile(source, { form: 'loop', timing: 'patterns' })).toContain('Source metre 149/4 regrouped');
  });
  it('bounds percussion complexity while retaining kick and snare', () => {
    const source = fixture();
    source.tracks.push({ name: 'Kit', role: 'drums', program: -1, notes: Array.from({ length: 20 }, (_, i) => note(35 + i, 8)) });
    const drumNotes = selectLoop(source).song.tracks.filter(t => t.role === 'drums').flatMap(t => t.notes);
    expect(new Set(drumNotes.map(n => n.pitch)).size).toBeLessThanOrEqual(6);
    expect(drumNotes.some(n => n.pitch === 36)).toBe(true);
    expect(drumNotes.some(n => n.pitch === 38)).toBe(true);
  });
  it('selects a bounded chart chorus while keeping the full chart available', () => {
    const source = fixture(); source.tracks = []; source.meta.sources = ['mcgill'];
    source.sections = [{ label: 'verse', bars: 8, chords: [{ symbol: 'C', beats: 32 }] }, { label: 'chorus', bars: 8, chords: [{ symbol: 'F', beats: 16 }, { symbol: 'G', beats: 16 }] }];
    expect(timeline(source, { form: 'loop' }).bars).toBe(4);
    expect(timeline(source, { form: 'song' }).bars).toBe(16);
    expect(selectLoop(source).song.sections[0].chords).toEqual([{ symbol: 'F', beats: 16 }]);
    validatePattern(compile(source, { form: 'loop' }), 4);
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
    validatePattern(compile(source, { form: 'loop', timing: 'patterns' }), 2);
  });
  it('automatically generates a small, executable Teen Spirit loop', async () => {
    const manifest = JSON.parse(fs.readFileSync(new URL('../../data/curated/manifest.json', import.meta.url), 'utf8'));
    const entry = manifest.entries.find((e: any) => e.file === 'smells-like-teen-spirit.mid');
    const data = fs.readFileSync(new URL('../../data/curated/smells-like-teen-spirit.mid', import.meta.url));
    const source = await loadSong({ ...entry, title: 'Test', artist: 'Test', sources: ['midi'], files: { midi: 'test.mid' } }, async () => data);
    const opts = { form: 'loop', timing: 'patterns' } as const, code = compile(source, opts);
    expect(code.length).toBeLessThan(2500);
    expect(code.split('\n').length).toBeLessThan(45);
    expect(code).not.toMatch(/timecat\(|pure\(/);
    validatePattern(code, timeline(source, opts).bars);
  });
});
