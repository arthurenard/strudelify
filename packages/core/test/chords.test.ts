import { describe, it, expect } from 'vitest';
import { harteToStrudel, transposeSymbol, parseHarte, voicingSafe } from '../src/chords.js';

describe('harteToStrudel', () => {
  it('maps common qualities', () => {
    expect(harteToStrudel('C:maj')).toBe('C');
    expect(harteToStrudel('D:min')).toBe('Dm');
    expect(harteToStrudel('G:7')).toBe('G7');
    expect(harteToStrudel('D:min7')).toBe('Dm7');
    expect(harteToStrudel('F:maj7')).toBe('F^7');
    expect(harteToStrudel('B:hdim7')).toBe('Bm7b5');
    expect(harteToStrudel('E:5')).toBe('E5');
    expect(harteToStrudel('E:1')).toBe('E5');
    expect(harteToStrudel('Bb:maj')).toBe('Bb');
  });
  it('handles inversions and slash bass', () => {
    expect(harteToStrudel('F:maj/5')).toBe('F/C');
    expect(harteToStrudel('C:maj/3')).toBe('C/E');
    expect(harteToStrudel('A:min/b7')).toBe('Am/G');
    expect(harteToStrudel('F:maj/9')).toBe('F/G');
    expect(harteToStrudel('C:maj/1')).toBe('C');
  });
  it('folds parenthesised extensions into playable symbols', () => {
    expect(harteToStrudel('A:sus4(b7)')).toBe('A7sus4');
    expect(harteToStrudel('A:sus4(b7,9)')).toBe('A9sus4');
    expect(harteToStrudel('C:maj(9)')).toBe('Cadd9');
    expect(harteToStrudel('E:7(#9)')).toBe('E7#9');
    expect(harteToStrudel('C:maj6(9)')).toBe('C69');
    expect(harteToStrudel('A:1(b3,b7)/b7')).toBe('Am7/G');
  });
  it('returns null for no-chord tokens', () => {
    expect(harteToStrudel('N')).toBeNull();
    expect(harteToStrudel('*')).toBeNull();
    expect(harteToStrudel('&pause')).toBeNull();
    expect(parseHarte('garbage')).toBeNull();
  });
});

describe('transposeSymbol', () => {
  it('moves root and bass', () => {
    expect(transposeSymbol('C', 2)).toBe('D');
    expect(transposeSymbol('Am7/G', 3)).toBe('Cm7/A#');
    expect(transposeSymbol('Bb', 1)).toBe('B');
  });
});

describe('voicingSafe', () => {
  it('maps qualities missing from the Strudel voicing dictionary', () => {
    expect(voicingSafe('Bdim')).toBe('Bo');
    expect(voicingSafe('Ddim7')).toBe('Do7');
    expect(voicingSafe('Asus4')).toBe('Asus');
    expect(voicingSafe('A7sus4')).toBe('A7sus');
    expect(voicingSafe('A9sus4')).toBe('A9sus');
    expect(voicingSafe('CmM7')).toBe('Cm^7');
    expect(voicingSafe('Gaug7')).toBe('G7#5');
    expect(voicingSafe('Cadd11')).toBe('C');
  });
  it('leaves supported symbols alone', () => {
    for (const s of ['C', 'Am', 'G7', 'F^7', 'Dm7', 'Bm7b5', 'E5', 'Cadd9', 'C69', 'E7#9', 'Bb', 'C#m9']) expect(voicingSafe(s)).toBe(s);
  });
});
