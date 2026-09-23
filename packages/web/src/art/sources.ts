/** The sources: iTunes Search, Deezer (tracks, album details, the album route, artist pictures), MusicBrainz + Cover Art Archive. See ../art.ts. */
import { ACCEPT, BAD_ARTIST_RE, GOOD_SCORE, NON_LATIN_RE, bestSimilarity, candArtistForms, flagsIn, isArtistRelated, isTitleTrack, isTributeWrap, scoreCandidate, stripFeatured, stripParens } from './match.js';
import type { Candidate, PreparedQuery, ScoreContext, Scored } from './match.js';
import { HttpError, isAbort } from './types.js';
import type { ArtAdapter, ResolveOptions } from './types.js';

type Rec = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const yearOf = (v: unknown): number | undefined => {
  const m = str(v).match(/^\d{4}/);
  return m ? Number(m[0]) : undefined;
};

/** Deezer returns a placeholder URL with an empty hash when an item has no picture. */
export function deezerImage(url: unknown): string | undefined {
  const u = str(url);
  return /\/images\/(?:cover|artist|playlist)\/[0-9a-f]{8,}\//i.test(u) ? u : undefined;
}

/**
 * Upgrade an iTunes thumbnail to `size` px. The `cc` variant centre-crops to an exact square (`bb` keeps the
 * source aspect: Madonna's Like a Virgin comes back 600x595 with it).
 */
export function itunesImage(url: unknown, size = 600): string | undefined {
  const u = str(url);
  return u ? u.replace(/\/\d+x\d+(bb|cc|-999)?\./, `/${size}x${size}cc.`) : undefined;
}

/** Ask known image CDNs for thumbnail bytes, not a 600–1000px cover in a 40px slot. */
export function thumbnailUrl(url: string, size = 96): string {
  try {
    const u = new URL(url);
    if (u.hostname.endsWith('.mzstatic.com')) return itunesImage(url, size)!;
    if (u.hostname === 'cdn-images.dzcdn.net') {
      u.pathname = u.pathname.replace(/\/\d+x\d+([-/\.])/, `/${size}x${size}$1`);
      return u.href;
    }
  } catch { /* data URIs and unknown providers retain their original URL */ }
  return url;
}

/** Resolution context: `signal` is the combined user+deadline signal, `user` the caller's own one. */
export interface ResolveContext extends ResolveOptions {
  user?: AbortSignal;
}
export type Ctx = ResolveContext;

async function timed<T>(source: string, url: string, opts: Ctx, fn: () => Promise<T>, count: (v: T) => number): Promise<T | null> {
  const t0 = Date.now();
  try {
    const v = await fn();
    opts.onEvent?.({ source, url, ms: Date.now() - t0, ok: true, candidates: count(v) });
    return v;
  } catch (e) {
    if (isAbort(e)) {
      // The caller gave up → propagate. The budget ran out → just a failed source, the chain falls back.
      if (opts.user?.aborted || !opts.signal?.aborted) throw e;
      opts.onEvent?.({ source, url, ms: Date.now() - t0, ok: false, note: 'budget exhausted' });
      return null;
    }
    opts.onEvent?.({ source, url, ms: Date.now() - t0, ok: false, status: e instanceof HttpError ? e.status : undefined, note: String((e as Error)?.message ?? e) });
    return null;
  }
}

