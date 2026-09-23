/** `resolveArt`: the source chain, talking to the network only through an `ArtAdapter`. See ../art.ts. */
import { BAD_ARTIST_RE, GOOD_SCORE, bestSimilarity, candArtistForms, pickBest, prepareQuery, scoreCandidate, uniq } from './match.js';
import type { PreparedQuery, Scored } from './match.js';
import { placeholderArt } from './placeholder.js';
import { MAX_ALBUM_ROUTES, MAX_DEEZER_ALBUM_LOOKUPS, deezerAlbumRoute, deezerArtist, deezerTracks, enrichDeezer, itunesSongs, musicbrainz, wantsAlbumRoute } from './sources.js';
import type { Ctx, DeezerAlbumCache } from './sources.js';
import { ARTIST_GRACE_MS, DEFAULT_BUDGET, SKIP_COOLING_MS, abortError } from './types.js';
import type { ArtAdapter, ArtInfo, ArtQuery, ResolveOptions } from './types.js';

const MAX_ITUNES_SONG_TERMS = 3;
const MAX_DEEZER_QUERIES = 4;

function toInfo(q: PreparedQuery, s: Scored, source: string): ArtInfo {
  const c = s.cand;
  const info: ArtInfo = { art: c.art, source, kind: 'track', matched: { artist: c.artist, title: c.title, score: Math.round(s.score * 1000) / 1000 } };
  if (c.album) info.album = c.album;
  // A digital-edition date is only reported when it plausibly is the release year: it matches the database year,
  // or, when the database has none (most MIDI songs), it predates the streaming era – Deezer dates The Wall 1979
  // but "A Night at the Opera" 2005, and the UI would show 2005 as the song's year.
  if (c.year && (c.yearKind !== 'digital' || (q.year ? Math.abs(c.year - q.year) <= 3 : c.year <= 1999))) info.year = c.year;
  if (c.artistImage) info.artistImage = c.artistImage;
  if (c.sourceUrl) info.sourceUrl = c.sourceUrl;
  return info;
}

/**
 * Resolve cover art for a song using the fallback chain. Never rejects except on abort; always returns an
 * `ArtInfo` – with `kind: 'placeholder'` when nothing better could be found.
 */
export const HOSTS = { itunes: 'itunes.apple.com', deezer: 'api.deezer.com', musicbrainz: 'musicbrainz.org' } as const;

