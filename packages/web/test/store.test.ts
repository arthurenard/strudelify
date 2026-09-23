import { describe, it, expect } from 'vitest';
import { saveRow, trimRows, stampOf, MAX_ROWS } from '../src/store.js';

/** An in-memory Storage with an optional quota in rows. */
function storage(quota = Infinity): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { if (!m.has(k) && m.size >= quota) throw new DOMException('full', 'QuotaExceededError'); m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear(),
  };
}
const row = (ts: number) => JSON.stringify({ art: 'x', ts });

describe('per-song rows in localStorage', () => {
  it('keeps the newest rows of each kind and leaves other keys alone', () => {
    const ls = storage();
    ls.setItem('recent', '["a"]');
    for (let i = 0; i < MAX_ROWS + 30; i++) { ls.setItem(`art:v3:${i}`, row(i)); ls.setItem(`tint:${i}`, JSON.stringify({ tint: 'red', ts: i })); }
    trimRows(ls);
    const keys = Array.from({ length: ls.length }, (_, i) => ls.key(i)!);
    expect(keys.filter((k) => k.startsWith('art:v3:'))).toHaveLength(MAX_ROWS);
    expect(keys.filter((k) => k.startsWith('tint:'))).toHaveLength(MAX_ROWS);
    expect(ls.getItem('art:v3:0')).toBeNull();
    expect(ls.getItem(`art:v3:${MAX_ROWS + 29}`)).not.toBeNull();
    expect(ls.getItem('recent')).toBe('["a"]');
  });
  it('makes room from the oldest rows when the quota is full, so the write still lands', () => {
    const ls = storage(10);
    ls.setItem('code-wrap', '1');
    for (let i = 0; i < 9; i++) ls.setItem(`art:v3:${i}`, row(i));
    expect(saveRow(ls, 'art:v3:new', row(100))).toBe(true);
    expect(ls.getItem('art:v3:new')).not.toBeNull();
    expect(ls.getItem('art:v3:0')).toBeNull();
    expect(ls.getItem('code-wrap')).toBe('1');
  });
  it('treats rows without a stamp (older versions) as the oldest', () => {
    expect(stampOf('hsl(10 50% 40%)')).toBe(0);
    expect(stampOf('{"ts":5}')).toBe(5);
    expect(stampOf('{broken')).toBe(0);
    expect(stampOf(null)).toBe(0);
  });
});
