import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  abortError,
  ACCEPT,
  ARTIST_GRACE_MS,
  artistVariants,
  createFetchAdapter,
  DEFAULT_BUDGET,
  DEFAULT_HOST_POLICY,
  GOOD_SCORE,
  deezerImage,
  HttpError,
  isTitlePrefix,
  isTributeWrap,
  itunesImage,
  lookupArt,
  normalize,
  normalizeArtist,
  pickBest,
  placeholderArt,
  prepareQuery,
  readCache,
  RequestQueue,
  resolveArt,
  scoreCandidate,
  similarity,
  stripDupSuffix,
  stripFeatured,
  stripParens,
  titleVariants,
  writeCache,
  type ArtAdapter,
  type ArtQuery,
  type ArtEvent,
  type Candidate,
} from '../src/art.js';

// ------------------------------------------------------------------ normalisation & variants
describe('normalisation', () => {
  it('unifies Pt./Part, &/and, diacritics, apostrophes and punctuation', () => {
    expect(normalize('Another Brick In the Wall, Pt. 2')).toBe('another brick in the wall part 2');
    expect(normalize('Another Brick in the Wall, Part 2')).toBe('another brick in the wall part 2');
    expect(normalize("Papa's Got a Brand New Bag")).toBe('papas got a brand new bag');
    expect(normalize('Papa’s Got a Brand New Bag')).toBe('papas got a brand new bag');
    expect(normalize('Blood, Sweat & Tears')).toBe('blood sweat and tears');
    expect(normalize('Andrà tutto bene')).toBe('andra tutto bene');
    expect(normalizeArtist('The Beatles')).toBe('beatles');
    expect(normalizeArtist('Beatles, The')).toBe('beatles');
  });

  it('strips featured artists, parentheses and duplicate-file suffixes', () => {
    expect(stripFeatured('Come mai (feat. Fiorello)')).toBe('Come mai');
    expect(stripFeatured('Diana feat. Ricky Martin')).toBe('Diana');
    expect(stripFeatured('Dancing with Myself')).toBe('Dancing with Myself');
    expect(stripParens('Hotel California (unplugged)')).toBe('Hotel California');
    expect(stripParens('Dude (Looks Like A Lady)')).toBe('Dude');
    expect(stripDupSuffix('Yesterday.1')).toBe('Yesterday');
    expect(stripDupSuffix('Yesterday (2)')).toBe('Yesterday');
    expect(stripDupSuffix('Hamlet III, Part 2')).toBe('Hamlet III, Part 2');
    expect(stripDupSuffix('Mambo No. 5')).toBe('Mambo No. 5');
  });

  it('builds title variants, cleaned first', () => {
    const v = titleVariants('Another Brick in the Wall, Part 2');
    expect(v[0]).toBe('Another Brick in the Wall, Part 2');
    expect(v).toContain('Another Brick in the Wall, Pt. 2');
    expect(v).toContain('Another Brick in the Wall (Part 2)');
    expect(titleVariants('It Must Have Been Love (live studio)')[0]).toBe('It Must Have Been Love');
    expect(titleVariants('Come mai (feat. Fiorello)')[0]).toBe('Come mai');
    expect(titleVariants('Un Emozione da Poco - Pagliaccio')).toContain('Un Emozione da Poco');
    expect(titleVariants('Yesterday.1')[0]).toBe('Yesterday');
    expect(new Set(titleVariants('Money')).size).toBe(1);
  });

  it('builds artist variants: Last First, "Last, First", "X, The", lead artist', () => {
    expect(artistVariants('Brown James')).toEqual(['Brown James', 'James Brown']);
    expect(artistVariants('Amos, Tori')[0]).toBe('Tori Amos');
    expect(artistVariants('Beatles, The')[0]).toBe('The Beatles');
    expect(artistVariants('Bill Haley & His Comets')).toContain('Bill Haley');
    expect(artistVariants('ANKA PAUL')).toContain('PAUL ANKA');
    expect(artistVariants('The Beatles')).toEqual(['The Beatles', 'Beatles']);
    expect(artistVariants('Pink Floyd')).toEqual(['Pink Floyd', 'Floyd Pink']);
    expect(artistVariants('Blood, Sweat & Tears')).toEqual(['Blood, Sweat & Tears', 'Blood']);
    expect(artistVariants('Bach Johann Sebastian')).toEqual(['Bach Johann Sebastian', 'Johann Sebastian Bach']);
    expect(artistVariants('Hooker John Lee')).toContain('John Lee Hooker');
  });

  it('similarity tolerates qualifiers and spelling drift but not different songs', () => {
    expect(similarity(normalize('Smells Like Teen Spirit'), normalize('Smells Like Teen Spirit'))).toBe(1);
    expect(similarity(normalize('See You Later Aligator'), normalize('See You Later Alligator'))).toBeGreaterThan(0.85);
    expect(similarity(normalize('Money'), normalize('Money, Money, Money'))).toBeLessThan(ACCEPT.title);
    expect(similarity(normalize('Teen Spirit'), normalize('Smells Like Teen Spirit'))).toBeLessThan(ACCEPT.title);
  });
});

// ------------------------------------------------------------------ candidate scoring
const cand = (artist: string, title: string, extra: Partial<Candidate> = {}): Candidate => ({ artist, title, art: 'https://x/600x600bb.jpg', ...extra });

describe('candidate ranking', () => {
  const q = prepareQuery({ artist: 'Nirvana', title: 'Smells Like Teen Spirit' });

  it('accepts the right song and rejects other songs and tribute acts', () => {
    expect(scoreCandidate(q, cand('Nirvana', 'Smells Like Teen Spirit', { album: 'Nevermind' })).accepted).toBe(true);
    expect(scoreCandidate(q, cand('Nirvana', 'Come As You Are')).accepted).toBe(false);
    expect(scoreCandidate(q, cand('Robyn Adele Anderson', 'Smells Like Teen Spirit')).accepted).toBe(false);
    expect(scoreCandidate(q, cand('Karaoke Hits', 'Smells Like Teen Spirit (In the Style of Nirvana)')).accepted).toBe(false);
    expect(scoreCandidate(q, cand('Tori Amos', 'Smells Like Teen Spirit')).accepted).toBe(false);
  });

  it('prefers the original studio release over live, remix and compilation versions', () => {
    const best = pickBest(q, [
      cand('Nirvana', 'Smells Like Teen Spirit (Live at The Paramount, 1991)', { album: 'Live at the Paramount', year: 2011 }),
      cand('Nirvana', 'Smells Like Teen Spirit (Butch Vig Mix)', { album: 'With the Lights Out', year: 2004 }),
      cand('Nirvana', 'Smells Like Teen Spirit', { album: 'Nirvana', year: 2002 }),
      cand('Nirvana', 'Smells Like Teen Spirit', { album: 'Nevermind', year: 1991 }),
      cand('Nirvana', 'Smells Like Teen Spirit', { album: 'Nevermind (Deluxe Edition)', year: 1991 }),
    ]);
    expect(best?.cand.album).toBe('Nevermind');
  });

  it('matches "Part 2" against "Pt. 2" and swapped "Last First" artists', () => {
    const pf = prepareQuery({ artist: 'Pink Floyd', title: 'Another Brick in the Wall, Part 2' });
    const best = pickBest(pf, [
      cand('Fee Waybill', 'Another Brick In The Wall Part 2', { album: 'Back Against The Wall - A Tribute To Pink Floyd' }),
      cand('Pink Floyd', 'Another Brick In the Wall, Pt. 2', { album: 'A Foot In the Door: The Best of Pink Floyd', year: 1979 }),
      cand('Pink Floyd', 'Another Brick In the Wall, Pt. 2', { album: 'The Wall', year: 1979 }),
      cand('Korn', 'Another Brick in the Wall (Live from Denver, 2014)'),
    ]);
    expect(best?.cand.album).toBe('The Wall');

    const jb = prepareQuery({ artist: 'Brown James', title: 'Cold Sweat' });
    expect(pickBest(jb, [cand('Megadeth', 'Cold Sweat'), cand('James Brown', 'Cold Sweat', { album: 'Get on the Good Foot' })])?.cand.artist).toBe('James Brown');
    expect(pickBest(jb, [cand('James Brown & The Famous Flames', 'Cold Sweat (Pt. 1)')])).not.toBeNull();
  });

  it('prefers the artist\'s own album over a "Various Artists" compilation of the same year', () => {
    const q4 = prepareQuery({ artist: 'Amos, Tori', title: 'Cornflake Girl' });
    const best = pickBest(q4, [
      cand('Tori Amos', 'Cornflake Girl', { album: 'Top Pop 1994', albumArtist: 'Various Artists', year: 1994 }),
      cand('Tori Amos', 'Cornflake Girl', { album: 'Under the Pink', year: 1994 }),
    ]);
    expect(best?.cand.album).toBe('Under the Pink');
  });

  it('uses the database year as a tie-breaker and ignores candidates without artwork', () => {
    const q2 = prepareQuery({ artist: 'Roxette', title: 'It Must Have Been Love (live studio)', year: 1990 });
    const best = pickBest(q2, [
      cand('Roxette', 'It Must Have Been Love', { album: 'Travelling', year: 2012 }),
      cand('Roxette', 'It Must Have Been Love', { album: 'Joyride', year: 1991 }),
      cand('Roxette', 'It Must Have Been Love', { album: 'Pretty Woman OST', year: 1990, art: undefined }),
    ]);
    expect(best?.cand.album).toBe('Joyride');
    expect(pickBest(q2, [cand('Roxette', 'It Must Have Been Love', { art: undefined })])).toBeNull();
  });

  it('does not penalise "live" when the user asked for a live take', () => {
    const q3 = prepareQuery({ artist: 'Eagles', title: 'Hotel California (live)' });
    const s = scoreCandidate(q3, cand('Eagles', 'Hotel California (Live)', { album: 'Hell Freezes Over', year: 1994 }));
    expect(s.accepted).toBe(true);
    expect(s.score).toBeGreaterThan(1.8);
  });
});

describe('image url helpers', () => {
  it('upgrades iTunes thumbnails and rejects Deezer placeholder pictures', () => {
    expect(itunesImage('https://is1-ssl.mzstatic.com/image/thumb/x/100x100bb.jpg')).toBe('https://is1-ssl.mzstatic.com/image/thumb/x/600x600cc.jpg');
    expect(deezerImage('https://cdn-images.dzcdn.net/images/artist//1000x1000-000000-80-0-0.jpg')).toBeUndefined();
    expect(deezerImage('https://cdn-images.dzcdn.net/images/cover/d3cffc9b309bd1b91fd9cc9e751c253e/1000x1000-000000-80-0-0.jpg')).toBeTruthy();
    expect(deezerImage(undefined)).toBeUndefined();
  });
});

// ------------------------------------------------------------------ request queue
function fakeClock() {
  let t = 0;
  const now = () => t;
  const sleep = async (ms: number, signal?: AbortSignal) => {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    t += ms;
  };
  return { now, sleep, get t() { return t; } };
}

