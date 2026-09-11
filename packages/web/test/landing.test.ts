import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IndexEntry } from '@strudelify/core';
import { bakeLanding, exampleCard, exampleIds, browseLabel, searchPlaceholder } from '../src/landing.js';
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
