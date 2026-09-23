/**
 * Per-song rows in localStorage: cover art (`art:v3:<id>`, see art.ts) and hero tints (`tint:<id>`, see
 * song.ts), written for every song opened, hovered or shown as a thumbnail. Unbounded, they would fill the
 * origin's quota (about 5 MB), and the preferences that share it (recent songs, the code panel's wrap and
 * open states) would silently stop saving. Each kind keeps its newest `MAX_ROWS` rows, by the `ts` each row
 * carries; a full quota evicts the older half of every kind and the write is tried once more.
 */

/** Rows kept per kind. */
export const MAX_ROWS = 1000;
/** The kinds of per-song rows, by key prefix. */
export const ROW_PREFIXES = ['art:v3:', 'tint:'] as const;
/** Writes between two checks of the row counts (the first write checks too). */
const CHECK_EVERY = 25;

/** When a row was written: its JSON `ts`, or 0 for a row from before rows were stamped (evicted first). */
export function stampOf(raw: string | null): number {
  if (!raw || raw[0] !== '{') return 0;
  try {
    const ts = (JSON.parse(raw) as { ts?: unknown }).ts;
    return typeof ts === 'number' ? ts : 0;
  } catch {
    return 0;
  }
}

/** Keep the newest rows of each kind: `limit(count)` of its `count` rows (by default `MAX_ROWS`). */
export function trimRows(ls: Storage, limit: (count: number) => number = () => MAX_ROWS): void {
  for (const prefix of ROW_PREFIXES) {
    const rows: { key: string; ts: number }[] = [];
    for (let i = 0; i < ls.length; i++) {
      const key = ls.key(i);
      if (key?.startsWith(prefix)) rows.push({ key, ts: stampOf(ls.getItem(key)) });
    }
    const keep = Math.max(0, limit(rows.length));
    if (rows.length <= keep) continue;
    rows.sort((a, b) => a.ts - b.ts);
    for (const { key } of rows.slice(0, rows.length - keep)) ls.removeItem(key);
  }
}

let writes = 0;
/** Store a per-song row, keeping every kind within its bound. Returns whether the row was stored. */
export function saveRow(ls: Storage, key: string, value: string): boolean {
  try {
    ls.setItem(key, value);
  } catch {
    // Quota: make room from the oldest rows and try once more (private mode refuses again, and that is fine).
    try { trimRows(ls, (count) => Math.floor(count / 2)); ls.setItem(key, value); } catch { return false; }
  }
  if (writes++ % CHECK_EVERY === 0) {
    try { trimRows(ls); } catch { /* storage went away */ }
  }
  return true;
}