describe('RequestQueue', () => {
  it('spaces requests on the same host and runs hosts independently', async () => {
    const clock = fakeClock();
    const q = new RequestQueue({ gap: 350, sleep: clock.sleep, now: clock.now, jitter: false });
    const starts: number[] = [];
    const deezer: number[] = [];
    await Promise.all([
      q.run('https://itunes.apple.com/a', async () => starts.push(clock.t)),
      q.run('https://itunes.apple.com/b', async () => starts.push(clock.t)),
      q.run('https://itunes.apple.com/c', async () => starts.push(clock.t)),
      q.run('https://api.deezer.com/x', async () => deezer.push(clock.t)),
    ]);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(350);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(350);
    expect(deezer[0]).toBe(0);
  });

  it('retries 429/403/5xx and network errors with exponential backoff, not 404', async () => {
    const clock = fakeClock();
    const q = new RequestQueue({ gap: 0, baseDelay: 1000, maxRetries: 3, sleep: clock.sleep, now: clock.now, jitter: false });
    const retries: number[] = [];
    const q2 = new RequestQueue({ gap: 0, baseDelay: 1000, maxRetries: 3, sleep: clock.sleep, now: clock.now, jitter: false, onRetry: (i) => retries.push(i.delay) });
    let n = 0;
    const v = await q2.run('https://itunes.apple.com/a', async () => {
      n++;
      if (n === 1) throw new HttpError(429, 'u');
      if (n === 2) throw new HttpError(403, 'u');
      if (n === 3) throw new TypeError('fetch failed');
      return 'ok';
    });
    expect(v).toBe('ok');
    expect(n).toBe(4);
    expect(retries).toEqual([1000, 2000, 4000]);
    let m = 0;
    await expect(q.run('https://itunes.apple.com/b', async () => { m++; throw new HttpError(404, 'u'); })).rejects.toBeInstanceOf(HttpError);
    expect(m).toBe(1);
    let k = 0;
    await expect(q.run('https://itunes.apple.com/c', async () => { k++; throw new HttpError(500, 'u'); })).rejects.toBeInstanceOf(HttpError);
    expect(k).toBe(4); // 1 + maxRetries
  });

  it('keeps the cool-down for later jobs and skips aborted jobs without consuming a slot', async () => {
    const clock = fakeClock();
    const q = new RequestQueue({ gap: 100, baseDelay: 5000, maxRetries: 1, sleep: clock.sleep, now: clock.now, jitter: false });
    let n = 0;
    const first = q.run('https://itunes.apple.com/a', async () => { if (++n === 1) throw new HttpError(429, 'u'); return clock.t; });
    const ctrl = new AbortController();
    const skipped = q.run('https://itunes.apple.com/b', async () => 'ran', ctrl.signal);
    ctrl.abort();
    const third = q.run('https://itunes.apple.com/c', async () => clock.t);
    expect(await first).toBeGreaterThanOrEqual(5000);
    await expect(skipped).rejects.toMatchObject({ name: 'AbortError' });
    expect((await third) - (await first)).toBeGreaterThanOrEqual(100);
    expect(n).toBe(2);
  });
});

// ------------------------------------------------------------------ resolution chain with a fake adapter
type Routes = Record<string, unknown | (() => unknown)>;
function fakeAdapter(routes: Routes, opts: { jsonp?: boolean; images?: string[] } = {}) {
  const calls: string[] = [];
  const answer = (url: string) => {
    calls.push(url);
    for (const [k, v] of Object.entries(routes)) if (url.includes(k)) return typeof v === 'function' ? (v as () => unknown)() : v;
    return {};
  };
  const adapter: ArtAdapter = {
    json: async (url) => answer(url),
    imageExists: async (url) => {
      calls.push(url);
      return (opts.images ?? []).includes(url);
    },
  };
  if (opts.jsonp) adapter.jsonp = async (url) => answer(url);
  return { adapter, calls };
}
const itunesRow = (artistName: string, trackName: string, collectionName: string, releaseDate: string) => ({ artistName, trackName, collectionName, releaseDate, artworkUrl100: 'https://is1-ssl.mzstatic.com/x/100x100bb.jpg', trackViewUrl: 'https://music.apple.com/x' });
const deezerRow = (artist: string, title: string, album: string, hash = 'd3cffc9b309bd1b91fd9cc9e751c253e') => ({
  title,
  link: 'https://www.deezer.com/track/1',
  rank: 1000,
  artist: { name: artist, picture_xl: `https://cdn-images.dzcdn.net/images/artist/c9629ef2cc26ee5559900063aac52ffd/1000x1000.jpg` },
  album: { title: album, cover_xl: `https://cdn-images.dzcdn.net/images/cover/${hash}/1000x1000.jpg` },
});

