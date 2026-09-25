/**
 * The song index and the command-palette search: loading, ranking for display, rendering rows,
 * keyboard navigation. Picking a row calls the handler registered with `onChoose`.
 */
import { createIndex, type IndexEntry, type SongIndex } from '@strudelify/core';
import { el, setStatus, showBanner } from './dom.js';
import { state } from './state.js';
import { lookupThumbnail, peekArt, thumbnailUrl, type ArtInfo } from './art.js';
import {
  esc, songTint, initial, highlightTokens, highlight, buildArtistIndex, artistMatch, queryLooksLikeTitle, byPopularity,
  displayArtist, tidyHits, rowFacts, setArtistAliases, canonicalArtists, type ArtistGroup,
} from './ui.js';

// ---------- index ----------
let indexPromise: Promise<SongIndex> | null = null;
/** Callbacks run once the index is in (landing hydration, routing). */
const indexListeners: ((idx: SongIndex) => void)[] = [];
export function onIndex(fn: (idx: SongIndex) => void) { if (state.index) fn(state.index); else indexListeners.push(fn); }
/** Entries by id, built once with the index (routing, the landing cards and the Recent group all look ids up). */
let byId = new Map<string, IndexEntry>();
export const entryById = (id: string): IndexEntry | undefined => byId.get(id);

/** The song index, fetched once. `quiet`: a background load (the landing page at idle) shows no progress in the header. */
export function getIndex({ quiet = false } = {}): Promise<SongIndex> {
  if (state.index) return Promise.resolve(state.index);
  if (indexPromise) return indexPromise;
  if (!quiet) setStatus('Loading…');
  indexPromise = (async () => {
    const res = await fetch(`${import.meta.env.BASE_URL}db/index.json`);
    if (!res.ok) throw new Error(`index.json: HTTP ${res.status}`);
    const entries: IndexEntry[] = await res.json();
    const idx = createIndex(entries);
    byId = new Map(entries.map((e) => [e.id, e]));
    state.index = idx;
    setArtistAliases(canonicalArtists(entries)); // one spelling per artist before anything groups or displays them
    state.artistIndex = buildArtistIndex(entries);
    state.indexError = null;
    setStatus('');
    for (const fn of indexListeners.splice(0)) fn(idx);
    return idx;
  })().catch((e: Error) => {
    state.indexError = e.message;
    indexPromise = null;
    setStatus('');
    showBanner(`The song database could not be loaded (${e.message}).`, () => { getIndex().catch(() => {}); });
    throw e;
  });
  return indexPromise;
}

// ---------- results ----------
interface Row { entry: IndexEntry; el: HTMLLIElement }
let rows: Row[] = [];
let activeRow = -1;
let searchSeq = 0;
let searchTimer: number | undefined;
/** The query the rows on screen answer ('' for the default palette). */
let shownQuery = '';
let chooseHandler: (entry: IndexEntry) => void = () => {};
export function onChoose(fn: (entry: IndexEntry) => void) { chooseHandler = fn; }
/** Called (debounced) for the highlighted row, so the song's art can be fetched before it is opened. */
let previewHandler: (entry: IndexEntry) => void = () => {};
export function onPreview(fn: (entry: IndexEntry) => void) { previewHandler = fn; }
let previewTimer: number | undefined;

// Only visible rows fetch artwork. Provider queues still enforce their individual rate limits. The lookups
// belong to the rows on screen: replacing the rows or closing the palette cancels the ones still running.
let coverQueue: Row[] = [];
let coverLoads = 0;
let coverCtrl = new AbortController();
function cancelCovers() {
  coverCtrl.abort();
  coverCtrl = new AbortController();
  coverQueue = [];
}
const coverObserver = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
  for (const item of entries) if (item.isIntersecting) {
    coverObserver!.unobserve(item.target);
    const row = rows.find(row => row.el === item.target);
    if (row) {
      const cached = peekArt(row.entry.id);
      if (cached) renderRowCover(row, cached);
      else coverQueue.push(row);
    }
  }
  loadRowCovers();
}, { root: el.results });

function renderRowCover(row: Row, info: ArtInfo) {
  if (!row.el.isConnected || info.kind !== 'track' || !info.art) return;
  const tile = row.el.querySelector<HTMLElement>('.opt-tile')!;
  const img = new Image();
  img.alt = ''; img.decoding = 'async'; img.width = 40; img.height = 40;
  img.onload = () => { if (row.el.isConnected) tile.replaceChildren(img); };
  img.src = thumbnailUrl(info.art);
}

function loadRowCovers() {
  if (el.resultsPanel.hidden) return;
  while (coverLoads < 4 && coverQueue.length) {
    const row = coverQueue.shift()!;
    if (!row.el.isConnected) continue;
    coverLoads++;
    const e = row.entry;
    void lookupThumbnail(e.id, displayArtist(e.artist), e.title, e.year, coverCtrl.signal)
      .then(info => renderRowCover(row, info))
      .catch(() => {}).finally(() => { coverLoads--; loadRowCovers(); });
  }
}