export async function itunesSongs(adapter: ArtAdapter, opts: Ctx, term: string, entity: 'song' | 'album', country = 'us'): Promise<Candidate[]> {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=${entity}&limit=25&country=${country}`;
  const data = (await timed(`itunes-${entity}`, url, opts, () => adapter.json(url, { signal: opts.signal }), (d) => ((d as Rec)?.results as unknown[])?.length ?? 0)) as Rec | null;
  const results = (data?.results as Rec[] | undefined) ?? [];
  return results.map((r) =>
    entity === 'song'
      ? {
          artist: str(r.artistName),
          title: str(r.trackName),
          album: str(r.collectionName),
          albumArtist: str(r.collectionArtistName) || undefined,
          year: yearOf(r.releaseDate),
          art: itunesImage(r.artworkUrl100),
          sourceUrl: str(r.trackViewUrl) || str(r.collectionViewUrl) || undefined,
          discCount: typeof r.discCount === 'number' ? r.discCount : undefined,
          trackCount: typeof r.trackCount === 'number' ? r.trackCount : undefined,
        }
      : {
          artist: str(r.artistName),
          title: str(r.collectionName).replace(/\s+-\s+(single|ep)$/i, ''),
          album: str(r.collectionName),
          year: yearOf(r.releaseDate),
          art: itunesImage(r.artworkUrl100),
          sourceUrl: str(r.collectionViewUrl) || undefined,
          trackCount: typeof r.trackCount === 'number' ? r.trackCount : undefined,
        },
  );
}

async function deezerGet(adapter: ArtAdapter, url: string, opts: Ctx): Promise<unknown> {
  return adapter.jsonp ? adapter.jsonp(url, { signal: opts.signal }) : adapter.json(url, { signal: opts.signal });
}

export async function deezerTracks(adapter: ArtAdapter, opts: Ctx, query: string): Promise<Candidate[]> {
  const url = `https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=25`;
  const data = (await timed('deezer', url, opts, () => deezerGet(adapter, url, opts), (d) => ((d as Rec)?.data as unknown[])?.length ?? 0)) as Rec | null;
  const rows = (data?.data as Rec[] | undefined) ?? [];
  return rows.map((r) => {
    const album = r.album as Rec | undefined;
    const artist = r.artist as Rec | undefined;
    return {
      artist: str(artist?.name),
      title: str(r.title),
      album: str(album?.title),
      albumId: album?.id !== undefined && album?.id !== null ? String(album.id) : undefined,
      art: deezerImage(album?.cover_xl) ?? deezerImage(album?.cover_big),
      artistImage: deezerImage(artist?.picture_xl) ?? deezerImage(artist?.picture_big),
      sourceUrl: str(r.link) || undefined,
      rank: typeof r.rank === 'number' ? r.rank : undefined,
    };
  });
}

/** What Deezer's album endpoint adds to a search row. `null` = looked up, nothing usable. */
export interface DeezerAlbumDetails {
  year?: number;
  trackCount?: number;
  recordType?: Candidate['recordType'];
  albumArtist?: string;
  fans?: number;
  art?: string;
  /** The first 25 tracks of the release (title, credited artist, popularity rank). */
  tracks?: { title: string; artist: string; rank?: number }[];
}
export type DeezerAlbumCache = Map<string, DeezerAlbumDetails | null>;

/** How many distinct releases of one Deezer response are looked up in detail (≈ 250 ms each). */
export const MAX_DEEZER_ALBUM_LOOKUPS = 3;

async function deezerAlbum(adapter: ArtAdapter, opts: Ctx, id: string): Promise<DeezerAlbumDetails | null> {
  const url = `https://api.deezer.com/album/${encodeURIComponent(id)}`;
  const a = (await timed('deezer-album', url, opts, () => deezerGet(adapter, url, opts), (d) => ((d as Rec)?.id ? 1 : 0))) as Rec | null;
  if (!a || !a.id) return null;
  const rt = str(a.record_type).toLowerCase();
  const artist = a.artist as Rec | undefined;
  const rows = ((a.tracks as Rec | undefined)?.data as Rec[] | undefined) ?? [];
  const tracks = rows
    .map((t) => ({ title: str(t.title), artist: str((t.artist as Rec | undefined)?.name), rank: typeof t.rank === 'number' ? t.rank : undefined }))
    .filter((t) => t.title);
  return {
    year: yearOf(a.release_date),
    trackCount: typeof a.nb_tracks === 'number' ? a.nb_tracks : undefined,
    recordType: rt === 'album' || rt === 'single' || rt === 'ep' || rt === 'compile' ? rt : undefined,
    albumArtist: str(artist?.name) || undefined,
    fans: typeof a.fans === 'number' ? a.fans : undefined,
    art: deezerImage(a.cover_xl) ?? deezerImage(a.cover_big),
    tracks: tracks.length ? tracks : undefined,
  };
}

/**
 * Deezer search rows carry no year, size or type, so "Bohemian Rhapsody" (the Muppets single) and "A Night at
 * the Opera" look alike. Look up the album details of the best few accepted releases and merge them into the
 * candidates (mutated in place) so the ranking sees the same signals as with iTunes.
 */
