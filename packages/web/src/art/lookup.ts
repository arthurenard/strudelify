/** The browser entry point: localStorage cache, shared and superseded lookups, thumbnails. See ../art.ts. */
import { GOOD_SCORE } from './match.js';
import { saveRow } from '../store.js';
import { createBrowserAdapter, createFetchAdapter } from './adapters.js';
import { placeholderArt } from './placeholder.js';
import { DEFAULT_HOST_POLICY, RequestQueue } from './queue.js';
import { resolveArt } from './resolve.js';
import { isAbort } from './types.js';
import type { ArtAdapter, ArtInfo } from './types.js';

const CACHE_PREFIX = 'art:v3:';
const ARTIST_TTL = 7 * 24 * 3600 * 1000;
/**
 * Track hits that did not reach `GOOD_SCORE` (a fuzzy title or a penalised release, kept as the best fallback) are
 * re-validated after a week instead of being kept forever; confident matches (exact title + artist, studio
 * release) are permanent.
 */
export const LOW_CONFIDENCE_SCORE = GOOD_SCORE;
const LOW_CONFIDENCE_TTL = 7 * 24 * 3600 * 1000;

interface CacheRow extends ArtInfo {
  ts: number;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

let swept = false;
/** Drop cache rows written by older versions of this module (they may contain cached misses). */
function sweepOldCache(ls: Storage) {
  if (swept) return;
  swept = true;
  try {
    const stale: string[] = [];
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k && k.startsWith('art:') && !k.startsWith(CACHE_PREFIX)) stale.push(k);
    }
    for (const k of stale) ls.removeItem(k);
  } catch {
    /* ignore */
  }
}

export function readCache(id: string): ArtInfo | null {
  const ls = storage();
  if (!ls) return null;
  sweepOldCache(ls);
  try {
    const raw = ls.getItem(CACHE_PREFIX + id);
    if (!raw) return null;
    const row = JSON.parse(raw) as CacheRow;
    if (!row.art || row.kind === 'placeholder') return null;
    const age = Date.now() - (row.ts ?? 0);
    if (row.kind === 'artist' && age > ARTIST_TTL) return null;
    if (row.kind === 'track' && (row.matched?.score ?? 0) < LOW_CONFIDENCE_SCORE && age > LOW_CONFIDENCE_TTL) return null;
    const { ts: _ts, ...info } = row;
    return info;
  } catch {
    return null;
  }
}

export function writeCache(id: string, info: ArtInfo) {
  if (!info.art || (info.kind !== 'track' && info.kind !== 'artist')) return; // never cache misses or placeholders
  const ls = storage();
  if (ls) saveRow(ls, CACHE_PREFIX + id, JSON.stringify({ ...info, ts: Date.now() } satisfies CacheRow));
}

let browserAdapter: ArtAdapter | null = null;
function defaultAdapter(): ArtAdapter {
  if (!browserAdapter) browserAdapter = typeof document !== 'undefined' ? createBrowserAdapter({
    timeout: 1800,
    // Interactive lookups have other providers to try. Keep host rate limits, but don't spend
    // the whole cover budget retrying a stalled provider before trying the next one.
    queue: new RequestQueue({ hostPolicy: Object.fromEntries(
      Object.entries(DEFAULT_HOST_POLICY).map(([host, policy]) => [host, { ...policy, maxRetries: 0 }]),
    ) }),
  }) : createFetchAdapter();
  return browserAdapter;
}

const memo = new Map<string, ArtInfo>();
/** Read synchronously so cached covers never wait behind unrelated network lookups. */
export const peekArt = (id: string): ArtInfo | null => memo.get(id) ?? readCache(id);
const inFlight = new Map<string, { job: Promise<ArtInfo>; ctrl: AbortController; thumbnail: boolean }>();
let latest: AbortController | null = null;

export interface LookupOptions {
  signal?: AbortSignal;
  /** Cancel the previous still-running lookup (default true: the UI shows one song at a time). */
  supersede?: boolean;
  year?: number;
  adapter?: ArtAdapter;
  /** Wall-time budget for the track-art sources, ms (default `DEFAULT_BUDGET`). */
  budget?: number;
  noArtistFallback?: boolean;
}

/**
 * Look up cover art for a song. Resolves quickly from cache when possible, otherwise walks the source chain.
 * Never rejects: a superseded/aborted lookup resolves to `{}`, an exhausted chain to a placeholder.
 * Bounded in time: after `budget` ms (8 s) of unlucky sources the artist picture or placeholder is returned.
 */
export async function lookupArt(id: string, artist: string, title: string, opts: LookupOptions = {}): Promise<ArtInfo> {
  const cached = peekArt(id);
  if (cached?.art) {
    memo.set(id, cached);
    return cached;
  }
  // Share a running lookup of the same song – unless it was superseded (A → B → A): that one resolves to `{}`
  // as soon as its requests notice the abort, so start a fresh one instead.
  const pending = inFlight.get(id);
  if (pending && !pending.ctrl.signal.aborted) {
    const info = await pending.job;
    // Opening a song must not inherit a thumbnail's short deadline and permanent placeholder, nor the empty
    // result of a lookup that its own owner cancelled meanwhile (a search row scrolled away).
    const cancelledByOwner = !info.art && pending.ctrl.signal.aborted && !opts.signal?.aborted;
    if (cancelledByOwner || (pending.thumbnail && !opts.noArtistFallback && info.kind === 'placeholder')) {
      return lookupArt(id, artist, title, opts);
    }
    return info;
  }

  if (opts.supersede !== false) latest?.abort();
  const ctrl = new AbortController();
  if (opts.supersede !== false) latest = ctrl;
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }

  const entry = { ctrl, thumbnail: !!opts.noArtistFallback, job: Promise.resolve<ArtInfo>({}) };
  entry.job = (async (): Promise<ArtInfo> => {
    try {
      const info = await resolveArt({ artist, title, year: opts.year }, opts.adapter ?? defaultAdapter(), {
        signal: ctrl.signal, budget: opts.budget, noArtistFallback: opts.noArtistFallback,
      });
      if (info.kind === 'track' || info.kind === 'artist') {
        memo.set(id, info);
        writeCache(id, info);
      }
      return info;
    } catch (e) {
      if (isAbort(e)) return {};
      return placeholderArt(title, artist);
    } finally {
      if (inFlight.get(id) === entry) inFlight.delete(id);
      if (latest === ctrl) latest = null;
    }
  })();
  inFlight.set(id, entry);
  return entry.job;
}

const thumbnailMisses = new Map<string, number>();
/**
 * Thumbnails don't use artist portraits; avoid spending their extra three-second grace period. `signal` cancels
 * a lookup nobody will see any more (the search rows it was for are gone), so it stops using the hosts'
 * per-minute allowance that the song being opened needs.
 */
export async function lookupThumbnail(id: string, artist: string, title: string, year?: number, signal?: AbortSignal): Promise<ArtInfo> {
  const cached = peekArt(id);
  if (cached) return cached;
  if ((thumbnailMisses.get(id) ?? 0) > Date.now() || signal?.aborted) return {};
  const info = await lookupArt(id, artist, title, { year, supersede: false, budget: 4000, noArtistFallback: true, signal });
  if (signal?.aborted) return info;
  if (!info.art || info.kind === 'placeholder') thumbnailMisses.set(id, Date.now() + 30_000);
  else thumbnailMisses.delete(id);
  return info;
}