// ---------- recent ----------
const RECENT_KEY = 'recent';
const RECENT_MAX = 4;
function recentIds(): string[] {
  try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; }
}
/** Remember an opened song for the palette's Recent group. */
export function rememberRecent(id: string) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recentIds().filter((x) => x !== id)].slice(0, RECENT_MAX))); } catch { /* ignore */ }
}

function openPanel(open: boolean) {
  el.resultsPanel.hidden = !open;
  if (open) loadRowCovers();
  el.q.setAttribute('aria-expanded', String(open));
  if (!open) { el.q.removeAttribute('aria-activedescendant'); activeRow = -1; }
}
/** Close the palette and clear the box (a song was picked or left); a search still pending is dropped with it. */
export function closeSearch() {
  clearTimeout(searchTimer);
  searchSeq++;
  cancelCovers();
  openPanel(false);
  el.q.value = '';
  el.qClear.hidden = true;
}
export const focusSearch = () => { el.q.focus(); el.q.select(); };
/** Put `text` in the search box and show its results. */
export function searchFor(text: string) {
  el.q.value = text;
  el.q.focus();
  void runSearch();
}

const sourceBadges = (e: IndexEntry) =>
  `<span class="badges">${e.sources.includes('midi') ? '<span class="badge midi">MIDI</span>' : ''}${e.sources.includes('mcgill') ? '<span class="badge chords">Chords</span>' : ''}</span>`;


/**
 * One row: tile · title / artist · badges / year · key · bpm. Each slot always means the same thing: the
 * subtitle is the artist and the right-hand column the facts (year, key, tempo), so the eye scans one column
 * for one kind of thing and rows never jitter (both lines of both columns are always laid out, empty or not).
 * Inside an artist group the heading already names the artist, so the facts move up into the subtitle: no row
 * is ever a title over a blank line, on phones (where the right column is dropped) included.
 */
function rowHtml(e: IndexEntry, tokens: string[], inGroup: boolean): string {
  const facts = rowFacts(e);
  const sub = inGroup ? esc(facts) : highlight(displayArtist(e.artist), tokens);
  return `<span class="opt-tile" style="--tile:${songTint(e)}">${esc(initial(e.title))}</span>` +
    `<span class="opt-main"><span class="t">${highlight(e.title, tokens)}</span><span class="a${inGroup ? ' facts' : ''}">${sub}</span></span>` +
    `<span class="opt-meta">${sourceBadges(e)}<span class="opt-kv">${inGroup ? '' : esc(facts)}</span></span>`;
}

function resetRows() {
  coverObserver?.disconnect();
  cancelCovers();
  el.results.innerHTML = '';
  rows = [];
  activeRow = -1;
}
function makeRow(e: IndexEntry, tokens: string[], inGroup = false) {
    const li = document.createElement('li');
    li.className = 'opt';
    li.setAttribute('role', 'option');
    li.id = `opt-${rows.length}`;
    li.innerHTML = rowHtml(e, tokens, inGroup);
    const i = rows.length;
    li.addEventListener('pointerdown', (ev) => ev.preventDefault()); // keep focus in the input
    li.addEventListener('click', () => choose(e));
    li.addEventListener('pointermove', () => { if (activeRow !== i) setActiveRow(i, false); });
    el.results.appendChild(li);
    const row = { entry: e, el: li };
    rows.push(row);
    if (coverObserver) coverObserver.observe(li); else coverQueue.push(row);
}
function addGroup(label: string, count?: string) {
  const li = document.createElement('li');
  li.className = 'group';
  li.setAttribute('role', 'presentation');
  li.innerHTML = `<b>${esc(label)}</b>${count ? `<span class="count">${esc(count)}</span>` : ''}`;
  el.results.appendChild(li);
}
const KEYS_HINT = `<span class="keys"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span></span>`;

/**
 * The palette before anything is typed (the box focused, or the landing CTA): the songs opened recently and
 * the most popular ones in the database, so there is always something to pick from.
 */
function renderDefault() {
  const idx = state.index;
  if (!idx) return;
  resetRows();
  const recent = recentIds().map(entryById).filter((e): e is IndexEntry => !!e);
  if (recent.length) { addGroup('Recent'); for (const e of recent) makeRow(e, []); }
  const own = new Set(recent.map((e) => e.id));
  addGroup('Popular', 'most transcribed');
  for (const e of byPopularity(idx.entries).filter((e) => !own.has(e.id)).slice(0, recent.length ? 6 : 8)) makeRow(e, []);
  el.resultsFoot.innerHTML = `<span>${idx.entries.length.toLocaleString('en-US')} library entries · type to search</span>${KEYS_HINT}`;
  shownQuery = '';
  openPanel(true);
  if (rows.length) setActiveRow(0, false);
}