export async function enrichDeezer(q: PreparedQuery, cands: Candidate[], adapter: ArtAdapter, opts: Ctx, cache: DeezerAlbumCache, max = MAX_DEEZER_ALBUM_LOOKUPS, overBudget: () => boolean = () => false): Promise<void> {
  let maxRank = 0;
  for (const c of cands) if (typeof c.rank === 'number' && c.rank > maxRank) maxRank = c.rank;
  const ctx: ScoreContext = maxRank ? { maxRank } : {};
  const byAlbum = new Map<string, number>();
  for (const c of cands) {
    if (!c.art || !c.albumId) continue;
    const s = scoreCandidate(q, c, ctx);
    if (!s.accepted || s.score < 1) continue;
    byAlbum.set(c.albumId, Math.max(byAlbum.get(c.albumId) ?? -Infinity, s.score));
  }
  if (!byAlbum.size) return;
  const ids = [...byAlbum.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  for (const id of ids.slice(0, max)) {
    if (opts.signal?.aborted || overBudget()) break;
    if (!cache.has(id)) cache.set(id, await deezerAlbum(adapter, opts, id));
  }
  for (const c of cands) {
    const d = c.albumId ? cache.get(c.albumId) : undefined;
    if (!d) continue;
    if (d.year) {
      c.year = d.year;
      c.yearKind = 'digital';
    }
    if (d.trackCount !== undefined) c.trackCount = d.trackCount;
    if (d.recordType) c.recordType = d.recordType;
    if (d.albumArtist) c.albumArtist = d.albumArtist;
    if (d.fans !== undefined) c.fans = d.fans;
  }
}

/** One row of Deezer's album search. */
export interface AlbumRow {
  id: string;
  title: string;
  /** Album artist as Deezer credits the release ("Various Artists" for a compilation of several acts). */
  artist: string;
  art?: string;
  trackCount?: number;
  recordType?: Candidate['recordType'];
  sourceUrl?: string;
}

/**
 * Deezer's album search accepts a `track:` filter and then lists *every* release of the artist that carries a
 * track of that name – the plain track search shows only the most-streamed row per distinct title, which on old
 * catalogue is the compilation ("Dancing Queen" is only ever found on ABBA Gold; with the filter, Arrival is
 * listed next to it). One request, no CORS issue (JSONP in the browser).
 */
async function deezerAlbumsWithTrack(adapter: ArtAdapter, opts: Ctx, artist: string, title: string): Promise<AlbumRow[]> {
  const url = `https://api.deezer.com/search/album?q=${encodeURIComponent(`artist:"${artist}" track:"${title}"`)}&limit=25`;
  const data = (await timed('deezer-album-search', url, opts, () => deezerGet(adapter, url, opts), (d) => ((d as Rec)?.data as unknown[])?.length ?? 0)) as Rec | null;
  const rows = (data?.data as Rec[] | undefined) ?? [];
  return rows
    .map((r) => {
      const rt = str(r.record_type).toLowerCase();
      return {
        id: r.id !== undefined && r.id !== null ? String(r.id) : '',
        title: str(r.title),
        artist: str((r.artist as Rec | undefined)?.name),
        art: deezerImage(r.cover_xl) ?? deezerImage(r.cover_big),
        trackCount: typeof r.nb_tracks === 'number' ? r.nb_tracks : undefined,
        recordType: rt === 'album' || rt === 'single' || rt === 'ep' || rt === 'compile' ? (rt as Candidate['recordType']) : undefined,
        sourceUrl: str(r.link) || undefined,
      };
    })
    .filter((r) => r.id && r.title);
}

/**
 * Order the releases that carry the song by how likely each is the original studio album, most likely first –
 * this only decides which few releases are looked up in detail (`MAX_ALBUM_ROUTE_LOOKUPS`), the final choice is
 * `pickBest` over the tracks found on them. Live, demo, remix and tribute releases and other artists' albums
 * are dropped; compilations, singles, box sets and deluxe reissues sink; a proper album with the song as its
 * title track rises.
 */
export function rankAlbumRows(q: PreparedQuery, rows: AlbumRow[]): { row: AlbumRow; score: number }[] {
  const out: { row: AlbumRow; score: number }[] = [];
  for (const row of rows) {
    if (!row.art) continue;
    if (BAD_ARTIST_RE.test(row.artist)) continue;
    const artistForms = candArtistForms(row.artist);
    const artistSim = bestSimilarity(q.artistForms, artistForms);
    const related = artistSim >= ACCEPT.artistWeak && isArtistRelated(q.artistForms, artistForms);
    if (artistSim < ACCEPT.artist && !related) continue;
    if (isTributeWrap(q.artistForms, artistForms)) continue;
    const fa = flagsIn(row.title, q.ownFlags, 'album');
    if (fa.reject || fa.live || fa.demo || fa.altStrong) continue;
    let score = artistSim >= ACCEPT.artist ? 0 : -0.3;
    const comp = fa.comp || row.recordType === 'compile';
    if (comp) score -= 0.5;
    if (row.recordType === 'album') score += 0.2;
    else if (row.recordType === 'ep') score += 0.05;
    const tracks = row.trackCount ?? 0;
    if (tracks > 30) score -= 0.55; // a box set sinks below a compilation
    else if (tracks > 20) score -= 0.05;
    else if (tracks > 0 && tracks <= 4) score -= 0.1;
    if (fa.reissue) score -= 0.05;
    if (fa.remaster) score -= 0.01;
    if (!comp && isTitleTrack(q.title, row.title)) score += 0.1;
    if (NON_LATIN_RE.test(row.title) && !NON_LATIN_RE.test(`${q.title} ${q.artist}`)) score -= 0.3;
    out.push({ row, score });
  }
  // Stable: Deezer's own order (relevance, then popularity) breaks ties.
  return out.map((x, i) => ({ ...x, i })).sort((a, b) => b.score - a.score || a.i - b.i).map(({ row, score }) => ({ row, score }));
}

/** Releases considered by the album route – the best-ranked few, looked up in detail (≈ 250 ms each) unless cached. */
export const MAX_ALBUM_ROUTE_LOOKUPS = 3;
/** Album-route searches per lookup: one that lists releases settles it, one that lists none may be retried. */
export const MAX_ALBUM_ROUTES = 2;

/**
 * The album route: when the track search settled on a compilation, a single, an alternate take or an unknown
 * release, ask Deezer which of the artist's releases carry the song, look up the most album-like few and turn
 * the song's row on each of them into a candidate carrying the release's size, type, popularity and followers –
 * so `pickBest` can rank "Arrival" against "ABBA Gold" with the same signals as an iTunes response. The album's
 * own track list verifies that the song really is on it (as a plain take, not a live one) and gives its rank.
 */
export async function deezerAlbumRoute(q: PreparedQuery, from: Candidate, adapter: ArtAdapter, opts: Ctx, cache: DeezerAlbumCache, overBudget: () => boolean = () => false, max = MAX_ALBUM_ROUTE_LOOKUPS): Promise<Candidate[]> {
  // Deezer's own spellings of the artist and the title: the strict filters need them ("Pt. 2", "Bangles";
  // "Earth, Wind & Fire" must not be cut at its comma).
  const artist = stripFeatured(from.artist) || from.artist;
  const title = stripParens(stripFeatured(from.title)) || from.title;
  const rows = await deezerAlbumsWithTrack(adapter, opts, artist, title);
  const ranked = rankAlbumRows(q, rows);
  const out: Candidate[] = [];
  // Releases already looked up by the track search are free, so up to `max` new lookups among the best 2·max rows.
  let looked = 0;
  for (const { row } of ranked.slice(0, 2 * max)) {
    if (opts.signal?.aborted || overBudget()) break;
    if (!cache.has(row.id)) {
      if (looked >= max) continue;
      looked++;
      cache.set(row.id, await deezerAlbum(adapter, opts, row.id));
    }
    const d = cache.get(row.id);
    if (!d?.tracks) continue;
    for (const t of d.tracks) {
      const c: Candidate = {
        artist: t.artist || row.artist,
        title: t.title,
        album: row.title,
        albumArtist: d.albumArtist ?? row.artist,
        albumId: row.id,
        art: row.art ?? d.art,
        sourceUrl: row.sourceUrl,
        rank: t.rank,
        trackCount: d.trackCount ?? row.trackCount,
        recordType: d.recordType ?? row.recordType,
        fans: d.fans,
        route: 'album',
      };
      if (d.year) {
        c.year = d.year;
        c.yearKind = 'digital';
      }
      const s = scoreCandidate(q, c);
      if (s.accepted && !s.strongAlt) out.push(c);
    }
  }
  return out;
}

/** True when a Deezer hit is worth a look at the artist's other releases: not a confident, plain, real album. */
export function wantsAlbumRoute(s: Scored, q?: PreparedQuery): boolean {
  const c = s.cand;
  // A studio album has 5–20 tracks: more is a double album (fine, the route finds it again) or a compilation
  // that no word gives away ("1", "Love", "The Righteous Brothers").
  const realAlbum = c.recordType === 'album' && (c.trackCount ?? 0) >= 5 && (c.trackCount ?? 0) <= 20;
  // A streaming-era edition of a song more than 20 years older: a re-release, the original is worth a look.
  const reissue = c.yearKind === 'digital' && !!c.year && c.year >= 2015 && !!q?.year && c.year - q.year > 20;
  return s.score < GOOD_SCORE || s.comp || s.strongAlt || !realAlbum || reissue;
}

export async function deezerArtist(q: PreparedQuery, adapter: ArtAdapter, opts: Ctx, name: string): Promise<{ name: string; image: string; url?: string; fans: number } | null> {
  const url = `https://api.deezer.com/search/artist?q=${encodeURIComponent(name)}&limit=10`;
  const data = (await timed('deezer-artist', url, opts, () => deezerGet(adapter, url, opts), (d) => ((d as Rec)?.data as unknown[])?.length ?? 0)) as Rec | null;
  const rows = (data?.data as Rec[] | undefined) ?? [];
  let best: { name: string; image: string; url?: string; fans: number; sim: number } | null = null;
  for (const r of rows) {
    const image = deezerImage(r.picture_xl) ?? deezerImage(r.picture_big);
    if (!image) continue;
    const nm = str(r.name);
    const sim = bestSimilarity(q.artistForms, candArtistForms(nm));
    if (sim < 0.8 || BAD_ARTIST_RE.test(nm)) continue;
    const fans = typeof r.nb_fan === 'number' ? r.nb_fan : 0;
    if (!best || sim > best.sim + 0.05 || (Math.abs(sim - best.sim) <= 0.05 && fans > best.fans)) best = { name: nm, image, url: str(r.link) || undefined, fans, sim };
  }
  return best;
}

interface MbRelease {
  id: string;
  rg?: string;
  title: string;
  date?: string;
  status?: string;
  primary?: string;
  secondary: string[];
}

function mbEscape(s: string): string {
  return s.replace(/["\\]/g, ' ').replace(/[+\-!(){}[\]^~*?:/]/g, ' ');
}

export async function musicbrainz(q: PreparedQuery, adapter: ArtAdapter, opts: Ctx, artist: string, title: string): Promise<Candidate | null> {
  const lucene = `recording:"${mbEscape(title)}" AND artist:"${mbEscape(artist)}"`;
  const url = `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(lucene)}&fmt=json&limit=15`;
  const data = (await timed('musicbrainz', url, opts, () => adapter.json(url, { signal: opts.signal }), (d) => ((d as Rec)?.recordings as unknown[])?.length ?? 0)) as Rec | null;
  const recs = (data?.recordings as Rec[] | undefined) ?? [];
  // Collect every acceptable recording's releases, rank releases, then probe the Cover Art Archive.
  const releases: { rel: MbRelease; cand: Candidate; score: number }[] = [];
  for (const r of recs) {
    const credit = ((r['artist-credit'] as Rec[] | undefined) ?? []).map((c) => str(c.name) + str(c.joinphrase)).join('');
    const cand: Candidate = { artist: credit, title: str(r.title), art: 'pending' };
    const s = scoreCandidate(q, cand);
    if (!s.accepted) continue;
    for (const rel of (r.releases as Rec[] | undefined) ?? []) {
      const rg = rel['release-group'] as Rec | undefined;
      const mr: MbRelease = {
        id: str(rel.id),
        rg: str(rg?.id) || undefined,
        title: str(rel.title),
        date: str(rel.date) || undefined,
        status: str(rel.status) || undefined,
        primary: str(rg?.['primary-type']) || undefined,
        secondary: ((rg?.['secondary-types'] as unknown[]) ?? []).map(String),
      };
      let score = s.titleSim + s.artistSim;
      if (mr.status && mr.status !== 'Official') score -= 0.5;
      if (mr.secondary.some((t) => /live|compilation|remix|dj-mix|demo|soundtrack|mixtape/i.test(t))) score -= 0.3;
      if (mr.primary === 'Album') score += 0.1;
      else if (mr.primary === 'Single') score += 0.05;
      const y = yearOf(mr.date);
      if (y) {
        score -= Math.max(0, y - 1950) * 0.002;
        if (q.year && Math.abs(y - q.year) <= 1) score += 0.1;
      } else score -= 0.05;
      releases.push({ rel: mr, cand, score });
    }
  }
  releases.sort((a, b) => b.score - a.score);
  const probed = new Set<string>();
  let probes = 0;
  for (const { rel, cand } of releases) {
    if (probes >= 4 || opts.signal?.aborted) break;
    // A release-group probe returns the front cover of any release in the group – best odds per request.
    const targets = [rel.rg ? `https://coverartarchive.org/release-group/${rel.rg}/front-500` : '', `https://coverartarchive.org/release/${rel.id}/front-500`].filter(Boolean);
    for (const t of targets) {
      if (probed.has(t)) continue;
      probed.add(t);
      probes++;
      const ok = await timed('coverart', t, opts, () => adapter.imageExists(t, { signal: opts.signal }), (v) => (v ? 1 : 0));
      if (ok) {
        return { ...cand, art: t, album: rel.title, year: yearOf(rel.date), sourceUrl: `https://musicbrainz.org/release/${rel.id}` };
      }
      if (probes >= 4) break;
    }
  }
  return null;
}