export async function resolveArt(query: ArtQuery, adapter: ArtAdapter, opts: ResolveOptions = {}): Promise<ArtInfo> {
  const q = prepareQuery(query);
  const now = opts.now ?? (() => Date.now());
  const budget = opts.budget ?? DEFAULT_BUDGET;
  const t0 = now();
  const user = opts.signal;
  // Two deadlines: the track-art sources stop at `budget`, the artist-picture fallback gets a little more.
  const soft = new AbortController();
  const hard = new AbortController();
  const timers: ReturnType<typeof setTimeout>[] = [];
  if (Number.isFinite(budget)) {
    timers.push(setTimeout(() => soft.abort(), budget));
    timers.push(setTimeout(() => hard.abort(), budget + ARTIST_GRACE_MS));
  }
  const onUserAbort = () => {
    soft.abort();
    hard.abort();
  };
  if (user?.aborted) onUserAbort();
  else user?.addEventListener('abort', onUserAbort, { once: true });
  const ctx: Ctx = { ...opts, user, signal: soft.signal };
  const ctxArtist: Ctx = { ...opts, user, signal: hard.signal };

  const check = () => {
    if (user?.aborted) throw abortError();
  };
  const overBudget = () => soft.signal.aborted || now() - t0 >= budget;
  const skipped = new Set<string>();
  /** True when the host is on a failure cool-down long enough that waiting would be worse than moving on. */
  const cooling = (host: string): boolean => {
    const ms = adapter.cooldown?.(`https://${host}/`) ?? 0;
    if (ms <= SKIP_COOLING_MS) return false;
    if (!skipped.has(host)) {
      skipped.add(host);
      opts.onEvent?.({ source: host, url: `https://${host}/`, ms: 0, ok: false, skipped: true, note: `skipped: host cooling down for ${Math.ceil(ms / 1000)}s` });
    }
    return true;
  };

  let artistImage: string | undefined;
  let artistUrl: string | undefined;
  const tried = new Set<string>();
  // Best accepted-but-unconvincing hit so far (a live take, a remix...): returned only if nothing better shows up.
  let fallback: { s: Scored; source: string } | null = null;
  // A confident hit on a compilation ("Love Songs", "Greatest Hits") is good enough to show, but the original
  // album is often one query away (another artist spelling, Deezer's "Pt." form): it buys one extra query of
  // the same source, after which the best hit so far is returned.
  let extraSpent = 0;
  const settle = (best: Scored | null, source: string): ArtInfo | null => {
    if (!best) return null;
    if (best.score >= GOOD_SCORE && !best.comp && !best.strongAlt) return toInfo(q, best, source);
    if (!fallback || best.score > fallback.s.score) fallback = { s: best, source };
    return null;
  };
  const goodFallback = (): boolean => !!fallback && (fallback as { s: Scored }).s.score >= GOOD_SCORE && !(fallback as { s: Scored }).s.strongAlt;
  /** True when a good compilation hit exists and its one extra query has already been spent. */
  const spentOnComp = (): boolean => goodFallback() && extraSpent++ >= 1;
  const settled = (): ArtInfo | null => {
    if (!fallback) return null;
    const info = toInfo(q, fallback.s, fallback.source);
    if (artistImage && !info.artistImage) info.artistImage = artistImage;
    return info;
  };
  const deezerAlbums: DeezerAlbumCache = new Map();
  let albumRoutes = 0;

  try {
    // 1. iTunes, entity=song. The primary term already uses the cleaned title and the "First Last" artist.
    const itunesTerms = uniq([
      `${q.artistTerms[0]} ${q.titleTerms[0]}`,
      `${q.artistTerms[0]} ${q.titleTerms[1] ?? q.titleTerms[0]}`,
      ...q.titleTerms.slice(2).map((t) => `${q.artistTerms[0]} ${t}`),
      ...q.artistTerms.slice(1).map((a) => `${a} ${q.titleTerms[0]}`),
    ]);
    for (const term of itunesTerms.slice(0, MAX_ITUNES_SONG_TERMS)) {
      check();
      if (overBudget() || cooling(HOSTS.itunes) || spentOnComp()) break;
      tried.add(term);
      const hit = settle(pickBest(q, await itunesSongs(adapter, ctx, term, 'song')), 'itunes');
      if (hit) return hit;
    }
    if (goodFallback()) {
      const hit = settled();
      if (hit) return hit;
    }

    // 2. Deezer (JSONP in the browser). Precise artist/track filter first – also with Deezer's own "Pt. 2"
    // spelling, which its strict search needs ("Part 2" finds only a live remix) and without a leading "The"
    // ("Bangles" finds Everything, "The Bangles" a compilation) – then a plain search, then the other spellings.
    const ptTerm = q.titleTerms.find((t, i) => i > 0 && /\bpt\.\s*(\d+|[ivx]+)\b/i.test(t));
    const noThe = /^the\s+/i.test(q.artistTerms[0]) ? q.artistTerms.find((a) => a.toLowerCase() === q.artistTerms[0].replace(/^the\s+/i, '').toLowerCase()) : undefined;
    const deezerQueries = uniq([
      `artist:"${q.artistTerms[0]}" track:"${q.titleTerms[0]}"`,
      ...(ptTerm ? [`artist:"${q.artistTerms[0]}" track:"${ptTerm}"`] : []),
      ...(noThe ? [`artist:"${noThe}" track:"${q.titleTerms[0]}"`] : []),
      `${q.artistTerms[0]} ${q.titleTerms[0]}`,
      ...q.artistTerms.slice(1, 2).map((a) => `artist:"${a}" track:"${q.titleTerms[0]}"`),
      ...q.titleTerms.slice(1, 2).map((t) => `artist:"${q.artistTerms[0]}" track:"${t}"`),
    ]);
    extraSpent = 0;
    for (const dq of deezerQueries.slice(0, MAX_DEEZER_QUERIES)) {
      check();
      if (overBudget() || cooling(HOSTS.deezer) || spentOnComp()) break;
      const cands = await deezerTracks(adapter, ctx, dq);
      if (cands.length && !cooling(HOSTS.deezer)) await enrichDeezer(q, cands, adapter, ctx, deezerAlbums, MAX_DEEZER_ALBUM_LOOKUPS, overBudget);
      check();
      if (!artistImage) {
        // Remember the artist portrait of any well-matching artist for the fallback.
        for (const c of cands) {
          if (c.artistImage && bestSimilarity(q.artistForms, candArtistForms(c.artist)) >= 0.8 && !BAD_ARTIST_RE.test(c.artist)) {
            artistImage = c.artistImage;
            break;
          }
        }
      }
      let best = pickBest(q, cands);
      // The album route: the original album behind a compilation / single / unknown release. Once per lookup
      // when it finds releases; a spelling that finds none ("Part 2" where Deezer says "Pt. 2") leaves one retry.
      if (best && albumRoutes < MAX_ALBUM_ROUTES && wantsAlbumRoute(best, q) && !overBudget() && !cooling(HOSTS.deezer)) {
        albumRoutes++;
        const more = await deezerAlbumRoute(q, best.cand, adapter, ctx, deezerAlbums, overBudget);
        check();
        if (more.length) {
          albumRoutes = MAX_ALBUM_ROUTES;
          cands.push(...more);
          best = pickBest(q, cands);
        }
      }
      const hit = settle(best, best?.cand.route === 'album' ? 'deezer-album' : 'deezer');
      if (hit) return hit;
    }
    if (goodFallback()) {
      const hit = settled();
      if (hit) return hit;
    }

    // 3. iTunes again: album entity (title tracks, singles, EPs) and remaining artist spellings.
    check();
    extraSpent = 0;
    if (!overBudget() && !cooling(HOSTS.itunes) && !spentOnComp()) {
      const hit = settle(pickBest(q, await itunesSongs(adapter, ctx, `${q.artistTerms[0]} ${q.titleTerms[0]}`, 'album')), 'itunes-album');
      if (hit) return hit;
    }
    for (const term of itunesTerms.slice(MAX_ITUNES_SONG_TERMS, MAX_ITUNES_SONG_TERMS + 2)) {
      check();
      if (tried.has(term)) continue;
      if (overBudget() || cooling(HOSTS.itunes) || spentOnComp()) break;
      tried.add(term);
      const hit = settle(pickBest(q, await itunesSongs(adapter, ctx, term, 'song')), 'itunes');
      if (hit) return hit;
    }

    // A studio take of the right song (on a compilation, in a mono cut...) beats a MusicBrainz round trip and
    // everything after it. A live / remix / demo fallback does not: MusicBrainz knows the studio releases.
    if (fallback && !(fallback as { s: Scored }).s.strongAlt) {
      const hit = settled();
      if (hit) return hit;
    }

    // 4. MusicBrainz recording search + Cover Art Archive.
    for (const a of q.artistTerms.slice(0, 2)) {
      check();
      if (overBudget() || cooling(HOSTS.musicbrainz)) break;
      const c = await musicbrainz(q, adapter, ctx, a, q.titleTerms[0]);
      if (c) {
        const s = scoreCandidate(q, c);
        const info = toInfo(q, s, 'musicbrainz');
        if (artistImage) info.artistImage = artistImage;
        return info;
      }
    }
    {
      const hit = settled();
      if (hit) return hit;
    }

    // 5. Artist picture.
    if (!opts.noArtistFallback) {
      if (!artistImage) {
        for (const a of q.artistTerms.slice(0, 3)) {
          check();
          if (hard.signal.aborted || cooling(HOSTS.deezer)) break;
          const hit = await deezerArtist(q, adapter, ctxArtist, a);
          if (hit) {
            artistImage = hit.image;
            artistUrl = hit.url;
            break;
          }
        }
      }
      if (artistImage) return { art: artistImage, artistImage, source: 'deezer-artist', kind: 'artist', sourceUrl: artistUrl };
    }

    // 6. Placeholder.
    return placeholderArt(q.title, q.artist);
  } finally {
    for (const t of timers) clearTimeout(t);
    user?.removeEventListener('abort', onUserAbort);
  }
}
