/**
 * The cover catalogue: every song's cover, resolved once ahead of time by tools/resolve-covers.mjs with the art
 * chain (art.ts) and kept in packages/data/covers.tsv. The build bakes the landing page's covers and each song
 * page's cover into the HTML, and splits the rest into small files, `db/covers/<n>.json`, grouped by artist so
 * that a search for one artist or a song's "More by" reads one file. A song missing from it (added since the
 * last run) is looked up in the browser as before. Keep this module free of DOM access.
 */
import type { ArtInfo } from './art/types.js';
import { fnv1a } from './tint.js';

/** What the catalogue keeps of a resolved cover; `none` when the chain found neither the release nor the artist. */
export interface Cover { kind: 'track' | 'artist' | 'none'; source?: string; art?: string; album?: string; year?: number; url?: string }

const COLUMNS = ['id', 'kind', 'source', 'art', 'album', 'year', 'url'] as const;
export const COVERS_HEADER = `${COLUMNS.join('\t')}\n`;
const field = (v: unknown) => (v === undefined || v === null ? '' : String(v).replace(/[\t\r\n]+/g, ' ').trim());

/** A covers.tsv line for a song and what the art chain returned for it. */
export function coverLine(id: string, info: ArtInfo): string {
  const found = !!info.art && (info.kind === 'track' || info.kind === 'artist');
  return `${[id, found ? info.kind : 'none', info.source, found ? info.art : '', info.album, info.year, info.sourceUrl].map(field).join('\t')}\n`;
}

/** covers.tsv read back: the last line of a song wins (a retried miss replaces the earlier one). */
export function readCovers(text: string): Map<string, Cover> {
  const covers = new Map<string, Cover>();
  for (const line of text.split('\n').slice(1)) {
    const [id, kind, source, art, album, year, url] = line.split('\t');
    if (!id || (kind !== 'track' && kind !== 'artist' && kind !== 'none')) continue;
    covers.set(id, { kind, ...(source ? { source } : {}), ...(art ? { art } : {}), ...(album ? { album } : {}), ...(Number(year) ? { year: Number(year) } : {}), ...(url ? { url } : {}) });
  }
  return covers;
}

/** The ArtInfo the app shows for a catalogued cover, or null when the catalogue found none. */
export function coverInfo(c: Cover | undefined): ArtInfo | null {
  if (!c?.art || c.kind === 'none') return null;
  return { art: c.art, kind: c.kind, source: c.source, ...(c.album ? { album: c.album } : {}), ...(c.year ? { year: c.year } : {}), ...(c.url ? { sourceUrl: c.url } : {}), ...(c.kind === 'artist' ? { artistImage: c.art } : {}) };
}

/** How many files the catalogue is split into. */
export const COVER_SHARDS = 256;
/**
 * The file a song's cover is in: songs of one artist share one (the artist part of the id, `the-beatles` of
 * `the-beatles--hey-jude`); score arrangements, whose ids name no artist, are spread by their own id.
 */
export function coverShard(id: string): number {
  const cut = id.indexOf('--');
  const artist = cut > 0 && !id.startsWith('pdmx--') ? id.slice(0, cut) : id;
  return fnv1a(artist) % COVER_SHARDS;
}

/**
 * The catalogue split into its files: shard number → { id: [kind, art, album, year, source, url] }, a song the
 * chain found nothing for as `['n']` (the app then shows its tile at once instead of asking the providers again),
 * every file present (an artist without covers has an empty one).
 */
export function coverShards(covers: ReadonlyMap<string, Cover>): Map<number, Record<string, CoverRow>> {
  const shards = new Map<number, Record<string, CoverRow>>(Array.from({ length: COVER_SHARDS }, (_, n) => [n, {}]));
  for (const [id, c] of covers) {
    const n = coverShard(id);
    if (!c.art || c.kind === 'none') { shards.get(n)![id] = ['n']; continue; }
    shards.get(n)![id] = [c.kind === 'artist' ? 'a' : 't', c.art, c.album ?? '', c.year ?? 0, c.source ?? '', c.url ?? ''];
  }
  return shards;
}
/** A song's row in a shard file: kind (`t` track, `a` artist, `n` none), art, album, year, source, source page. */
export type CoverRow = [string, string?, string?, number?, string?, string?];
/** A shard row read back as a Cover. */
export const coverOfRow = ([kind, art, album, year, source, url]: CoverRow): Cover =>
  kind === 'n' ? { kind: 'none' } : { kind: kind === 'a' ? 'artist' : 'track', art, ...(album ? { album } : {}), ...(year ? { year } : {}), ...(source ? { source } : {}), ...(url ? { url } : {}) };

/** The catalogue as the app reads it: a song's cover from its file, fetched once, on first need. */
export interface CoverCatalogue {
  /** The cover, if its file has been read: for drawing without waiting. */
  peek(id: string): ArtInfo | null;
  /**
   * The cover, reading its file when needed: `{ kind: 'placeholder' }` when the catalogue knows the song has none,
   * null when it does not know the song (added since, or its file cannot be read).
   */
  get(id: string): Promise<ArtInfo | null>;
}
export function coverCatalogue(fileUrl: (shard: number) => string, load: (url: string) => Promise<unknown> = (url) => fetch(url).then((r) => (r.ok ? r.json() : null))): CoverCatalogue {
  const files = new Map<number, Promise<Record<string, CoverRow> | null>>();
  const read = new Map<number, Record<string, CoverRow>>();
  const file = (n: number) => {
    let job = files.get(n);
    if (!job) {
      job = load(fileUrl(n)).then((rows) => (rows && typeof rows === 'object' ? rows as Record<string, CoverRow> : null), () => null);
      files.set(n, job);
      void job.then((rows) => { if (rows) read.set(n, rows); }); // an unreadable file stays unread: the providers are asked instead
    }
    return job;
  };
  const fromRow = (row: CoverRow | undefined): ArtInfo | null => (!row ? null : row[0] === 'n' ? { kind: 'placeholder' } : coverInfo(coverOfRow(row)));
  return {
    peek: (id) => { const info = fromRow(read.get(coverShard(id))?.[id]); return info?.art ? info : null; },
    get: async (id) => fromRow((await file(coverShard(id)))?.[id]),
  };
}
