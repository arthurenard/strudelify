/**
 * Boot, hash routing, global keyboard shortcuts and the landing page. The rest lives in
 * search.ts (index + palette), song.ts (open + hero + options), player.ts (transport), timeline.ts (lanes)
 * and code.ts (editor + actions); state.ts holds the shared state and dom.ts the element handles.
 */
import { lookupThumbnail, peekArt, thumbnailUrl, type ArtInfo } from './art.js';
import { el, prefersReducedMotion } from './dom.js';
import { state } from './state.js';
import { getIndex, onIndex, onChoose, onPreview, focusSearch, closeSearch, entryById } from './search.js';
import { exampleCard, browseLabel, searchPlaceholder, pickLandingExamples, LANDING_POOL_ID, type LandingEntry, type CardEntry } from './landing.js';
import { choose, showSection, prefetchArt } from './song.js';
import { play, stop, seek, currentBar, rewind } from './player.js';
import { bindTimeline } from './timeline.js';
import { displayArtist, tidyHits, idWords } from './ui.js';

bindTimeline({ seek, currentBar, toggle: () => { if (state.started) void stop(); else void play(); } });
onChoose(choose);
onPreview(prefetchArt);

// ---------- keyboard ----------
function isTypingTarget(t: EventTarget | null): boolean {
  const node = t as HTMLElement | null;
  if (!node) return false;
  return node instanceof HTMLInputElement || node instanceof HTMLSelectElement || node instanceof HTMLTextAreaElement ||
    node.isContentEditable || !!node.closest?.('.cm-editor');
}
/** Controls that act on Space themselves (a button presses, a disclosure opens, a checkbox toggles): the transport leaves them their key. */
const SPACE_CONTROLS = 'button, summary, [role="button"], [role="checkbox"], [role="switch"], [role="option"], [role="tab"], [role="menuitem"]';
document.addEventListener('keydown', (e) => {
  // A widget that handled the key (the timeline slider, the code's scrollbar) has already said so.
  if (e.defaultPrevented) return;
  if (e.metaKey || e.ctrlKey || e.altKey) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); focusSearch(); }
    return;
  }
  if (e.key === '/' && !isTypingTarget(e.target)) { e.preventDefault(); focusSearch(); return; }
  const cur = state.current;
  if (isTypingTarget(e.target) || !cur) return;
  if (e.code === 'Space') {
    if ((e.target as HTMLElement).closest?.(SPACE_CONTROLS)) return;
    e.preventDefault();
    if (state.started) stop(); else play();
  }
  else if (e.key === 'ArrowRight') { e.preventDefault(); seek(Math.min(cur.tl.bars - 1, currentBar() + 4)); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); seek(Math.max(0, currentBar() - 4)); }
  else if (e.key === 'Home') { e.preventDefault(); rewind(); }
});

// "Skip to content" moves the focus to the page's main content; it does not route to a "#main" song.
document.querySelector<HTMLAnchorElement>('a.skip')?.addEventListener('click', (e) => {
  e.preventDefault();
  const main = document.getElementById('main');
  if (!main) return;
  main.tabIndex = -1;
  main.focus();
  main.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
});

// ---------- landing + chrome ----------
/**
 * The song count and a pool of the 200 most-streamed library songs are baked into index.html (see
 * `bakeLanding`), so the landing page draws its four random example cards at once, without the 2.8 MB
 * index; the index loads when the browser is idle, or as soon as something needs it (search, a song link).
 * Without a baked pool (a database-less dev server) the cards wait for the index.
 */
