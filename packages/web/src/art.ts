/**
 * Cover art lookup for a song: iTunes Search → Deezer → MusicBrainz + Cover Art Archive → Deezer artist
 * picture → deterministic gradient placeholder. Every source is keyless and callable from a browser.
 *
 * This module is the public face of art/, whose layers let the exact same resolution logic run in the
 * browser and in Node (see tools/art-check.mjs):
 *   - pure matching helpers (normalisation, query variants, fuzzy scoring)      → unit-testable
 *   - `resolveArt(query, adapter)`: the source chain, talks to the network only through an `ArtAdapter`
 *   - adapters: `createFetchAdapter` (Node or browser) / `createBrowserAdapter` (adds JSONP for Deezer),
 *     both wrapped in a `RequestQueue` that spaces requests per host (plus a token bucket that keeps iTunes
 *     under its ~20 requests/min), retries with exponential backoff and puts a host on cool-down after a run of
 *     failures so the chain skips it instead of waiting
 *   - `lookupArt(id, artist, title)`: what the web app calls. Adds the localStorage cache (hits only, never
 *     misses) and supersedes the previous in-flight lookup when the user switches song.
 *
 * Time-to-art is bounded: the track sources share a wall-time budget (`DEFAULT_BUDGET`, 8 s) after which the
 * artist picture or the placeholder is returned; a rate-limited iTunes (403) costs ~1 s before Deezer is asked.
 *
 * Deezer search rows carry no year, size or release type, so the album details (`/album/<id>`: record type,
 * track count, digital release date, album artist, fans) of the best few accepted releases are fetched and
 * merged before ranking – the ranking then sees the same signals as with iTunes and picks "A Night at the
 * Opera" over the "Queen + The Muppets" single. See `enrichDeezer` and `tools/art-check.md`. And because that
 * search shows one row per distinct title (the most-streamed one: on old catalogue the compilation), a hit on a
 * compilation / single / unknown release triggers the album route (`deezerAlbumRoute`): Deezer's album search
 * with a `track:` filter lists every release of the artist that carries the song, so "Arrival" is ranked against
 * "ABBA Gold" instead of never being seen.
 */

export { ARTIST_GRACE_MS, DEFAULT_BUDGET, HttpError, SKIP_COOLING_MS, abortError, isAbort } from './art/types.js';
export type { ArtAdapter, ArtEvent, ArtInfo, ArtQuery, RequestInit2, ResolveOptions } from './art/types.js';
export { ACCEPT, GOOD_SCORE, artistVariants, bestSimilarity, containment, dice, isArtistRelated, isTitlePrefix, isTitleTrack, isTributeWrap, normalize, normalizeArtist, pickBest, prepareQuery, scoreCandidate, similarity, stripDupSuffix, stripFeatured, stripParens, titleVariants } from './art/match.js';
export type { Candidate, PreparedQuery, ScoreContext, Scored } from './art/match.js';
export { DEFAULT_HOST_POLICY, RequestQueue, isRetryable, sleep } from './art/queue.js';
export type { HostPolicy, QueueOptions } from './art/queue.js';
export { REQUEST_TIMEOUT, createBrowserAdapter, createFetchAdapter, defaultQueue } from './art/adapters.js';
export type { FetchAdapterOptions } from './art/adapters.js';
export { MAX_ALBUM_ROUTES, MAX_ALBUM_ROUTE_LOOKUPS, MAX_DEEZER_ALBUM_LOOKUPS, deezerAlbumRoute, deezerImage, enrichDeezer, itunesImage, rankAlbumRows, thumbnailUrl, wantsAlbumRoute } from './art/sources.js';
export type { AlbumRow, DeezerAlbumCache, DeezerAlbumDetails, ResolveContext } from './art/sources.js';
export { placeholderArt } from './art/placeholder.js';
export { HOSTS, resolveArt } from './art/resolve.js';
export { LOW_CONFIDENCE_SCORE, lookupArt, lookupThumbnail, peekArt, readCache, writeCache } from './art/lookup.js';
export type { LookupOptions } from './art/lookup.js';