describe('resolveArt', () => {
  it('returns iTunes track art with album, year and a 600px image', async () => {
    const { adapter, calls } = fakeAdapter({ 'itunes.apple.com': { results: [itunesRow('Nirvana', 'Smells Like Teen Spirit', 'Nevermind', '1991-09-10T12:00:00Z')] } });
    const info = await resolveArt({ artist: 'Nirvana', title: 'Smells Like Teen Spirit' }, adapter);
    expect(info).toMatchObject({ source: 'itunes', kind: 'track', album: 'Nevermind', year: 1991, art: 'https://is1-ssl.mzstatic.com/x/600x600cc.jpg' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('entity=song');
  });

  it('falls through to Deezer (via JSONP when available) when iTunes has nothing, then remembers the artist picture', async () => {
    const { adapter, calls } = fakeAdapter({ 'itunes.apple.com': { results: [] }, 'api.deezer.com/search?q': { data: [deezerRow('James Brown', 'Cold Sweat', 'Get on the Good Foot')] } }, { jsonp: true });
    const info = await resolveArt({ artist: 'Brown James', title: 'Cold Sweat' }, adapter);
    expect(info.source).toBe('deezer');
    expect(info.kind).toBe('track');
    expect(info.artistImage).toContain('/images/artist/');
    expect(calls.filter((u) => u.includes('itunes'))).toHaveLength(2); // "Brown James" and "James Brown" spellings
    expect(calls.find((u) => u.includes('deezer'))).toContain(encodeURIComponent('artist:"Brown James" track:"Cold Sweat"'));
  });

  it('never accepts a different song, then uses MusicBrainz + Cover Art Archive', async () => {
    const rg = '11111111-1111-1111-1111-111111111111';
    const rel = '22222222-2222-2222-2222-222222222222';
    const { adapter } = fakeAdapter(
      {
        'itunes.apple.com': { results: [itunesRow('Nirvana', 'Come As You Are', 'Nevermind', '1991'), itunesRow('Karaoke Kings', 'Smells Like Teen Spirit (Karaoke Version)', 'Karaoke Hits', '2010')] },
        'api.deezer.com': { data: [] },
        'musicbrainz.org': {
          recordings: [{ title: 'Smells Like Teen Spirit', 'artist-credit': [{ name: 'Nirvana' }], releases: [{ id: rel, title: 'Nevermind', date: '1991-09-24', status: 'Official', 'release-group': { id: rg, 'primary-type': 'Album', 'secondary-types': [] } }] }],
        },
      },
      { images: [`https://coverartarchive.org/release-group/${rg}/front-500`] },
    );
    const info = await resolveArt({ artist: 'Nirvana', title: 'Smells Like Teen Spirit' }, adapter);
    expect(info).toMatchObject({ source: 'musicbrainz', kind: 'track', album: 'Nevermind', year: 1991, art: `https://coverartarchive.org/release-group/${rg}/front-500` });
  });

  it('falls back to the artist picture, then to a deterministic placeholder', async () => {
    const { adapter } = fakeAdapter({
      'itunes.apple.com': { results: [] },
      'api.deezer.com/search?q': { data: [] },
      'musicbrainz.org': { recordings: [] },
      'api.deezer.com/search/artist': { data: [{ name: 'Pink Floyd', nb_fan: 100, link: 'https://www.deezer.com/artist/1', picture_xl: 'https://cdn-images.dzcdn.net/images/artist/d62a818a5de6455f17b6a992cf22b32f/1000x1000.jpg' }, { name: 'The Australian Pink Floyd Show', nb_fan: 5, picture_xl: 'https://cdn-images.dzcdn.net/images/artist/db61296781f9433b1fcefaa136ee5f43/1000x1000.jpg' }] },
    });
    const info = await resolveArt({ artist: 'Pink Floyd', title: 'Unknown Song' }, adapter);
    expect(info).toMatchObject({ source: 'deezer-artist', kind: 'artist', sourceUrl: 'https://www.deezer.com/artist/1' });
    expect(info.art).toContain('d62a818a5de6455f17b6a992cf22b32f');

    const nothing = fakeAdapter({ 'itunes.apple.com': { results: [] }, 'api.deezer.com': { data: [] }, 'musicbrainz.org': { recordings: [] } });
    const ph = await resolveArt({ artist: 'Nobody', title: 'Unknown Song' }, nothing.adapter);
    expect(ph.kind).toBe('placeholder');
    expect(ph.art).toMatch(/^data:image\/svg\+xml/);
  });

  it('survives every source throwing and honours abort', async () => {
    const boom = { adapter: { json: async () => { throw new HttpError(500, 'x'); }, imageExists: async () => { throw new TypeError('net'); } } as ArtAdapter };
    const info = await resolveArt({ artist: 'A', title: 'B' }, boom.adapter);
    expect(info.kind).toBe('placeholder');

    const ctrl = new AbortController();
    const slow: ArtAdapter = { json: async () => { ctrl.abort(); return { results: [] }; }, imageExists: async () => false };
    await expect(resolveArt({ artist: 'A', title: 'B' }, slow, { signal: ctrl.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('reports every request through onEvent', async () => {
    const { adapter } = fakeAdapter({ 'itunes.apple.com': { results: [itunesRow('Abba', 'Fernando', 'Arrival', '1976')] } });
    const events: string[] = [];
    await resolveArt({ artist: 'Abba', title: 'Fernando' }, adapter, { onEvent: (e) => events.push(`${e.source}:${e.ok}:${e.candidates}`) });
    expect(events).toEqual(['itunes-song:true:1']);
  });
});

describe('placeholderArt', () => {
  it('is deterministic per title and differs between titles', () => {
    const a = placeholderArt('Money', 'Pink Floyd');
    expect(placeholderArt('Money', 'Pink Floyd')).toEqual(a);
    expect(placeholderArt('Fernando', 'Abba').art).not.toBe(a.art);
    expect(decodeURIComponent(a.art!)).toContain('>M</text>');
    expect(decodeURIComponent(placeholderArt('...', 'x').art!)).toContain('>♪</text>');
  });
});

// ------------------------------------------------------------------ browser entry point
class MemStorage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

describe('lookupArt (cache + supersede)', () => {
  beforeEach(() => {
    (globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();
  });

  it('caches hits only, with a versioned key, and sweeps rows of older versions', async () => {
    localStorage.setItem('art:v2:old', JSON.stringify({}));
    const hit = fakeAdapter({ 'itunes.apple.com': { results: [itunesRow('Abba', 'Fernando', 'Arrival', '1976')] } });
    const info = await lookupArt('abba--fernando-t1', 'Abba', 'Fernando', { adapter: hit.adapter, supersede: false });
    expect(info.source).toBe('itunes');
    expect(localStorage.getItem('art:v2:old')).toBeNull();
    expect(JSON.parse(localStorage.getItem('art:v3:abba--fernando-t1')!)).toMatchObject({ source: 'itunes', kind: 'track' });
    expect(readCache('abba--fernando-t1')?.art).toBe(info.art);

    const miss = fakeAdapter({ 'itunes.apple.com': { results: [] }, 'api.deezer.com': { data: [] }, 'musicbrainz.org': { recordings: [] } });
    const ph = await lookupArt('nobody--x-t1', 'Nobody', 'X', { adapter: miss.adapter, supersede: false });
    expect(ph.kind).toBe('placeholder');
    expect(localStorage.getItem('art:v3:nobody--x-t1')).toBeNull();
    // a second lookup for a miss hits the network again (never cached)
    await lookupArt('nobody--x-t1', 'Nobody', 'X', { adapter: miss.adapter, supersede: false });
    expect(miss.calls.length).toBeGreaterThan(8);
  });

  it('does not write placeholder or empty rows', () => {
    writeCache('a', placeholderArt('a'));
    writeCache('b', {});
    expect(localStorage.length).toBe(0);
  });

  it('supersedes the previous in-flight lookup when the user switches song', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow: ArtAdapter = { json: async (_u, init) => { await gate; if (init?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' }); return { results: [itunesRow('Abba', 'Fernando', 'Arrival', '1976')] }; }, imageExists: async () => false };
    const first = lookupArt('abba--fernando-t2', 'Abba', 'Fernando', { adapter: slow });
    const second = lookupArt('queen--we-are-the-champions-t2', 'Queen', 'We Are The Champions', { adapter: fakeAdapter({ 'itunes.apple.com': { results: [itunesRow('Queen', 'We Are the Champions', 'News of the World', '1977')] } }).adapter });
    release();
    expect(await first).toEqual({});
    expect((await second).album).toBe('News of the World');
    expect(localStorage.getItem('art:v3:abba--fernando-t2')).toBeNull();
  });

  it('honours an external AbortSignal and dedupes concurrent lookups of the same id', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const { adapter, calls } = fakeAdapter({ 'itunes.apple.com': { results: [itunesRow('Abba', 'Fernando', 'Arrival', '1976')] } });
    expect(await lookupArt('abba--fernando-t3', 'Abba', 'Fernando', { adapter, signal: ctrl.signal, supersede: false })).toEqual({});
    const a = lookupArt('abba--fernando-t4', 'Abba', 'Fernando', { adapter, supersede: false });
    const b = lookupArt('abba--fernando-t4', 'Abba', 'Fernando', { adapter, supersede: false });
    expect(await a).toEqual(await b);
    expect(calls).toHaveLength(1);
  });
});

describe('createFetchAdapter', () => {
  it('throws HttpError on non-2xx and treats 404 image probes as missing', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'HEAD') return new Response(null, { status: url.includes('missing') ? 404 : 307, headers: { location: 'https://archive.org/x.jpg' } });
      if (url.includes('limited')) return new Response('', { status: 403 });
      return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    const clock = fakeClock();
    const adapter = createFetchAdapter({ fetch: fetchImpl, queue: new RequestQueue({ gap: 0, maxRetries: 1, baseDelay: 1, sleep: clock.sleep, now: clock.now }) });
    expect(await adapter.json('https://itunes.apple.com/search')).toEqual({ ok: 1 });
    await expect(adapter.json('https://itunes.apple.com/limited')).rejects.toMatchObject({ status: 403 });
    expect(await adapter.imageExists('https://coverartarchive.org/release/x/front-500')).toBe(true);
    expect(await adapter.imageExists('https://coverartarchive.org/release/missing/front-500')).toBe(false);
  });
});

// ------------------------------------------------------------------ wrong-release protection (critic round 1)
describe('wrong-release protection', () => {
  const q = prepareQuery({ artist: 'Fugees', title: 'Killing Me Softly' });
  const megamix = cand('Fugees', 'Killing Me Softly 情歌醉我心', { album: 'Top High Megamix Mix I (究極顛峰新連續)', rank: 900_000 });
  const theScore = cand('Fugees', 'Killing Me Softly With His Song', { album: 'The Score', rank: 800_000 });

  it('accepts the full-title studio track and ranks it above a bootleg megamix with the exact short title', () => {
    const s = scoreCandidate(q, theScore);
    expect(s.accepted).toBe(true);
    expect(s.titleSim).toBe(ACCEPT.prefixSim);
    const m = scoreCandidate(q, megamix);
    expect(m.accepted).toBe(true); // still a Fugees track – only outranked
    expect(m.score).toBeLessThan(s.score - 0.25);
    expect(pickBest(q, [megamix, theScore])?.cand.album).toBe('The Score');
    expect(pickBest(q, [theScore, megamix])?.cand.album).toBe('The Score');
  });

  it('title-prefix acceptance needs a strong artist match, ≥ 2 query words and a real prefix', () => {
    expect(isTitlePrefix(['killing me softly'], ['killing me softly with his song'])).toBe(true);
    expect(isTitlePrefix(['money'], ['money money money'])).toBe(false);
    expect(isTitlePrefix(['teen spirit'], ['smells like teen spirit'])).toBe(false);
    expect(isTitlePrefix(['killing me'], ['killing me softly with his song and then some more'])).toBe(false);
    expect(scoreCandidate(q, cand('Roberta Flack', 'Killing Me Softly With His Song')).accepted).toBe(false);
    expect(scoreCandidate(prepareQuery({ artist: 'Pink Floyd', title: 'Money' }), cand('Pink Floyd', 'Money, Money, Money')).accepted).toBe(false);
    expect(scoreCandidate(prepareQuery({ artist: 'Nirvana', title: 'Teen Spirit' }), cand('Nirvana', 'Smells Like Teen Spirit')).accepted).toBe(false);
    // an exact title from the same artist always beats the prefixed one
    expect(scoreCandidate(q, cand('Fugees', 'Killing Me Softly', { album: 'The Score' })).score).toBeGreaterThan(scoreCandidate(q, theScore).score);
  });

  it('penalises megamix / medley versions and non-Latin regional editions', () => {
    const plain = scoreCandidate(q, cand('Fugees', 'Killing Me Softly', { album: 'The Score' })).score;
    expect(scoreCandidate(q, cand('Fugees', 'Killing Me Softly (Megamix)', { album: 'The Score' })).score).toBeLessThan(plain - 0.2);
    expect(scoreCandidate(q, cand('Fugees', 'Killing Me Softly', { album: 'Dance Medley 1996' })).score).toBeLessThan(plain - 0.1);
    expect(scoreCandidate(q, cand('Fugees', 'Killing Me Softly 情歌醉我心', { album: 'The Score' })).score).toBeLessThan(plain - 0.25);
    // a query that itself carries the script is not penalised
    const jp = prepareQuery({ artist: 'Hikaru Utada', title: 'First Love 初恋' });
    expect(scoreCandidate(jp, cand('Hikaru Utada', 'First Love 初恋', { album: 'First Love' })).score).toBeGreaterThan(1.9);
  });

  it('a plain studio version outranks a demo of the same title even when the demo carries the year hint', () => {
    const pc = prepareQuery({ artist: 'Collins Phil', title: 'Against All Odds', year: 1981 });
    const demo = cand('Phil Collins', 'Against All Odds (Demo)', { album: 'Face Value (Deluxe Edition)', year: 1981 });
    const studio = cand('Phil Collins', 'Against All Odds (Take a Look at Me Now)', { album: 'Against All Odds (Original Motion Picture Soundtrack)', year: 1984, albumArtist: 'Various Artists' });
    expect(pickBest(pc, [demo, studio])?.cand.title).toContain('Take a Look');
    expect(scoreCandidate(pc, demo).score).toBeLessThan(scoreCandidate(pc, studio).score - 0.1);
  });

  it('prefers the plain edition over a deluxe reissue of the same year, whatever the order', () => {
    const n = prepareQuery({ artist: 'Nirvana', title: 'Smells Like Teen Spirit' });
    const deluxe = cand('Nirvana', 'Smells Like Teen Spirit', { album: 'Nevermind (Deluxe Edition)', year: 1991 });
    const plain = cand('Nirvana', 'Smells Like Teen Spirit', { album: 'Nevermind', year: 1991 });
    expect(pickBest(n, [deluxe, plain])?.cand.album).toBe('Nevermind');
    expect(pickBest(n, [plain, deluxe])?.cand.album).toBe('Nevermind');
  });
});

// ------------------------------------------------------------------ latency under rate limiting (critic round 1)
const policyQueue = (clock: ReturnType<typeof fakeClock>) => new RequestQueue({ hostPolicy: DEFAULT_HOST_POLICY, sleep: clock.sleep, now: clock.now, jitter: false });
const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('RequestQueue per-host policy and cool-down', () => {
  it('retries iTunes once, then puts the lane on a cool-down that doubles per consecutive failure and resets on success', async () => {
    const clock = fakeClock();
    const cools: { host: string; streak: number; ms: number }[] = [];
    const q = new RequestQueue({ hostPolicy: DEFAULT_HOST_POLICY, sleep: clock.sleep, now: clock.now, jitter: false, onCooldown: (i) => cools.push({ host: i.host, streak: i.streak, ms: i.ms }) });
    let n = 0;
    await expect(q.run('https://itunes.apple.com/a', async () => { n++; throw new HttpError(403, 'u'); })).rejects.toMatchObject({ status: 403 });
    expect(n).toBe(2);
    expect(clock.t).toBe(1000);
    expect(cools).toEqual([{ host: 'itunes.apple.com', streak: 1, ms: 20_000 }]);
    expect(q.cooldown('https://itunes.apple.com/search?term=x')).toBe(20_000);
    expect(q.cooldown('https://api.deezer.com/search')).toBe(0);
    await expect(q.run('https://itunes.apple.com/b', async () => { throw new HttpError(403, 'u'); })).rejects.toBeInstanceOf(HttpError);
    expect(cools[1]).toMatchObject({ streak: 2, ms: 40_000 });
    expect(await q.run('https://itunes.apple.com/c', async () => 'ok')).toBe('ok');
    expect(q.cooldown('https://itunes.apple.com/')).toBe(0);
    await expect(q.run('https://itunes.apple.com/d', async () => { throw new HttpError(403, 'u'); })).rejects.toBeInstanceOf(HttpError);
    expect(cools[2]).toMatchObject({ streak: 1, ms: 20_000 });
  });

  it('honours hostGap for callers that only tune spacing', async () => {
    const clock = fakeClock();
    const q = new RequestQueue({ hostGap: { 'itunes.apple.com': 2000 }, sleep: clock.sleep, now: clock.now, jitter: false });
    const starts: number[] = [];
    await Promise.all([q.run('https://itunes.apple.com/a', async () => starts.push(clock.t)), q.run('https://itunes.apple.com/b', async () => starts.push(clock.t))]);
    expect(starts[1] - starts[0]).toBe(2000);
  });
});

describe('resolveArt under a rate-limited iTunes', () => {
  it('shows Deezer art within 2 s of simulated time when iTunes answers 403, and skips iTunes while it cools', async () => {
    const clock = fakeClock();
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('itunes.apple.com')) return new Response('', { status: 403 });
      if (url.includes('api.deezer.com/search?q')) return jsonRes({ data: [deezerRow('Queen', 'Bohemian Rhapsody', 'A Night at the Opera')] });
      return jsonRes({});
    }) as unknown as typeof fetch;
    const adapter = createFetchAdapter({ fetch: fetchImpl, queue: policyQueue(clock) });
    const events: ArtEvent[] = [];
    const info = await resolveArt({ artist: 'Queen', title: 'Bohemian Rhapsody' }, adapter, { now: clock.now, onEvent: (e) => events.push(e) });
    expect(info).toMatchObject({ source: 'deezer', kind: 'track', album: 'A Night at the Opera' });
    expect(clock.t).toBeLessThan(2000);
    const itunesCalls = () => fetchImpl.mock.calls.filter(([u]) => String(u).includes('itunes')).length;
    expect(itunesCalls()).toBe(2); // one retry, then the lane cools ("Queen Bohemian Rhapsody" has a single spelling)
    expect(events.filter((e) => e.source === 'itunes-song')).toHaveLength(1);

    // The next song (same queue, as in the browser) skips iTunes and goes straight to Deezer.
    fetchImpl.mockClear();
    events.length = 0;
    const t1 = clock.t;
    const again = await resolveArt({ artist: 'Queen', title: 'Bohemian Rhapsody' }, adapter, { now: clock.now, onEvent: (e) => events.push(e) });
    expect(again.source).toBe('deezer');
    expect(itunesCalls()).toBe(0);
    expect(events[0]).toMatchObject({ source: 'itunes.apple.com', skipped: true });
    expect(clock.t - t1).toBeLessThan(500);
  });

  it('returns the placeholder within budget + grace when every host fails, instead of minutes of back-off', async () => {
    const clock = fakeClock();
    const fetchImpl = vi.fn(async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    const adapter = createFetchAdapter({ fetch: fetchImpl, queue: policyQueue(clock) });
    const events: ArtEvent[] = [];
    const info = await resolveArt({ artist: 'Nobody', title: 'Nothing At All' }, adapter, { now: clock.now, onEvent: (e) => events.push(e) });
    expect(info.kind).toBe('placeholder');
    expect(clock.t).toBeLessThan(DEFAULT_BUDGET + ARTIST_GRACE_MS);
    expect(events.filter((e) => e.skipped).map((e) => e.source).sort()).toEqual(['api.deezer.com', 'itunes.apple.com']);
  });

  it('stops searching when the budget is spent and still returns the artist picture', async () => {
    const clock = fakeClock();
    const calls: string[] = [];
    const adapter: ArtAdapter = {
      json: async (url) => {
        calls.push(url);
        await clock.sleep(600);
        if (url.includes('search/artist')) return { data: [{ name: 'Pink Floyd', nb_fan: 1, picture_xl: 'https://cdn-images.dzcdn.net/images/artist/d62a818a5de6455f17b6a992cf22b32f/1000x1000.jpg' }] };
        return { results: [], data: [], recordings: [] };
      },
      imageExists: async () => false,
    };
    const info = await resolveArt({ artist: 'Pink Floyd', title: 'Unknown Song' }, adapter, { now: clock.now, budget: 1000 });
    expect(info.kind).toBe('artist');
    expect(calls.filter((u) => !u.includes('search/artist'))).toHaveLength(2);
  });

  it('treats a deadline abort as a failed source, not as the user giving up', async () => {
    const adapter: ArtAdapter = {
      json: async (url, init) => {
        await new Promise((r) => setTimeout(r, 30));
        if (init?.signal?.aborted) throw abortError();
        if (url.includes('search/artist')) return { data: [{ name: 'Pink Floyd', nb_fan: 1, picture_xl: 'https://cdn-images.dzcdn.net/images/artist/d62a818a5de6455f17b6a992cf22b32f/1000x1000.jpg' }] };
        return { results: [] };
      },
      imageExists: async () => false,
    };
    const events: ArtEvent[] = [];
    // frozen clock: the budget can only expire through the real deadline timer, i.e. while the first request is in flight
    const info = await resolveArt({ artist: 'Pink Floyd', title: 'Unknown Song' }, adapter, { budget: 1, now: () => 0, onEvent: (e) => events.push(e) });
    expect(info.kind).toBe('artist');
    expect(events[0]).toMatchObject({ ok: false, note: 'budget exhausted' });
    // while a real user abort still rejects
    const ctrl = new AbortController();
    const p = resolveArt({ artist: 'Pink Floyd', title: 'Unknown Song' }, adapter, { signal: ctrl.signal, budget: Infinity });
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('cache confidence', () => {
  beforeEach(() => {
    (globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();
  });

  it('re-validates low-confidence track hits after a week and keeps confident ones', () => {
    const old = Date.now() - 8 * 24 * 3600 * 1000;
    localStorage.setItem('art:v3:low', JSON.stringify({ art: 'https://x/a.jpg', kind: 'track', source: 'deezer', matched: { artist: 'a', title: 'b', score: 1.5 }, ts: old }));
    localStorage.setItem('art:v3:high', JSON.stringify({ art: 'https://x/b.jpg', kind: 'track', source: 'itunes', matched: { artist: 'a', title: 'b', score: 1.9 }, ts: old }));
    localStorage.setItem('art:v3:fresh', JSON.stringify({ art: 'https://x/c.jpg', kind: 'track', source: 'deezer', matched: { artist: 'a', title: 'b', score: 1.5 }, ts: Date.now() }));
    expect(readCache('low')).toBeNull();
    expect(readCache('high')?.art).toBe('https://x/b.jpg');
    expect(readCache('fresh')?.art).toBe('https://x/c.jpg');
  });
});

describe('tribute acts and box sets (browser spot-check round 2)', () => {
  it('rejects an artist that wraps ours in extra words (Celtic / Australian Pink Floyd) but keeps collaborations and suffixes', () => {
    const pf = prepareQuery({ artist: 'Pink Floyd', title: 'Another Brick in the Wall, Part 2' });
    expect(isTributeWrap(pf.artistForms, ['celtic pink floyd'])).toBe(true);
    expect(isTributeWrap(pf.artistForms, ['australian pink floyd show'])).toBe(true);
    expect(isTributeWrap(pf.artistForms, ['pink floyd'])).toBe(false);
    expect(scoreCandidate(pf, cand('Celtic Pink Floyd', 'Another Brick in the Wall (Part 2)', { album: 'Celtic Pink Floyd' })).accepted).toBe(false);
    expect(scoreCandidate(pf, cand('The Australian Pink Floyd Show', 'Another Brick in the Wall, Pt. 2 (Live)')).accepted).toBe(false);
    expect(pickBest(pf, [
      cand('Celtic Pink Floyd', 'Another Brick in the Wall (Part 2)', { album: 'Celtic Pink Floyd', rank: 900 }),
      cand('Pink Floyd', 'Another Brick In the Wall, Part 2 (2019 remix Live)', { album: 'Delicate Sound of Thunder (2019 Remix) (Live)', rank: 100 }),
    ])?.cand.artist).toBe('Pink Floyd');
    const tt = prepareQuery({ artist: 'Tina Turner', title: 'Proud Mary' });
    expect(scoreCandidate(tt, cand('Ike & Tina Turner', 'Proud Mary')).accepted).toBe(true);
    const jh = prepareQuery({ artist: 'Jimi Hendrix', title: 'Purple Haze' });
    expect(scoreCandidate(jh, cand('The Jimi Hendrix Experience', 'Purple Haze', { album: 'Are You Experienced' })).accepted).toBe(true);
    const pr = prepareQuery({ artist: 'Sheena Easton', title: 'U Got the Look' });
    expect(scoreCandidate(pr, cand('Prince with Sheena Easton', 'U Got the Look')).accepted).toBe(true);
  });

  it('prefers the original album over a multi-disc box set that keeps the original track date, and does not double-penalise "(Bonus Track Version)"', () => {
    const q = prepareQuery({ artist: 'ABBA', title: 'Dancing Queen' });
    const box = cand('ABBA', 'Dancing Queen', { album: 'Thank You For The Music', year: 1976, discCount: 4, trackCount: 66 });
    const arrival = cand('ABBA', 'Dancing Queen', { album: 'Arrival (Bonus Track Version)', year: 1976, discCount: 1, trackCount: 12 });
    const gold = cand('ABBA', 'Dancing Queen', { album: 'ABBA Gold: Greatest Hits', year: 1976, discCount: 1, trackCount: 19 });
    expect(pickBest(q, [gold, box, arrival])?.cand.album).toBe('Arrival (Bonus Track Version)');
    // a double album is not a box set: The Wall (2 discs) must beat a same-year best-of
    const pf = prepareQuery({ artist: 'Pink Floyd', title: 'Another Brick in the Wall, Part 2' });
    expect(pickBest(pf, [
      cand('Pink Floyd', 'Another Brick In the Wall, Pt. 2', { album: 'A Foot In the Door: The Best of Pink Floyd', year: 1979, discCount: 1, trackCount: 16 }),
      cand('Pink Floyd', 'Another Brick In the Wall, Pt. 2', { album: 'The Wall', year: 1979, discCount: 2, trackCount: 13 }),
    ])?.cand.album).toBe('The Wall');
    expect(scoreCandidate(q, arrival).score).toBeGreaterThan(scoreCandidate(q, cand('ABBA', 'Dancing Queen (Live)', { album: 'Arrival', year: 1976 })).score);
    expect(scoreCandidate(q, cand('ABBA', 'Dancing Queen', { album: 'Arrival', year: 1976 })).score).toBeGreaterThan(scoreCandidate(q, arrival).score);
  });
});

describe('low-confidence hits keep the search going', () => {
  it('keeps searching past a live/remix take and returns the studio release from the next source', async () => {
    const { adapter, calls } = fakeAdapter(
      {
        'itunes.apple.com': { results: [itunesRow('Pink Floyd', 'Another Brick In the Wall, Part 2 (2019 remix Live)', 'Delicate Sound of Thunder (2019 Remix) (Live)', '2020')] },
        'api.deezer.com/search?q': { data: [deezerRow('Pink Floyd', 'Another Brick In the Wall, Pt. 2', 'The Wall')] },
      },
      { jsonp: true },
    );
    const info = await resolveArt({ artist: 'Pink Floyd', title: 'Another Brick in the Wall, Part 2' }, adapter);
    expect(info).toMatchObject({ source: 'deezer', album: 'The Wall' });
    expect(info.matched!.score).toBeGreaterThanOrEqual(GOOD_SCORE);
    expect(calls.some((u) => u.includes('deezer'))).toBe(true);
  });

  it('gives MusicBrainz its turn before settling for a live take, and still returns the live take when MusicBrainz has nothing', async () => {
    const { adapter, calls } = fakeAdapter({
      'itunes.apple.com': { results: [itunesRow('Pink Floyd', 'Another Brick In the Wall, Part 2 (Live)', 'Pulse', '1995')] },
      'api.deezer.com': { data: [] },
      'musicbrainz.org': { recordings: [] },
    });
    const info = await resolveArt({ artist: 'Pink Floyd', title: 'Another Brick in the Wall, Part 2' }, adapter);
    expect(info).toMatchObject({ source: 'itunes', kind: 'track', album: 'Pulse' });
    expect(info.matched!.score).toBeLessThan(GOOD_SCORE);
    expect(calls.some((u) => u.includes('musicbrainz'))).toBe(true);
  });

  it('returns a studio take on a compilation without a MusicBrainz round trip', async () => {
    const { adapter, calls } = fakeAdapter({
      'itunes.apple.com': { results: [itunesRow('Queen', 'We Are The Champions', 'Greatest Hits', '1981')] },
      'api.deezer.com': { data: [] },
      'musicbrainz.org': { recordings: [] },
    });
    const info = await resolveArt({ artist: 'Queen', title: 'We Are The Champions' }, adapter);
    expect(info).toMatchObject({ source: 'itunes', kind: 'track', album: 'Greatest Hits' });
    expect(calls.some((u) => u.includes('musicbrainz'))).toBe(false);
  });

  it('uses MusicBrainz + Cover Art Archive when the only Deezer take is a live remix (iTunes rate-limited)', async () => {
    const rg = '33333333-3333-3333-3333-333333333333';
    const rel = '44444444-4444-4444-4444-444444444444';
    const { adapter } = fakeAdapter(
      {
        'itunes.apple.com': () => { throw new HttpError(403, 'itunes'); },
        'api.deezer.com/search?q': { data: [deezerRow('Pink Floyd', 'Another Brick In the Wall, Part 2 (2019 remix Live)', 'Delicate Sound of Thunder (2019 Remix) (Live)')] },
        'musicbrainz.org': {
          recordings: [{ title: 'Another Brick in the Wall, Part 2', 'artist-credit': [{ name: 'Pink Floyd' }], releases: [{ id: rel, title: 'The Wall', date: '1979-11-30', status: 'Official', 'release-group': { id: rg, 'primary-type': 'Album', 'secondary-types': [] } }] }],
        },
      },
      { images: [`https://coverartarchive.org/release-group/${rg}/front-500`] },
    );
    const info = await resolveArt({ artist: 'Pink Floyd', title: 'Another Brick in the Wall, Part 2', year: 1979 }, adapter);
    expect(info).toMatchObject({ source: 'musicbrainz', kind: 'track', album: 'The Wall', year: 1979 });
  });
});

describe('queue wait accounting and single/remake nudges', () => {
  it('reports the lane wait of every attempt through onStart', async () => {
    const clock = fakeClock();
    const starts: { url: string; waited: number; attempt: number }[] = [];
    const q = new RequestQueue({ gap: 100, baseDelay: 500, maxRetries: 1, sleep: clock.sleep, now: clock.now, jitter: false, onStart: (i) => starts.push({ url: i.url, waited: i.waited, attempt: i.attempt }) });
    await q.run('https://itunes.apple.com/a', async () => 1);
    let n = 0;
    await q.run('https://itunes.apple.com/b', async () => { if (++n === 1) throw new HttpError(429, 'u'); return 2; });
    expect(starts).toEqual([
      { url: 'https://itunes.apple.com/a', waited: 0, attempt: 0 },
      { url: 'https://itunes.apple.com/b', waited: 100, attempt: 0 }, // spacing
      { url: 'https://itunes.apple.com/b', waited: 500, attempt: 1 }, // back-off
    ]);
  });

  it('nudges album versions above singles and remakes', () => {
    const q = prepareQuery({ artist: 'Roxette', title: 'The Look' });
    const album = cand('Roxette', 'The Look', { album: 'Look Sharp!', year: 1988 });
    const remake = cand('Roxette', 'The Look (2015 Remake)', { album: 'The Look (2015 Remake) - Single', year: 1989 });
    expect(pickBest(q, [remake, album])?.cand.album).toBe('Look Sharp!');
    expect(scoreCandidate(q, remake).score).toBeLessThan(GOOD_SCORE);
    const g = prepareQuery({ artist: 'Genesis', title: 'Invisible Touch' });
    expect(pickBest(g, [cand('Genesis', 'Invisible Touch', { album: 'Invisible Touch / The Last Domino [Digital 45]', year: 1986 }), cand('Genesis', 'Invisible Touch', { album: 'Invisible Touch', year: 1986 })])?.cand.album).toBe('Invisible Touch');
  });
});

describe('request timeout does not rely on abort propagation', () => {
  it('rejects a fetch that ignores its abort signal once the timeout fires, and the queue retries it', async () => {
    let calls = 0;
    const stuck = vi.fn(async () => {
      calls++;
      if (calls === 1) return new Promise<Response>(() => {}); // never settles, never observes the signal
      return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    const clock = fakeClock();
    const adapter = createFetchAdapter({ fetch: stuck, timeout: 20, queue: new RequestQueue({ gap: 0, maxRetries: 1, baseDelay: 1, sleep: clock.sleep, now: clock.now }) });
    expect(await adapter.json('https://itunes.apple.com/search')).toEqual({ ok: 1 });
    expect(calls).toBe(2);
    const dead = createFetchAdapter({ fetch: (async () => new Promise<Response>(() => {})) as unknown as typeof fetch, timeout: 20, queue: new RequestQueue({ gap: 0, maxRetries: 0, sleep: clock.sleep, now: clock.now }) });
    await expect(dead.json('https://itunes.apple.com/search')).rejects.toThrow(/timeout after 20ms/);
    await expect(dead.imageExists('https://coverartarchive.org/release/x/front-500')).rejects.toThrow(/timeout/);
  });
});

describe('Deezer candidates without years: popularity rank and bootleg markers', () => {
  it('prefers the popular studio track over a bootleg / obscure live release with the same score', () => {
    const ccr = prepareQuery({ artist: 'Creedence Clearwater Revival', title: 'Suzie Q' });
    expect(pickBest(ccr, [
      cand('Creedence Clearwater Revival', 'Suzie Q', { album: 'Transmission Impossible', rank: 51_571 }),
      cand('Creedence Clearwater Revival', 'Suzie Q', { album: 'Creedence Clearwater Revival (Expanded Edition)', rank: 579_196 }),
      cand('Creedence Clearwater Revival', 'Suzie Q (Live At The Woodstock Music & Art Fair / 1969)', { album: 'Live At Woodstock', rank: 241_473 }),
    ])?.cand.album).toBe('Creedence Clearwater Revival (Expanded Edition)');
    const eagles = prepareQuery({ artist: 'Eagles', title: "Lyin' Eyes" });
    expect(pickBest(eagles, [
      cand('Eagles', 'Lyin’ Eyes', { album: 'Sayonara Japan', rank: 1460 }),
      cand('Eagles', "Lyin' Eyes (2013 Remaster)", { album: 'Their Greatest Hits 1971-1975 (2013 Remaster)', rank: 290_826 }),
      cand('Eagles', "Lyin' Eyes (Live, Nagoya 1976)", { album: 'Nagoya Assembley Hall, Nagoya, Japan – 9th Feb 1976 (Live from Japan)', rank: 521 }),
    ])?.cand.album).toContain('Greatest Hits');
    // without ranks (iTunes) nothing changes
    expect(scoreCandidate(ccr, cand('Creedence Clearwater Revival', 'Suzie Q', { album: 'Transmission Impossible' })).score).toBeCloseTo(2 - 0.35, 5);
  });

  it('flags outtakes, home recordings and "Month YYYY" concert albums', () => {
    const q = prepareQuery({ artist: 'Elvis Presley', title: 'Are You Lonesome Tonight' });
    const plain = scoreCandidate(q, cand('Elvis Presley', 'Are You Lonesome Tonight?', { album: 'Elvis Is Back!' })).score;
    expect(scoreCandidate(q, cand('Elvis Presley', 'Are You Lonesome Tonight? (Takes 1,2)', { album: 'Elvis Is Back!' })).score).toBeLessThan(plain - 0.4);
    expect(scoreCandidate(q, cand('Elvis Presley', 'Are You Lonesome Tonight? (Home Recording)', { album: 'Made in Germany (Private Recordings)' })).score).toBeLessThan(plain - 0.4);
    expect(scoreCandidate(q, cand('Elvis Presley', 'Are You Lonesome Tonight (International Hotel August 1969)', { album: 'Las Vegas August 1969' })).score).toBeLessThan(plain - 0.3);
    expect(scoreCandidate(q, cand('Elvis Presley', 'Are You Lonesome Tonight', { album: 'The Civic Auditorium - 29th July 1980' })).score).toBeLessThan(plain - 0.3);
    // "May" is deliberately not a month marker, and a plain year is not a concert
    expect(scoreCandidate(q, cand('Elvis Presley', 'Are You Lonesome Tonight', { album: 'Elvis 1960' })).score).toBe(plain);
  });
});

describe('tribute albums behind a strong title match', () => {
  it('rejects "salute to" / "plays the music of" albums while keeping the weak-artist path for "Zero" → "Renato Zero"', () => {
    const pf = prepareQuery({ artist: 'Pink Floyd', title: 'Another Brick in the Wall, Part 2' });
    const trib = scoreCandidate(pf, cand('Feeling Floyd', 'Another Brick In The Wall, Part 2', { album: 'Chilled Pink - A Chill Out Salute To Pink Floyd', rank: 5000 }));
    expect(trib.score).toBeLessThan(0.5);
    expect(pickBest(pf, [
      cand('Feeling Floyd', 'Another Brick In The Wall, Part 2', { album: 'Chilled Pink - A Chill Out Salute To Pink Floyd', rank: 5000 }),
      cand('Pink Floyd', 'Another Brick In the Wall, Part 2 (2019 remix Live)', { album: 'Delicate Sound of Thunder (2019 Remix) (Live)', rank: 100_000 }),
    ])?.cand.artist).toBe('Pink Floyd');
    expect(scoreCandidate(pf, cand('The Royal Philharmonic Orchestra', 'Another Brick in the Wall', { album: 'Plays the Music of Pink Floyd' })).score).toBeLessThan(0.5);
    const zero = prepareQuery({ artist: 'Zero', title: 'Dimmi chi dorme accanto a me' });
    const rz = scoreCandidate(zero, cand('Renato Zero', 'Dimmi chi dorme accanto a me', { album: 'Segreto Amore' }));
    expect(rz.accepted).toBe(true);
    expect(rz.score).toBeLessThan(GOOD_SCORE); // a weak artist match is only ever a fallback
  });
});

// ------------------------------------------------------------------ real Deezer payloads, iTunes rate-limited (critic round 1)
import deezerSearchFixture from './fixtures/deezer-search.json';
import deezerAlbumFixture from './fixtures/deezer-albums.json';
import { enrichDeezer, isArtistRelated, MAX_DEEZER_ALBUM_LOOKUPS } from '../src/art.js';
import { albumLine } from '../src/ui.js';

type DeezerSearch = Record<string, { data: unknown[] }>;
const dzSearch = deezerSearchFixture as unknown as DeezerSearch;
const dzAlbums = deezerAlbumFixture as unknown as Record<string, { id: number }>;

/** Deezer as it answered on 2026-09-04 (fixtures), iTunes answering 403, MusicBrainz empty. */
function deezerWorld(pick: (q: string) => string | undefined) {
  const calls: string[] = [];
  const adapter: ArtAdapter = {
    json: async (url) => {
      calls.push(url);
      if (url.includes('itunes.apple.com')) throw new HttpError(403, url);
      if (url.includes('musicbrainz.org')) return { recordings: [] };
      const m = url.match(/api\.deezer\.com\/album\/(\d+)/);
      if (m) return dzAlbums[m[1]] ?? { error: { message: 'no data' } };
      if (url.includes('api.deezer.com/search/artist')) return { data: [] };
      if (url.includes('api.deezer.com/search?q=')) {
        const q = decodeURIComponent(new URL(url).searchParams.get('q') ?? '');
        const key = pick(q);
        return key ? dzSearch[key] : { data: [] };
      }
      return {};
    },
    imageExists: async () => false,
  };
  return { adapter, calls };
}
const byArtist = (strictKey: string, plainKey = strictKey) => (q: string) => (q.startsWith('artist:') ? strictKey : plainKey);

describe('Deezer fallback picks the canonical release (real payloads, iTunes 403)', () => {
  it('Queen — Bohemian Rhapsody: A Night at the Opera, not the Queen + The Muppets single', async () => {
    const { adapter, calls } = deezerWorld(byArtist('queen--bohemian-rhapsody'));
    const info = await resolveArt({ artist: 'Queen', title: 'Bohemian Rhapsody', year: 1975 }, adapter);
    expect(info).toMatchObject({ source: 'deezer', kind: 'track', album: 'A Night At The Opera' });
    expect(info.matched!.score).toBeGreaterThanOrEqual(GOOD_SCORE);
    expect(info.year).toBeUndefined(); // Deezer dates the digital edition 2005: not reported as the release year
    expect(albumLine(info, { year: 1975 })).toBe('1975 · A Night At The Opera');
    const albumLookups = calls.filter((u) => /api\.deezer\.com\/album\//.test(u));
    expect(albumLookups.length).toBeLessThanOrEqual(MAX_DEEZER_ALBUM_LOOKUPS);
    expect(albumLookups.some((u) => u.endsWith('/1007321681'))).toBe(true); // the album we picked was checked
  });

  it('Pink Floyd — Another Brick in the Wall, Part 2: The Wall through Deezer\'s "Pt. 2" spelling, not the 2019 live remix', async () => {
    const { adapter, calls } = deezerWorld((q) => (/Pt\. 2/.test(q) ? 'pink-floyd--part-2--pt' : q.startsWith('artist:') ? 'pink-floyd--part-2--strict' : 'pink-floyd--part-2--plain'));
    const info = await resolveArt({ artist: 'Pink Floyd', title: 'Another Brick in the Wall, Part 2', year: 1979 }, adapter);
    expect(info).toMatchObject({ source: 'deezer', kind: 'track', album: 'The Wall' });
    expect(info.matched!.title).toBe('Another Brick in the Wall, Pt. 2');
    expect(info.matched!.score).toBeGreaterThanOrEqual(GOOD_SCORE);
    expect(calls.some((u) => decodeURIComponent(u).includes('track:"Another Brick in the Wall, Pt. 2"'))).toBe(true);
  });

  it('Queen — We Are The Champions: the band\'s Greatest Hits, not the "Rock In Rio" bootleg', async () => {
    const { adapter } = deezerWorld(byArtist('queen--we-are-the-champions'));
    const info = await resolveArt({ artist: 'Queen', title: 'We Are The Champions', year: 1977 }, adapter);
    expect(info).toMatchObject({ source: 'deezer', album: 'Greatest Hits' });
  });

  it('Bread — If: The Best of Bread (21,696 fans) over the 2023 "Guitar Man" re-upload (64 fans)', async () => {
    const { adapter } = deezerWorld(byArtist('bread--if'));
    const info = await resolveArt({ artist: 'Bread', title: 'If', year: 1971 }, adapter);
    expect(info).toMatchObject({ source: 'deezer', album: 'The Best of Bread' });
  });

  it('Bangles — Eternal Flame: the album Everything (with its 1988 date), not the acoustic single', async () => {
    const { adapter } = deezerWorld(byArtist('bangles--eternal-flame'));
    const info = await resolveArt({ artist: 'Bangles', title: 'Eternal Flame', year: 1988 }, adapter);
    expect(info).toMatchObject({ source: 'deezer', album: 'Everything', year: 1988 });
  });

  it('Bruce Hornsby — The Way It Is: his own release, not a Various Artists compilation', async () => {
    const { adapter } = deezerWorld(byArtist('bruce-hornsby--the-way-it-is'));
    const info = await resolveArt({ artist: 'Bruce Hornsby', title: 'The Way It Is', year: 1986 }, adapter);
    expect(info.source).toBe('deezer');
    expect(info.album).not.toMatch(/Pure|Entertainment/);
    expect(info.matched!.artist).toMatch(/^Bruce Hornsby/);
  });

  it('The Beach Boys — Good Vibrations: not the Royal Philharmonic re-recording nor the Smile Sessions outtakes', async () => {
    const { adapter } = deezerWorld(byArtist('the-beach-boys--good-vibrations'));
    const info = await resolveArt({ artist: 'The Beach Boys', title: 'Good Vibrations', year: 1966 }, adapter);
    expect(info.source).toBe('deezer');
    expect(info.album).not.toMatch(/Philharmonic|Sessions/);
    expect(info.matched!.title).toMatch(/^Good Vibrations/);
  });

  it('ABBA — Dancing Queen: ABBA\'s own release, never a tribute act', async () => {
    const { adapter } = deezerWorld(byArtist('abba--dancing-queen'));
    const info = await resolveArt({ artist: 'ABBA', title: 'Dancing Queen', year: 1976 }, adapter);
    expect(info).toMatchObject({ source: 'deezer', album: 'ABBA Gold' });
    expect(info.matched!.artist).toBe('ABBA');
  });

  it('looks up at most three releases per response and reuses them across the queries of one lookup', async () => {
    const { adapter, calls } = deezerWorld(byArtist('queen--bohemian-rhapsody'));
    await resolveArt({ artist: 'Queen', title: 'Bohemian Rhapsody', year: 1975 }, { ...adapter, json: async (url) => (url.includes('/search?q=') ? { data: [...(dzSearch['queen--bohemian-rhapsody'].data as unknown[])] } : adapter.json(url)) });
    const q = prepareQuery({ artist: 'Queen', title: 'Bohemian Rhapsody', year: 1975 });
    const cache = new Map();
    const rows = (dzSearch['queen--bohemian-rhapsody'].data as Record<string, unknown>[]).map((r) => {
      const album = r.album as Record<string, unknown>;
      const artist = r.artist as Record<string, unknown>;
      return { artist: String(artist.name), title: String(r.title), album: String(album.title), albumId: String(album.id), art: deezerImage(album.cover_xl), rank: r.rank as number };
    });
    const { adapter: a2, calls: c2 } = deezerWorld(() => undefined);
    await enrichDeezer(q, rows, a2, {}, cache);
    await enrichDeezer(q, rows, a2, {}, cache);
    expect(c2.filter((u) => u.includes('/album/')).length).toBe(MAX_DEEZER_ALBUM_LOOKUPS);
    const opera = rows.find((r) => r.album === 'A Night At The Opera')!;
    expect(opera).toMatchObject({ recordType: 'album', trackCount: 12, yearKind: 'digital', year: 2005, albumArtist: 'Queen' });
    const muppets = rows.find((r) => r.albumId === '463031')!;
    expect(muppets).toMatchObject({ recordType: 'single', trackCount: 1, albumArtist: 'Queen + The Muppets' });
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe('weak-artist acceptance needs a related name, not a shared word', () => {
  it('rejects Taylor Swift for "Taylor James", Ziggy for Bob Marley, Jackson Browne for Michael Jackson, "Genesis Orchestra"', () => {
    const forms = (s: string) => [normalizeArtist(s)];
    expect(isArtistRelated(forms('Taylor James'), forms('Taylor Swift'))).toBe(false);
    expect(isArtistRelated(forms('Bob Marley'), forms('Ziggy Marley'))).toBe(false);
    expect(isArtistRelated(forms('Michael Jackson'), forms('Jackson Browne'))).toBe(false);
    expect(isArtistRelated(forms('Genesis'), forms('Genesis Orchestra'))).toBe(false);
    expect(isArtistRelated(forms('Abba'), forms('Abba Stars'))).toBe(false);
    expect(isArtistRelated(forms('Zero'), forms('Renato Zero'))).toBe(true);
    expect(isArtistRelated(forms('Paul Simon'), ['simon and garfunkel', 'simon'])).toBe(true);
    expect(isArtistRelated(forms('Tina Turner'), forms('Ike & Tina Turner'))).toBe(true);
    const tj = prepareQuery({ artist: 'Taylor James', title: 'Never Die Young' });
    expect(scoreCandidate(tj, cand('Taylor Swift', 'Never Die Young', { album: 'x' })).accepted).toBe(false);
    expect(scoreCandidate(tj, cand('James Taylor', 'Never Die Young', { album: 'Never Die Young' })).accepted).toBe(true);
    const bm = prepareQuery({ artist: 'Bob Marley', title: 'Is This Love' });
    expect(scoreCandidate(bm, cand('Ziggy Marley', 'Is This Love', { album: 'x' })).accepted).toBe(false);
    expect(scoreCandidate(bm, cand('Bob Marley & The Wailers', 'Is This Love', { album: 'Kaya' })).accepted).toBe(true);
  });
});

describe('release signals from Deezer album details', () => {
  it('grants the title-track bonus only to a release known to be an album, and treats singles/EPs/compilations by type', () => {
    const q = prepareQuery({ artist: 'Queen', title: 'Bohemian Rhapsody' });
    const unknown = scoreCandidate(q, cand('Queen', 'Bohemian Rhapsody', { album: 'Bohemian Rhapsody' })).score;
    const album = scoreCandidate(q, cand('Queen', 'Bohemian Rhapsody', { album: 'Bohemian Rhapsody', trackCount: 12 })).score;
    const single = scoreCandidate(q, cand('Queen', 'Bohemian Rhapsody', { album: 'Bohemian Rhapsody', recordType: 'single' })).score;
    const comp = scoreCandidate(q, cand('Queen', 'Bohemian Rhapsody', { album: 'Queen Forever', recordType: 'compile' })).score;
    const plain = scoreCandidate(q, cand('Queen', 'Bohemian Rhapsody', { album: 'A Night at the Opera' })).score;
    expect(unknown).toBe(plain);
    expect(album).toBeCloseTo(plain + 0.05, 5);
    expect(single).toBeCloseTo(plain - 0.05, 5);
    expect(comp).toBeCloseTo(plain - 0.12, 5);
  });

  it('uses a digital-edition date only as a year match or a re-upload marker, never as release order', () => {
    const q = prepareQuery({ artist: 'Queen', title: 'Bohemian Rhapsody', year: 1975 });
    const plain = scoreCandidate(q, cand('Queen', 'Bohemian Rhapsody', { album: 'A Night at the Opera' })).score;
    expect(scoreCandidate(q, cand('Queen', 'Bohemian Rhapsody', { album: 'A Night at the Opera', year: 2005, yearKind: 'digital' })).score).toBe(plain);
    expect(scoreCandidate(q, cand('Queen', 'Bohemian Rhapsody', { album: 'A Night at the Opera', year: 1975, yearKind: 'digital' })).score).toBeCloseTo(plain + 0.1, 5);
    expect(scoreCandidate(q, cand('Queen', 'Bohemian Rhapsody', { album: 'Sun City 1984', year: 2025, yearKind: 'digital' })).score).toBeCloseTo(plain - 0.08, 5);
    // a real release date keeps ordering the candidates
    expect(pickBest(q, [cand('Queen', 'Bohemian Rhapsody', { album: 'Greatest Hits', year: 1981 }), cand('Queen', 'Bohemian Rhapsody', { album: 'A Night at the Opera', year: 1975 })])?.cand.album).toBe('A Night at the Opera');
    // the digital year of a release is not what makes minYear
    expect(pickBest(q, [cand('Queen', 'Bohemian Rhapsody', { album: 'A Night at the Opera', year: 2005, yearKind: 'digital', rank: 900 }), cand('Queen', 'Bohemian Rhapsody', { album: 'Bohemian Rhapsody', year: 2009, yearKind: 'digital', recordType: 'single', rank: 350 })])?.cand.album).toBe('A Night at the Opera');
  });

  it('penalises a release nobody follows next to a popular one, and flags orchestral / stadium releases', () => {
    const q = prepareQuery({ artist: 'Bread', title: 'If', year: 1971 });
    const best = pickBest(q, [
      cand('Bread', 'If', { album: 'The Best of Bread', albumId: '1', rank: 562_434, fans: 21_696, trackCount: 20, year: 1973, yearKind: 'digital' }),
      cand('Bread', 'If', { album: 'Guitar Man', albumId: '2', rank: 189_838, fans: 64, trackCount: 16, year: 2023, yearKind: 'digital' }),
    ]);
    expect(best?.cand.album).toBe('The Best of Bread');
    const bb = prepareQuery({ artist: 'The Beach Boys', title: 'Good Vibrations' });
    const studio = scoreCandidate(bb, cand('The Beach Boys', 'Good Vibrations', { album: 'Smiley Smile' })).score;
    expect(scoreCandidate(bb, cand('The Beach Boys', 'Good Vibrations', { album: 'The Beach Boys With The Royal Philharmonic Orchestra' })).score).toBeLessThan(studio - 0.1);
    const queen = prepareQuery({ artist: 'Queen', title: 'We Are The Champions' });
    const news = scoreCandidate(queen, cand('Queen', 'We Are The Champions', { album: 'News of the World' })).score;
    expect(scoreCandidate(queen, cand('Queen', 'We Are The Champions', { album: 'Rock In Rio' })).score).toBeLessThan(news - 0.3);
    expect(scoreCandidate(queen, cand('Queen', 'We Are The Champions', { album: 'Live at Wembley Stadium' })).score).toBeLessThan(news - 0.3);
  });
});

describe('a good compilation hit buys one extra query of the same source', () => {
  it('The Bangles — Eternal Flame: "The Bangles" strict finds a compilation, "Bangles" strict finds Everything', async () => {
    const { adapter, calls } = deezerWorld((q) => (q.startsWith('artist:"The Bangles"') ? 'the-bangles--eternal-flame' : q.startsWith('artist:"Bangles"') ? 'bangles--eternal-flame' : undefined));
    const info = await resolveArt({ artist: 'The Bangles', title: 'Eternal Flame' }, adapter);
    expect(info).toMatchObject({ source: 'deezer', album: 'Everything', year: 1988 });
    const searches = calls.filter((u) => u.includes('/search?q=')).map((u) => decodeURIComponent(new URL(u).searchParams.get('q') ?? ''));
    expect(searches).toEqual(['artist:"The Bangles" track:"Eternal Flame"', 'artist:"Bangles" track:"Eternal Flame"']);
  });

  it('iTunes: one more spelling after a compilation hit, then the compilation is returned without asking Deezer', async () => {
    const { adapter, calls } = fakeAdapter({
      'itunes.apple.com': { results: [itunesRow('The Beatles', 'Hey Jude', 'The Beatles 1967-1970', '1973')] },
      'api.deezer.com': { data: [] },
    });
    const info = await resolveArt({ artist: 'The Beatles', title: 'Hey Jude', year: 1968 }, adapter);
    expect(info).toMatchObject({ source: 'itunes', album: 'The Beatles 1967-1970' });
    expect(calls.filter((u) => u.includes('itunes'))).toHaveLength(2); // "The Beatles" and "Beatles"
    expect(calls.some((u) => u.includes('deezer'))).toBe(false);
  });

  it('iTunes: the studio release found by the extra spelling wins over the compilation of the first', async () => {
    let n = 0;
    const { adapter } = fakeAdapter({
      'itunes.apple.com': () => ({ results: [++n === 1 ? itunesRow('The Beatles', 'Hey Jude', 'The Beatles 1967-1970', '1973') : itunesRow('The Beatles', 'Hey Jude', 'Past Masters', '1988')] }),
    });
    const info = await resolveArt({ artist: 'The Beatles', title: 'Hey Jude', year: 1968 }, adapter);
    expect(info).toMatchObject({ source: 'itunes', album: 'Past Masters' });
  });

  it('a live or acoustic take is never "good enough": the next spelling finds the studio album', async () => {
    const { adapter } = deezerWorld((q) => (q.startsWith('artist:"The Bangles"') ? 'the-bangles--eternal-flame' : q.startsWith('artist:"Bangles"') ? 'bangles--eternal-flame' : undefined));
    const info = await resolveArt({ artist: 'The Bangles', title: 'Eternal Flame' }, adapter);
    expect(info.album).toBe('Everything');
    const q = prepareQuery({ artist: 'The Bangles', title: 'Eternal Flame' });
    const acoustic = scoreCandidate(q, cand('The Bangles', 'Eternal Flame (Acoustic Version)', { album: 'Something That You Said', rank: 526_613 }), { maxRank: 526_613 });
    expect(acoustic.strongAlt).toBe(true);
    expect(acoustic.score).toBeGreaterThanOrEqual(GOOD_SCORE); // the score alone would have settled on it
  });
});

describe('digital-edition dates in the reported year', () => {
  it('reports The Wall 1979 (pre-streaming date, no database year) but not A Night at the Opera 2005', async () => {
    const pf = deezerWorld((q) => (/Pt\. 2/.test(q) ? 'pink-floyd--part-2--pt' : q.startsWith('artist:') ? 'pink-floyd--part-2--strict' : 'pink-floyd--part-2--plain'));
    const wall = await resolveArt({ artist: 'Pink Floyd', title: 'Another Brick in the Wall, Part 2' }, pf.adapter);
    expect(wall).toMatchObject({ album: 'The Wall', year: 1979 });
    expect(albumLine(wall, {})).toBe('1979 · The Wall');
    const qn = deezerWorld(byArtist('queen--bohemian-rhapsody'));
    const opera = await resolveArt({ artist: 'Queen', title: 'Bohemian Rhapsody' }, qn.adapter);
    expect(opera.album).toBe('A Night At The Opera');
    expect(opera.year).toBeUndefined();
    expect(albumLine(opera, {})).toBe('A Night At The Opera');
  });
});

// ------------------------------------------------------------------ the album route (real Deezer payloads, iTunes rate-limited; critic round 2)
import albumRouteFixture from './fixtures/deezer-album-route.json';
import { deezerAlbumRoute, MAX_ALBUM_ROUTE_LOOKUPS, MAX_ALBUM_ROUTES, rankAlbumRows, wantsAlbumRoute, type AlbumRow } from '../src/art.js';

const routeResponses = (albumRouteFixture as unknown as { responses: Record<string, unknown> }).responses;

/** Deezer replayed from the recorded responses (keyed by URL), iTunes answering 403, MusicBrainz empty. */
function recordedWorld(opts: { budgetOut?: () => boolean } = {}) {
  const calls: string[] = [];
  const adapter: ArtAdapter = {
    json: async (url) => {
      calls.push(url);
      if (url.includes('itunes.apple.com')) throw new HttpError(403, url);
      if (url.includes('musicbrainz.org')) return { recordings: [] };
      if (url in routeResponses) return routeResponses[url];
      if (url.includes('/album/')) return { error: { message: 'not recorded' } };
      return { data: [] };
    },
    imageExists: async () => false,
  };
  const searches = () => calls.filter((u) => u.includes('/search?q=')).length;
  const albumSearches = () => calls.filter((u) => u.includes('/search/album?')).length;
  const albumLookups = () => calls.filter((u) => /\/album\/\d+$/.test(u)).length;
  return { adapter, calls, searches, albumSearches, albumLookups, ...opts };
}
const albumRowsOf = (query: string): AlbumRow[] => {
  const url = `https://api.deezer.com/search/album?q=${encodeURIComponent(query)}&limit=25`;
  const rows = ((routeResponses[url] as { data: Record<string, unknown>[] })?.data ?? []).map((r) => ({
    id: String(r.id),
    title: String(r.title),
    artist: String((r.artist as { name: string }).name),
    art: deezerImage(r.cover_xl),
    trackCount: r.nb_tracks as number,
    recordType: r.record_type as AlbumRow['recordType'],
  }));
  expect(rows.length).toBeGreaterThan(0);
  return rows;
};

describe('album route: ranking the releases that carry the song', () => {
  it('ABBA — Dancing Queen: Arrival above ABBA Gold, the box set and the anniversary edition; Live at Wembley dropped', () => {
    const q = prepareQuery({ artist: 'ABBA', title: 'Dancing Queen' });
    const ranked = rankAlbumRows(q, albumRowsOf('artist:"ABBA" track:"Dancing Queen"')).map((r) => r.row.title);
    expect(ranked[0]).toBe('Arrival');
    expect(ranked.indexOf('ABBA Gold')).toBeGreaterThan(0);
    expect(ranked.indexOf('Thank You For The Music')).toBeGreaterThan(ranked.indexOf('ABBA Gold')); // 66-track box
    expect(ranked).not.toContain('Live At Wembley Arena');
  });

  it('The Police — Every Breath You Take: the remastered Synchronicity above the 84-track Super Deluxe, Live! and Sting\'s compilation out', () => {
    const q = prepareQuery({ artist: 'The Police', title: 'Every Breath You Take' });
    const ranked = rankAlbumRows(q, albumRowsOf('artist:"The Police" track:"Every Breath You Take"')).map((r) => r.row.title);
    expect(ranked[0]).toBe('Synchronicity (Remastered 2003)');
    expect(ranked.indexOf('Synchronicity (Super Deluxe Edition)')).toBeGreaterThan(0);
    expect(ranked).not.toContain('Live!');
    expect(ranked).not.toContain('Certifiable (Live in Buenos Aires)');
    expect(ranked).not.toContain('The Very Best Of Sting And The Police');
  });

  it('drops tribute acts, other artists and releases without artwork, sinks singles and lifts the title-track album', () => {
    const q = prepareQuery({ artist: 'Steve Miller Band', title: 'The Joker' });
    const rows: AlbumRow[] = [
      { id: '1', title: 'Ultimate Hits', artist: 'Steve Miller Band', art: 'a', trackCount: 22, recordType: 'album' },
      { id: '2', title: 'The Joker', artist: 'Steve Miller Band', art: 'a', trackCount: 9, recordType: 'album' },
      { id: '3', title: 'The Joker', artist: 'Steve Miller Band', art: 'a', trackCount: 1, recordType: 'single' },
      { id: '4', title: 'The Joker', artist: 'Hit Crew', art: 'a', trackCount: 12, recordType: 'album' },
      { id: '5', title: 'Genius Loves Company', artist: 'Ray Charles', art: 'a', trackCount: 12, recordType: 'album' },
      { id: '6', title: 'Fly Like an Eagle', artist: 'Steve Miller Band', trackCount: 9, recordType: 'album' },
      { id: '7', title: 'The Joker (Remixes)', artist: 'Steve Miller Band', art: 'a', trackCount: 6, recordType: 'ep' },
    ];
    expect(rankAlbumRows(q, rows).map((r) => r.row.id)).toEqual(['2', '3', '1']);
  });

  it('wantsAlbumRoute: a confident plain album of 5–20 tracks needs no route; compilations, singles, alternate takes, big or unknown releases and streaming-era re-releases do', () => {
    const q = prepareQuery({ artist: 'Queen', title: 'Bohemian Rhapsody', year: 1975 });
    const s = (extra: Partial<Candidate>) => scoreCandidate(q, cand('Queen', 'Bohemian Rhapsody', { album: 'A Night at the Opera', ...extra }));
    expect(wantsAlbumRoute(s({ recordType: 'album', trackCount: 12 }), q)).toBe(false);
    expect(wantsAlbumRoute(s({}), q)).toBe(true); // type unknown
    expect(wantsAlbumRoute(s({ recordType: 'album', trackCount: 27 }), q)).toBe(true); // "1"
    expect(wantsAlbumRoute(s({ recordType: 'single', trackCount: 1 }), q)).toBe(true);
    expect(wantsAlbumRoute(s({ album: 'Greatest Hits', recordType: 'album', trackCount: 17 }), q)).toBe(true);
    expect(wantsAlbumRoute(s({ recordType: 'album', trackCount: 12, year: 2016, yearKind: 'digital' }), q)).toBe(true);
    expect(wantsAlbumRoute(s({ recordType: 'album', trackCount: 12, year: 2016, yearKind: 'digital' }), prepareQuery({ artist: 'Queen', title: 'Bohemian Rhapsody' }))).toBe(false);
    expect(wantsAlbumRoute(scoreCandidate(q, cand('Queen', 'Bohemian Rhapsody (Live)', { album: 'A Night at the Opera', recordType: 'album', trackCount: 12 })), q)).toBe(true);
  });

  it('flags Spanish-language greatest-hits releases and "(Spanish Version)" takes', () => {
    const q = prepareQuery({ artist: 'Abba', title: 'Fernando' });
    const oro = scoreCandidate(q, cand('ABBA', 'Fernando (Spanish Version)', { album: 'Oro "Grandes Exitos"' }));
    expect(oro.comp).toBe(true);
    expect(oro.strongAlt).toBe(true);
    expect(oro.score).toBeLessThan(scoreCandidate(q, cand('ABBA', 'Fernando', { album: 'Arrival' })).score - 0.3);
  });
});

describe('album route: the original album behind Deezer\'s compilation row (real payloads, iTunes 403)', () => {
  it('ABBA — Dancing Queen: Arrival instead of ABBA Gold, with and without the year hint, in one album search and at most three album lookups', async () => {
    for (const year of [1976, undefined]) {
      const w = recordedWorld();
      const info = await resolveArt({ artist: 'ABBA', title: 'Dancing Queen', year }, w.adapter);
      expect(info).toMatchObject({ source: 'deezer-album', kind: 'track', album: 'Arrival' });
      expect(info.matched).toMatchObject({ artist: 'ABBA', title: 'Dancing Queen' });
      expect(info.matched!.score).toBeGreaterThanOrEqual(GOOD_SCORE);
      expect(info.art).toMatch(/^https:\/\/.*\/cover\/[0-9a-f]+\//);
      expect(w.albumSearches()).toBe(1);
      expect(w.searches()).toBe(1); // the strict track search settled it: no free-text query, no MusicBrainz
      expect(w.calls.some((u) => u.includes('musicbrainz'))).toBe(false);
      expect(w.albumLookups()).toBeLessThanOrEqual(MAX_DEEZER_ALBUM_LOOKUPS + MAX_ALBUM_ROUTE_LOOKUPS);
    }
  });

  it('ABBA — Fernando: Arrival, not the Spanish version on "Oro (Grandes Exitos)"', async () => {
    const w = recordedWorld();
    const info = await resolveArt({ artist: 'Abba', title: 'Fernando' }, w.adapter);
    expect(info).toMatchObject({ source: 'deezer-album', album: 'Arrival' });
    expect(info.matched!.title).toBe('Fernando');
  });

  it('The Beatles — Love Me Do: Please Please Me instead of "1"; Hey Jude keeps "1" when the artist has no better release', async () => {
    const a = recordedWorld();
    expect(await resolveArt({ artist: 'The Beatles', title: 'Love Me Do', year: 1962 }, a.adapter)).toMatchObject({ source: 'deezer-album', album: 'Please Please Me (Remastered)' });
    const b = recordedWorld();
    const jude = await resolveArt({ artist: 'The Beatles', title: 'Hey Jude', year: 1968 }, b.adapter);
    expect(jude).toMatchObject({ source: 'deezer', album: '1 (Remastered)' });
    expect(b.albumSearches()).toBe(1); // the route ran (27 tracks: not a plain album) and found nothing better
  });

  it('The Police — Every Breath You Take: Synchronicity (Remastered 2003), not the Super Deluxe box, Live! or Sting\'s compilation', async () => {
    const w = recordedWorld();
    const info = await resolveArt({ artist: 'The Police', title: 'Every Breath You Take' }, w.adapter);
    expect(info).toMatchObject({ source: 'deezer-album', album: 'Synchronicity (Remastered 2003)' });
    expect(info.matched!.title).toBe('Every Breath You Take');
  });

  it('The Righteous Brothers — Unchained Melody: Just Once In My Life behind the 2016 self-titled re-release (year hint)', async () => {
    const w = recordedWorld();
    expect(await resolveArt({ artist: 'The Righteous Brothers', title: 'Unchained Melody', year: 1965 }, w.adapter)).toMatchObject({ source: 'deezer-album', album: 'Just Once In My Life' });
  });

  it('Queen, Roxette, Bruce Hornsby, ABBA (The Album): the studio album every time', async () => {
    const cases: [ArtQuery, string][] = [
      [{ artist: 'Queen', title: 'We Are The Champions', year: 1977 }, 'News Of The World'],
      [{ artist: 'Roxette', title: 'The Look', year: 1989 }, 'Look Sharp!'],
      [{ artist: 'Bruce Hornsby', title: 'The Way It Is', year: 1986 }, 'The Way It Is'],
      [{ artist: 'Abba', title: 'Take A Chance On Me' }, 'The Album'],
    ];
    for (const [query, album] of cases) {
      const w = recordedWorld();
      const info = await resolveArt(query, w.adapter);
      expect(info, query.title).toMatchObject({ source: 'deezer-album', kind: 'track', album });
      expect(info.matched!.score, query.title).toBeGreaterThanOrEqual(GOOD_SCORE);
    }
  });

  it('Bread — If: the route lists only The Best of Bread and the compilation is kept (no crash, no extra lookups)', async () => {
    const w = recordedWorld();
    const info = await resolveArt({ artist: 'Bread', title: 'If', year: 1971 }, w.adapter);
    expect(info).toMatchObject({ source: 'deezer', album: 'The Best of Bread' });
    expect(w.albumSearches()).toBeLessThanOrEqual(MAX_ALBUM_ROUTES);
  });

  it('Pink Floyd — Part 2: a spelling that lists no release ("Part 2") leaves one retry, "Pt. 2" then finds The Wall in the track search', async () => {
    const w = recordedWorld();
    const info = await resolveArt({ artist: 'Pink Floyd', title: 'Another Brick in the Wall, Part 2', year: 1979 }, w.adapter);
    expect(info).toMatchObject({ kind: 'track', album: 'The Wall', year: 1979 });
    expect(info.matched!.title).toBe('Another Brick in the Wall, Pt. 2');
    expect(w.albumSearches()).toBeLessThanOrEqual(MAX_ALBUM_ROUTES);
  });

  it('deezerAlbumRoute verifies the song on the release\'s own track list and reuses cached album details', async () => {
    const q = prepareQuery({ artist: 'ABBA', title: 'Dancing Queen', year: 1976 });
    const w = recordedWorld();
    const cache = new Map();
    const from: Candidate = { artist: 'ABBA', title: 'Dancing Queen', album: 'ABBA Gold', art: 'x' };
    const cands = await deezerAlbumRoute(q, from, w.adapter, {}, cache);
    expect(cands.map((c) => c.album)).toContain('Arrival');
    for (const c of cands) expect(c).toMatchObject({ route: 'album', artist: 'ABBA', recordType: 'album' });
    const arrival = cands.find((c) => c.album === 'Arrival')!;
    expect(arrival.title).toBe('Dancing Queen');
    expect(arrival.trackCount).toBe(12);
    expect(typeof arrival.rank).toBe('number');
    expect(typeof arrival.fans).toBe('number');
    expect(w.albumLookups()).toBeLessThanOrEqual(MAX_ALBUM_ROUTE_LOOKUPS);
    await deezerAlbumRoute(q, from, w.adapter, {}, cache);
    const ids = w.calls.filter((u) => /\/album\/\d+$/.test(u));
    expect(new Set(ids).size).toBe(ids.length); // the second pass never repeats a lookup: cached releases are free
    expect(ids.length).toBeLessThanOrEqual(2 * MAX_ALBUM_ROUTE_LOOKUPS);
    // an exhausted budget stops the route before any album lookup
    const w2 = recordedWorld();
    expect(await deezerAlbumRoute(q, from, w2.adapter, {}, new Map(), () => true)).toEqual([]);
    expect(w2.albumLookups()).toBe(0);
  });
});