function revealExamples() {
  el.examples.classList.remove('pending');
  el.examples.removeAttribute('aria-busy');
}
function bakedPool(): LandingEntry[] | null {
  try {
    const pool = JSON.parse(document.getElementById(LANDING_POOL_ID)?.textContent ?? 'null');
    return Array.isArray(pool) && pool.length ? pool : null;
  } catch { return null; }
}
let examplesDrawn = false;
function hydrateExamples(pool: readonly CardEntry[]) {
  if (examplesDrawn) return;
  examplesDrawn = true;
  const picks = pickLandingExamples(pool);
  const byId = new Map(picks.map((e) => [e.id, e]));
  el.examples.innerHTML = picks.map(exampleCard).join('');
  revealExamples();
  const jobs: (() => Promise<void>)[] = [];
  for (const a of Array.from(el.examples.querySelectorAll<HTMLAnchorElement>('.ex'))) {
    const e = byId.get(decodeURIComponent(a.getAttribute('href')?.slice(1) ?? ''));
    if (!e) { a.hidden = true; continue; }
    const renderCover = (info: ArtInfo) => {
      if (!info.art || info.kind !== 'track') return;
      const tile = a.querySelector<HTMLElement>('.ex-tile');
      if (!tile) return;
      const img = new Image();
      img.alt = ''; img.decoding = 'async';
      img.onload = () => tile.replaceChildren(img);
      img.src = thumbnailUrl(info.art, 160);
    };
    const artist = e.display ?? displayArtist(e.artist);
    const cached = peekArt(e.id);
    if (cached) renderCover(cached);
    else jobs.push(async () => renderCover(await lookupThumbnail(e.id, artist, e.title, e.year)));
    // Pointing at a card warms its art (so the song opens with its cover and tint in place) and the index.
    for (const ev of ['pointerenter', 'focus'] as const) a.addEventListener(ev, () => { prefetchArt({ ...e, display: artist }); void getIndex().catch(() => {}); });
  }
  // Independent lookups can progress while another provider stalls; per-host queues bound requests.
  const worker = async () => { for (let job; (job = jobs.shift());) await job(); };
  for (let i = 0; i < 4; i++) void worker();
}
onIndex((idx) => {
  el.ctaLabel.textContent = browseLabel(idx.entries.length);
  el.q.placeholder = searchPlaceholder(idx.entries.length);
  hydrateExamples(idx.entries);
});
{
  const pool = bakedPool();
  if (pool) hydrateExamples(pool);
}
// Reaching for search warms the index, so the first keystroke has results.
for (const target of [el.q, el.ctaSearch]) target.addEventListener('pointerenter', () => { void getIndex().catch(() => {}); }, { once: true });
window.addEventListener('scroll', () => el.top.classList.toggle('scrolled', window.scrollY > 8), { passive: true });

// ---------- routing ----------
async function leaveSong() {
  await stop(true);
  state.current = null;
  state.loadingId = null;
  closeSearch();
}
/** The song id in the address: the hash, decoded; a malformed escape is taken as typed, never an uncaught error. */
function hashId(): string {
  const raw = location.hash.slice(1);
  try { return decodeURIComponent(raw); } catch { return raw; }
}
async function openFromHash() {
  const id = hashId();
  // "#main" is the skip link's target, not a song (and an older link may still carry it).
  if (id === 'main') return;
  if (!id) {
    if (state.current || state.loadingId || !el.notFound.hidden) {
      await leaveSong();
      showSection('empty');
      document.title = 'Strudelify';
      if (!prefersReducedMotion()) window.scrollTo({ top: 0 });
    }
    return;
  }
  const idx = await getIndex();
  const entry = entryById(id);
  if (entry) {
    if (state.current?.entry.id !== entry.id && state.loadingId !== entry.id) choose(entry);
    return;
  }
  await leaveSong();
  const words = idWords(id);
  el.nfId.textContent = words;
  const near = tidyHits(idx.search(words, 8), words).slice(0, 4);
  el.nfLedeMore.hidden = !near.length;
  el.nfMatches.innerHTML = near.map(exampleCard).join('');
  showSection('notfound');
  document.title = 'Song not found · Strudelify';
}
window.addEventListener('hashchange', () => { openFromHash().catch(() => { /* the banner shows the error */ }); });
onIndex(() => { openFromHash().catch(() => { /* the banner shows the error */ }); });
/** Run `fn` once the browser has nothing more urgent to do (after the landing page is drawn), or after `timeout` ms. */
function whenIdle(fn: () => void, timeout = 3000) {
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(fn, { timeout });
  else setTimeout(fn, 1500);
}
// A song link needs the index now; the landing page only needs it for search, so it waits for an idle moment.
if (hashId() && hashId() !== 'main') getIndex().catch(() => { revealExamples(); });
else whenIdle(() => { getIndex({ quiet: true }).catch(() => { revealExamples(); /* the banner shows the error; the cards stay */ }); });
