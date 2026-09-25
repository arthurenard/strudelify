import { afterEach, describe, expect, it } from 'vitest';
import { COVERS_HEADER, COVER_SHARDS, coverCatalogue, coverInfo, coverLine, coverShard, coverShards, readCovers } from '../src/covers.js';
import { lookupArt, peekArt, useCatalogue, type ArtAdapter } from '../src/art.js';

const beatles = { art: 'https://is1-ssl.mzstatic.com/image/thumb/a/600x600cc.jpg', kind: 'track' as const, source: 'itunes', album: 'Let It\tBe', year: 1970, sourceUrl: 'https://music.apple.com/x' };

describe('the cover catalogue file', () => {
  it('writes what the chain found and reads it back, the last line of a song winning', () => {
    const text = COVERS_HEADER + coverLine('the-beatles--let-it-be', beatles) + coverLine('nobody--x', { kind: 'placeholder', art: 'data:image/svg+xml,x' })
      + coverLine('queen--x', { kind: 'artist', art: 'https://cdn-images.dzcdn.net/images/artist/abc/1000x1000.jpg', source: 'deezer-artist' })
      + coverLine('nobody--x', { kind: 'track', art: 'https://cdn-images.dzcdn.net/images/cover/def/1000x1000.jpg', source: 'deezer' });
    const covers = readCovers(text);
    expect(covers.get('the-beatles--let-it-be')).toEqual({ kind: 'track', source: 'itunes', art: beatles.art, album: 'Let It Be', year: 1970, url: beatles.sourceUrl });
    expect(covers.get('queen--x')?.kind).toBe('artist');
    expect(covers.get('nobody--x')).toMatchObject({ kind: 'track', source: 'deezer' }); // a retried miss replaced
    expect(coverInfo(readCovers(COVERS_HEADER + coverLine('a--b', {})).get('a--b'))).toBeNull(); // a miss shows no cover
  });
  it("files an artist's songs together and spreads score arrangements, whose ids name no artist", () => {
    expect(coverShard('the-beatles--let-it-be')).toBe(coverShard('the-beatles--hey-jude'));
    expect(new Set(['pdmx--1', 'pdmx--2', 'pdmx--3', 'pdmx--4'].map(coverShard)).size).toBeGreaterThan(1);
    const shards = coverShards(readCovers(COVERS_HEADER + coverLine('the-beatles--let-it-be', beatles) + coverLine('nobody--x', {})));
    expect(shards.size).toBe(COVER_SHARDS); // every file, empty ones included
    expect(shards.get(coverShard('the-beatles--let-it-be'))!['the-beatles--let-it-be']).toEqual(['t', beatles.art, 'Let It Be', 1970, 'itunes', beatles.sourceUrl]);
    expect(shards.get(coverShard('nobody--x'))!['nobody--x']).toEqual(['n']);
  });
});

describe('the catalogue in the app', () => {
  afterEach(() => useCatalogue(null));
  const files = coverShards(readCovers(COVERS_HEADER + coverLine('the-beatles--let-it-be', beatles) + coverLine('the-beatles--help', {})));
  const catalogueOf = (answer: (n: number) => unknown = (n) => files.get(n)) => {
    const asked: number[] = [];
    const c = coverCatalogue((n) => `/db/covers/${n}.json`, async (url) => { const n = Number(/(\d+)\.json$/.exec(url)![1]); asked.push(n); return answer(n); });
    return { c, asked };
  };
  it('reads a file once, on first need, and knows a song without a cover from one it does not know', async () => {
    const { c, asked } = catalogueOf();
    expect(c.peek('the-beatles--let-it-be')).toBeNull();
    expect(await c.get('the-beatles--let-it-be')).toMatchObject({ art: beatles.art, kind: 'track', album: 'Let It Be', year: 1970 });
    expect(c.peek('the-beatles--let-it-be')?.art).toBe(beatles.art); // now without waiting
    expect(await c.get('the-beatles--help')).toEqual({ kind: 'placeholder' });
    expect(await c.get('the-beatles--something-new')).toBeNull();
    expect(asked).toEqual([coverShard('the-beatles--let-it-be')]); // one file for the artist
  });
  it('leaves an unreadable file alone instead of asking for it at every cover', async () => {
    const { c, asked } = catalogueOf(() => { throw new Error('offline'); });
    expect(await c.get('the-beatles--let-it-be')).toBeNull();
    expect(await c.get('the-beatles--help')).toBeNull();
    expect(asked).toHaveLength(1);
  });
  it('answers a lookup before any provider is asked', async () => {
    const asked: string[] = [];
    const provider: ArtAdapter = { json: async (url) => { asked.push(url); return {}; }, imageExists: async () => false };
    useCatalogue(catalogueOf().c);
    expect(await lookupArt('the-beatles--let-it-be', 'The Beatles', 'Let It Be', { adapter: provider, supersede: false })).toMatchObject({ art: beatles.art, source: 'itunes' });
    expect(peekArt('the-beatles--let-it-be')?.art).toBe(beatles.art);
    // Resolved ahead of time with every source: nothing to find again.
    expect(await lookupArt('the-beatles--help', 'The Beatles', 'Help!', { adapter: provider, supersede: false })).toMatchObject({ kind: 'placeholder' });
    expect(asked).toEqual([]);
  });
});
