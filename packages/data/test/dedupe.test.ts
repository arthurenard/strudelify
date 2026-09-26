import { describe, it, expect } from 'vitest';
import { artistKey, better, duplicateGroups, mergeGroup, type Merit } from '../src/dedupe.js';
import type { IndexEntry } from '@strudelify/core';

const e = (id: string, artist: string, title: string) => ({ id, artist, title });
const m = (id: string, over: Partial<Merit> = {}): Merit => ({ notes: true, chart: false, lakh: true, structure: 500, popularity: 1, id, ...over });

describe('one entry per song', () => {
  it('finds a song entered twice under other spellings of its artist or title, and nothing else', () => {
    const groups = duplicateGroups([
      e('bon-jovi--livin-on-a-prayer', 'Bon Jovi', "Livin' On A Prayer"), e('bon-jovi--living-on-a-prayer', 'Bon Jovi', 'Living on a Prayer'),
      e('jackson-michael--beat-it', 'Jackson Michael', 'Beat It'), e('michael-jackson--beat-it', 'Michael Jackson', 'Beat It'),
      e('pink-floyd--another-brick-in-the-wall-part-1', 'Pink Floyd', 'Another Brick in the Wall, Part 1'),
      e('pink-floyd--another-brick-in-the-wall-part-2', 'Pink Floyd', 'Another Brick in the Wall, Part 2'),
      e('queen--one-vision', 'Queen', 'One Vision'),
    ]);
    expect(groups.map((g) => g.map((x) => x.id)).sort()).toEqual([
      ['bon-jovi--livin-on-a-prayer', 'bon-jovi--living-on-a-prayer'],
      ['jackson-michael--beat-it', 'michael-jackson--beat-it'],
    ]);
    expect(artistKey('The Rolling Stones')).toBe(artistKey('Rolling Stones'));
  });
  it('keeps the transcription that follows the recording most closely, then one with a chord chart, then Lakh over a score', () => {
    const keep = (...ms: Merit[]) => [...ms].sort(better)[0].id;
    expect(keep(m('a', { match: 0.72 }), m('b', { match: 0.76 }))).toBe('b');
    expect(keep(m('checked', { match: 0.6 }), m('unchecked', { structure: 2000, chart: true }))).toBe('checked');
    expect(keep(m('plain'), m('charted', { chart: true }))).toBe('charted');
    expect(keep(m('score', { lakh: false, structure: 2000 }), m('lakh'))).toBe('lakh');
    // A chord chart alone never replaces a transcription with notes.
    expect(keep(m('chart', { notes: false, chart: true }), m('notes'))).toBe('notes');
    expect(keep(m('longer-name'), m('short'))).toBe('short');
  });
});

describe('the entry a song keeps', () => {
  const entry = (id: string, title: string, popularity: number, extra: Partial<IndexEntry> = {}): IndexEntry =>
    ({ id, title, artist: 'The Beatles', sources: ['midi'], popularity, files: { midi: `songs/${id}.mid` }, ...extra });
  it("is named after the most popular entry and plays the chosen transcription, the group's popularity added up", () => {
    const common = entry('the-beatles--eleanor-rigby', 'Eleanor Rigby', 14, { bpm: 90, key: 'A minor' });
    const matched = entry('the-beatles--elenor-rigby', 'Elenor Rigby', 1, { bpm: 136, key: 'E minor' });
    const chart: IndexEntry = { id: 'the-beatles--eleanor-rigby-chart', title: 'Eleanor Rigby', artist: 'The Beatles', year: 1966, sources: ['mcgill'], popularity: 4, files: { mcgill: 'songs/x.txt' } };
    const { named, kept } = mergeGroup([common, matched, chart], matched);
    expect(named).toBe(common);
    expect(kept).toEqual({ id: 'the-beatles--eleanor-rigby', title: 'Eleanor Rigby', artist: 'The Beatles', year: 1966, sources: ['midi', 'mcgill'], bpm: 136, key: 'E minor', popularity: 19, files: { midi: 'songs/the-beatles--elenor-rigby.mid', mcgill: 'songs/x.txt' } });
  });
  it("carries what belongs to the chosen file: a score's source, a reviewed drum kit", () => {
    const score = entry('the-animals--house', 'House of the Rising Sun', 1, { provenance: { provider: 'pdmx', url: 'https://musescore.com/score/1', license: 'cc0' }, drumKit: 'acoustic' });
    const { kept } = mergeGroup([entry('the-animals--the-house', 'The House of the Rising Sun', 7), score], score);
    expect(kept).toMatchObject({ id: 'the-animals--the-house', provenance: { provider: 'pdmx' }, drumKit: 'acoustic', files: { midi: 'songs/the-animals--house.mid' } });
  });
});
