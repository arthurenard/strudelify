import { describe, it, expect } from 'vitest';
import { parseMcgill } from '../src/mcgill.js';
import { compile } from '../src/strudel.js';

const SAMPLE = `# title: Test Song
# artist: Test Artist
# metre: 4/4
# tonic: C

0.0\tsilence
0.5\tA, intro, | C:maj | F:maj |, (guitar)
4.5\tB, verse, | C:maj . . G:min | F:maj . E:min . |, (voice
8.5\t| D:min G:maj | C:maj |
12.5\tC, chorus, | N | A:min7 |, x2
20.5\tsilence
21.0\tend
`;

describe('parseMcgill', () => {
  const song = parseMcgill(SAMPLE, 't1');
  it('reads the header', () => {
    expect(song.meta.title).toBe('Test Song');
    expect(song.meta.artist).toBe('Test Artist');
    expect(song.meta.beatsPerBar).toBe(4);
    expect(song.meta.tonic).toBe('C');
    expect(song.meta.mode).toBe('major');
    expect(song.meta.sources).toEqual(['mcgill']);
  });
  it('estimates the tempo from timestamps', () => {
    // 10 bars = 40 beats across 20 seconds -> 120 bpm
    expect(song.meta.bpm).toBe(120);
  });
  it('builds sections with bar counts and chord durations', () => {
    expect(song.sections.map((s) => [s.label, s.bars])).toEqual([['intro', 2], ['verse', 4], ['chorus', 4]]);
    const verse = song.sections[1];
    expect(verse.chords).toEqual([
      { symbol: 'C', beats: 3 }, { symbol: 'Gm', beats: 1 },
      { symbol: 'F', beats: 2 }, { symbol: 'Em', beats: 2 },
      { symbol: 'Dm', beats: 2 }, { symbol: 'G', beats: 2 },
      { symbol: 'C', beats: 4 },
    ]);
  });
  it('expands x2 repeats and keeps no-chord bars', () => {
    const chorus = song.sections[2];
    expect(chorus.bars).toBe(4);
    expect(chorus.chords).toEqual([
      { symbol: null, beats: 4 }, { symbol: 'Am7', beats: 4 },
      { symbol: null, beats: 4 }, { symbol: 'Am7', beats: 4 },
    ]);
  });
  it('keeps slash chords out of voicing() but in the bass line', () => {
    const slash = parseMcgill(SAMPLE.replace('| C:maj | F:maj |', '| F:maj/5 | A:min7/b7 |'), 't2');
    const code = compile(slash);
    expect(code).toContain('[2, "<F Am7>"]');
    expect(code).toContain('[2, "<c2 g2>"]');
  });
  it('converts compound-metre tempo to quarter-note bpm', () => {
    const six = parseMcgill(SAMPLE.replace('# metre: 4/4', '# metre: 6/8'), 't3');
    // 10 bars of 6 eighths in 20 s = 180 eighths/min = 90 quarter bpm; one bar = 3 quarters -> 30 bars/min
    expect(six.meta.bpm).toBe(90);
    expect(compile(six)).toContain('setcpm(30.00)');
  });
  it('compiles to an arrange() of per-bar patterns', () => {
    const code = compile(song);
    expect(code).toContain('setcpm(30.00)');
    expect(code).toContain('[2, "<C F>"]');
    expect(code).toContain('[4, "<[C@3 Gm] [F@2 Em@2] [Dm@2 G@2] C>"]');
    expect(code).toContain('[4, "<~ Am7 ~ Am7>"]');
    expect(code).toContain('chord(chords).voicing()');
    expect(code).toContain('const bassline = arrange(');
    expect(code).toContain('[2, "<c2 f2>"]');
    expect(code).toContain('note(bassline)');
    expect(code).toContain('stack(keys, bass, drums)');
  });
});