function renderResults(text: string, hits: IndexEntry[]) {
  const tokens = highlightTokens(text);
  const total = state.index?.entries.length ?? 0;
  resetRows();
  const addRow = (e: IndexEntry, inGroup = false) => makeRow(e, tokens, inGroup);

  // An artist the query names exactly leads; a mere prefix of one ("love" → Loverboy) is listed after
  // the direct title hits when the query reads as a title, so the first row always matches what was typed.
  const am = artistMatch(text, state.artistIndex);
  const artistFirst = !!am && (am.exact || !queryLooksLikeTitle(text, hits));
  const addArtist = (artist: ArtistGroup, after: boolean) => {
    const songs = tidyHits(byPopularity(artist.entries), '');
    addGroup(after ? `Artist · ${artist.name}` : artist.name, `${songs.length} song${songs.length === 1 ? '' : 's'}`);
    for (const e of songs.slice(0, after ? 4 : 8)) addRow(e, true);
  };
  if (am && artistFirst) {
    addArtist(am.group, false);
    const own = new Set(am.group.entries.map((e) => e.id));
    const rest = hits.filter((h) => !own.has(h.id)).slice(0, 5);
    if (rest.length) { addGroup('More results'); for (const e of rest) addRow(e); }
  } else if (am) {
    const own = new Set(am.group.entries.map((e) => e.id));
    for (const e of hits.filter((h) => !own.has(h.id)).slice(0, 8)) addRow(e);
    addArtist(am.group, true);
  } else if (hits.length) {
    for (const e of hits) addRow(e);
  } else {
    el.results.innerHTML = `<li class="msg" role="presentation">No songs match <strong>“${esc(text)}”</strong><small>Try a shorter title, the artist's name, or check the spelling.</small></li>`;
  }
  el.resultsFoot.innerHTML = rows.length
    ? `<span>${rows.length} results · ${total.toLocaleString('en-US')} library entries</span>${KEYS_HINT}`
    : `<span>${total.toLocaleString('en-US')} library entries</span>`;
  openPanel(true);
  if (rows.length) setActiveRow(0, false);
}

function setActiveRow(i: number, scroll = true) {
  activeRow = i;
  rows.forEach((r, k) => { r.el.classList.toggle('active', k === i); r.el.setAttribute('aria-selected', String(k === i)); });
  if (i >= 0) {
    el.q.setAttribute('aria-activedescendant', rows[i].el.id);
    if (scroll) rows[i].el.scrollIntoView({ block: 'nearest' });
    clearTimeout(previewTimer);
    const entry = rows[i].entry;
    previewTimer = window.setTimeout(() => previewHandler(entry), 250);
  }
}

function choose(entry: IndexEntry) {
  closeSearch();
  chooseHandler(entry); // moves focus on to the player
}

async function runSearch() {
  const text = el.q.value.trim();
  el.qClear.hidden = !el.q.value;
  if (!text) { if (document.activeElement === el.q && state.index) renderDefault(); else openPanel(false); return; }
  const seq = ++searchSeq;
  try {
    const idx = await getIndex();
    if (seq !== searchSeq || el.q.value.trim() !== text) return;
    renderResults(text, tidyHits(idx.search(text, 14), text).slice(0, 12));
    shownQuery = text;
  } catch {
    el.results.innerHTML = `<li class="msg error" role="presentation">Could not load the song database<small>${esc(state.indexError ?? '')}</small></li>`;
    el.resultsFoot.innerHTML = '';
    openPanel(true);
  }
}
el.q.addEventListener('input', () => {
  el.qClear.hidden = !el.q.value;
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(runSearch, 120);
});
el.q.addEventListener('focus', () => {
  if (el.q.value.trim()) { if (rows.length) openPanel(true); }
  else getIndex().then(() => { if (document.activeElement === el.q && !el.q.value.trim()) renderDefault(); }).catch(() => {});
});
el.q.addEventListener('blur', () => { window.setTimeout(() => openPanel(false), 120); });
el.q.addEventListener('keydown', (e) => {
  const open = !el.resultsPanel.hidden;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!open) { runSearch(); return; }
    if (!rows.length) return;
    const n = rows.length;
    setActiveRow(e.key === 'ArrowDown' ? (activeRow + 1) % n : (activeRow - 1 + n) % n);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    // Rows still showing an earlier query (typed faster than the search delay) are not what Enter means:
    // search what is in the box now, then open its first result.
    if (open && rows.length && shownQuery === el.q.value.trim()) choose(rows[Math.max(0, activeRow)].entry);
    else {
      clearTimeout(searchTimer);
      const text = el.q.value.trim();
      void runSearch().then(() => { if (text && shownQuery === text && el.q.value.trim() === text && rows.length) choose(rows[0].entry); });
    }
  } else if (e.key === 'Escape') {
    if (open) openPanel(false); else el.q.blur();
  } else if (e.key === 'Tab') openPanel(false);
});
// Pressing the clear button must not blur the box: its blur would close the palette the click reopens.
el.qClear.addEventListener('pointerdown', (e) => e.preventDefault());
el.qClear.addEventListener('click', () => { clearTimeout(searchTimer); searchSeq++; el.q.value = ''; el.qClear.hidden = true; el.q.focus(); renderDefault(); });
el.ctaSearch.addEventListener('click', focusSearch);
el.nfSearch.addEventListener('click', focusSearch);

