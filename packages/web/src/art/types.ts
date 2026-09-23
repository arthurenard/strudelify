/** Types, errors and budgets shared by the art modules. See ../art.ts. */

export interface ArtInfo {
  /** Square cover image URL (≥ 500px), or an SVG data URI for the placeholder. */
  art?: string;
  album?: string;
  year?: number;
  /** Which service answered: itunes | itunes-album | deezer | deezer-album | musicbrainz | deezer-artist | placeholder. */
  source?: string;
  /** What `art` shows: the track's release, the artist, or a generated placeholder. */
  kind?: 'track' | 'artist' | 'placeholder';
  /** Artist portrait (Deezer), when one was seen while resolving. */
  artistImage?: string;
  /** Web page of the matched release / artist. */
  sourceUrl?: string;
  /** The names as the source spells them, and the fuzzy match score (debugging / harness). */
  matched?: { artist: string; title: string; score: number };
}

export interface ArtQuery {
  artist: string;
  title: string;
  /** Release year hint (from the database) – nudges the candidate ranking, never required. */
  year?: number;
}

export interface RequestInit2 {
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** Network seam. Implementations must throw `HttpError` for non-2xx responses so retries can classify them. */
export interface ArtAdapter {
  json(url: string, init?: RequestInit2): Promise<unknown>;
  /** JSONP GET (browser only – Deezer sends no CORS headers). Falls back to `json` when absent. */
  jsonp?(url: string, init?: RequestInit2): Promise<unknown>;
  /** Whether an image URL resolves (used for Cover Art Archive probes). */
  imageExists(url: string, init?: RequestInit2): Promise<boolean>;
  /**
   * Milliseconds until the host of `url` accepts requests again after a run of failures (0 = now).
   * The chain skips a cooling host instead of waiting, so a rate-limited iTunes never delays Deezer.
   */
  cooldown?(url: string): number;
}

export interface ArtEvent {
  source: string;
  url: string;
  ms: number;
  ok: boolean;
  status?: number;
  candidates?: number;
  note?: string;
  /** The source was skipped without a request (host cooling down after failures). */
  skipped?: boolean;
}

export interface ResolveOptions {
  signal?: AbortSignal;
  /** Called after every request – the harness uses it for per-source statistics. */
  onEvent?: (e: ArtEvent) => void;
  /** Skip the artist-image fallback (harness "track art only" mode). */
  noArtistFallback?: boolean;
  /**
   * Wall-time budget in ms for the track-art sources (default `DEFAULT_BUDGET`). When it runs out the chain
   * stops searching and returns the artist picture (given `ARTIST_GRACE_MS` more) or the placeholder.
   * `Infinity` disables the cap.
   */
  budget?: number;
  /** Clock (tests). */
  now?: () => number;
}

/** Default wall-time budget for the track-art sources, ms. */
export const DEFAULT_BUDGET = 8000;
/** Extra time granted to the artist-picture fallback once the budget is exhausted, ms. */
export const ARTIST_GRACE_MS = 3000;
/** A host whose cool-down exceeds this is skipped rather than waited for, ms. */
export const SKIP_COOLING_MS = 1500;

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly url: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
  }
}

export function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}
export const isAbort = (e: unknown): boolean => (e as Error | null)?.name === 'AbortError';
