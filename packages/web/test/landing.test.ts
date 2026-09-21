import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IndexEntry } from '@strudelify/core';
import { bakeLanding, exampleCard, exampleIds, browseLabel, searchPlaceholder, pickLandingExamples, LANDING_EXAMPLE_COUNT, LANDING_EXAMPLE_POOL } from '../src/landing.js';
import { SPOTIFY_POPULAR_IDS } from '../src/popular-ids.js';
import { songTint } from '../src/tint.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(HERE, '..', 'index.html'), 'utf8');
const entry = (id: string, title: string, artist: string, year?: number): IndexEntry =>
  ({ id, title, artist, year, sources: ['midi'], files: { midi: `songs/${id}.mid` } });

describe('landing bake', () => {
  const entries = [entry('nirvana--smells-like-teen-spirit', 'Smells Like Teen Spirit', 'Nirvana', 1991), entry('steve-miller-band--the-joker', 'The Joker', 'Steve Miller Band', 1973)];
  it('bakes the song count into the CTA and the search placeholder', () => {
    const out = bakeLanding(html, Array.from({ length: 10644 }, (_, i) => entry(`s${i}`, 'T', 'A')));
    expect(out).toContain('<span id="cta-label">Browse 10,644 library entries</span>');
    expect(out).toMatch(/<input id="q"[^>]*placeholder="Search 10,644 library entries"/);
    expect(browseLabel(null)).toBe('Browse songs');
    expect(searchPlaceholder(null)).toBe('Search a song or artist');
    expect(browseLabel(0)).toBe('Browse 0 library entries');
    expect(searchPlaceholder(1)).toBe('Search 1 library entry');
  });
  it('renders each example card from its index entry, with the same tile colour the search rows use, and drops unknown ids', () => {
    const out = bakeLanding(html, entries);
    const ids = exampleIds(out);
    expect(ids).toEqual(['nirvana--smells-like-teen-spirit', 'steve-miller-band--the-joker']);
    expect(out).toContain(exampleCard(entries[0]));
    expect(out).toContain(`style="--tile:${songTint(entries[0])}"`);
    expect(out).toContain('Steve Miller Band · 1973');
    expect(out).not.toContain('james-brown--i-don-t-mind');
  });
  it('leaves the markup for the browser when there is no index', () => {
    const out = bakeLanding(html, null);
    expect(exampleIds(out)).toEqual(exampleIds(html));
    expect(out).toContain('Browse songs');
    expect(out).toContain('placeholder="Search a song or artist"');
    expect(out).toContain('class="examples pending"');
  });
  it('escapes titles in the card', () => {
    expect(exampleCard(entry('x', 'Rock & <Roll>', 'A "B"'))).toContain('Rock &amp; &lt;Roll&gt;');
  });
  it('lists example ids that exist in the database (when the database is built)', () => {
    const dbIndex = path.join(HERE, '..', '..', 'data', 'public', 'db', 'index.json');
    if (!fs.existsSync(dbIndex)) return;
    const ids = new Set((JSON.parse(fs.readFileSync(dbIndex, 'utf8')) as IndexEntry[]).map((e) => e.id));
    for (const id of exampleIds(html)) expect(ids.has(id), id).toBe(true);
  });
});

describe('landing example sample', () => {
  const popular = (id: string, title: string, artist: string) => entry(id, title, artist);
  it('is 200 unique catalogue ids', () => {
    expect(SPOTIFY_POPULAR_IDS).toHaveLength(LANDING_EXAMPLE_POOL);
    expect(new Set(SPOTIFY_POPULAR_IDS).size).toBe(LANDING_EXAMPLE_POOL);
  });
  it('samples four songs from the Spotify pool, not a more transcribed outsider', () => {
    const pool = [
      popular('the-police--every-breath-you-take', 'Every Breath You Take', 'The Police'),
      popular('queen--bohemian-rhapsody', 'Bohemian Rhapsody', 'Queen'),
      popular('nirvana--smells-like-teen-spirit', 'Smells Like Teen Spirit', 'Nirvana'),
      popular('oasis--wonderwall', 'Wonderwall', 'Oasis'),
      popular('radiohead--creep', 'Creep', 'Radiohead'),
      { ...entry('obscure--not-on-spotify', 'Obscure', 'Nobody'), popularity: 99 },
    ];
    const picks = pickLandingExamples(pool, LANDING_EXAMPLE_COUNT, () => 0.999);
    expect(picks).toHaveLength(4);
    expect(picks.map((e) => e.id)).toEqual([
      'the-police--every-breath-you-take',
      'queen--bohemian-rhapsody',
      'radiohead--creep',
      'nirvana--smells-like-teen-spirit',
    ]);
  });
  it('shuffles the pool instead of always taking the first four', () => {
    const pool = [
      popular('the-police--every-breath-you-take', 'Every Breath You Take', 'The Police'),
      popular('queen--bohemian-rhapsody', 'Bohemian Rhapsody', 'Queen'),
      popular('radiohead--creep', 'Creep', 'Radiohead'),
      popular('nirvana--smells-like-teen-spirit', 'Smells Like Teen Spirit', 'Nirvana'),
      popular('oasis--wonderwall', 'Wonderwall', 'Oasis'),
    ];
    const first = pickLandingExamples(pool, LANDING_EXAMPLE_COUNT, () => 0.999).map((e) => e.id);
    const shuffled = pickLandingExamples(pool, LANDING_EXAMPLE_COUNT, () => 0).map((e) => e.id);
    expect(first).toEqual([
      'the-police--every-breath-you-take',
      'queen--bohemian-rhapsody',
      'radiohead--creep',
      'nirvana--smells-like-teen-spirit',
    ]);
    expect(shuffled).toHaveLength(4);
    expect(new Set(shuffled).size).toBe(4);
    expect(shuffled).not.toEqual(first);
  });
  it('does not repeat a song, and falls back to catalogue popularity when the Spotify ids are absent', () => {
    const entries = [
      { ...entry('a--one', 'One', 'A'), popularity: 9 },
      { ...entry('b--two', 'Two', 'B'), popularity: 8 },
      { ...entry('c--three', 'Three', 'C'), popularity: 7 },
      { ...entry('d--four', 'Four', 'D'), popularity: 6 },
      { ...entry('e--five', 'Five', 'E'), popularity: 1 },
    ];
    const picks = pickLandingExamples(entries, LANDING_EXAMPLE_COUNT, () => 0.999);
    expect(picks.map((e) => e.id)).toEqual(['a--one', 'b--two', 'c--three', 'd--four']);
    expect(new Set(picks.map((e) => e.id)).size).toBe(4);
  });
  it('returns the whole catalogue when it is smaller than four', () => {
    const entries = [entry('a--one', 'One', 'A'), entry('b--two', 'Two', 'B')];
    expect(pickLandingExamples(entries).map((e) => e.id)).toEqual(['a--one', 'b--two']);
  });
  it('lists Spotify pool ids that exist in the database (when the database is built)', () => {
    const dbIndex = path.join(HERE, '..', '..', 'data', 'public', 'db', 'index.json');
    if (!fs.existsSync(dbIndex)) return;
    const ids = new Set((JSON.parse(fs.readFileSync(dbIndex, 'utf8')) as IndexEntry[]).map((e) => e.id));
    for (const id of SPOTIFY_POPULAR_IDS) expect(ids.has(id), id).toBe(true);
  });
});
