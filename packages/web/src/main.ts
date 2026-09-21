/**
 * Boot, hash routing, global keyboard shortcuts and the landing page. The rest lives in
 * search.ts (index + palette), song.ts (open + hero + options), player.ts (transport), timeline.ts (lanes)
 * and code.ts (editor + actions); state.ts holds the shared state and dom.ts the element handles.
 */
import { lookupThumbnail, peekArt, thumbnailUrl, type ArtInfo } from './art.js';
import { el, prefersReducedMotion } from './dom.js';
import { state } from './state.js';
import { getIndex, onIndex, onChoose, onPreview, focusSearch, closeSearch, entryById } from './search.js';
import { exampleCard, browseLabel, searchPlaceholder, pickLandingExamples } from './landing.js';
import { choose, showSection, prefetchArt } from './song.js';
import { play, stop, seek, currentBar, rewind } from './player.js';
import { bindTimeline } from './timeline.js';
import { displayArtist, tidyHits, idWords } from './ui.js';

bindTimeline({ seek, currentBar });
onChoose(choose);
onPreview(prefetchArt);

// ---------- keyboard ----------
function isTypingTarget(t: EventTarget | null): boolean {
  const node = t as HTMLElement | null;
  if (!node) return false;
  return node instanceof HTMLInputElement || node instanceof HTMLSelectElement || node instanceof HTMLTextAreaElement ||
    node.isContentEditable || !!node.closest?.('.cm-editor');
}
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); focusSearch(); }
    return;
  }
  if (e.key === '/' && !isTypingTarget(e.target)) { e.preventDefault(); focusSearch(); return; }
  const cur = state.current;
  if (isTypingTarget(e.target) || !cur) return;
  if (e.code === 'Space') {
    // The Play button handles its own Space (as a click); anywhere else Space is the transport toggle, not a click.
    if ((e.target as HTMLElement).closest?.('#play')) return;
    e.preventDefault();
    if (state.started) stop(); else play();
  }
  else if (e.key === 'ArrowRight') { e.preventDefault(); seek(Math.min(cur.tl.bars - 1, currentBar() + 4)); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); seek(Math.max(0, currentBar() - 4)); }
  else if (e.key === 'Home') { e.preventDefault(); rewind(); }
});

// ---------- landing + chrome ----------
/**
 * The song count is baked into index.html; the four example cards stay hidden until the index is in,
 * then a random sample from the 200 most-streamed library songs is drawn and wired to load art.
 */
function revealExamples() {
  el.examples.classList.remove('pending');
  el.examples.removeAttribute('aria-busy');
}
function hydrateExamples() {
  const idx = state.index;
  if (!idx) return;
  el.examples.innerHTML = pickLandingExamples(idx.entries).map(exampleCard).join('');
  revealExamples();
  const jobs: (() => Promise<void>)[] = [];
  for (const a of Array.from(el.examples.querySelectorAll<HTMLAnchorElement>('.ex'))) {
    const e = entryById(decodeURIComponent(a.getAttribute('href')?.slice(1) ?? ''));
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
    const cached = peekArt(e.id);
    if (cached) renderCover(cached);
    else jobs.push(async () => renderCover(await lookupThumbnail(e.id, displayArtist(e.artist), e.title, e.year)));
    // Pointing at a card warms its art, so the song opens with its cover and tint in place.
    for (const ev of ['pointerenter', 'focus'] as const) a.addEventListener(ev, () => { prefetchArt(e); });
  }
  // Independent lookups can progress while another provider stalls; per-host queues bound requests.
  const worker = async () => { for (let job; (job = jobs.shift());) await job(); };
  for (let i = 0; i < 4; i++) void worker();
}
onIndex((idx) => {
  el.ctaLabel.textContent = browseLabel(idx.entries.length);
  el.q.placeholder = searchPlaceholder(idx.entries.length);
  hydrateExamples();
});
window.addEventListener('scroll', () => el.top.classList.toggle('scrolled', window.scrollY > 8), { passive: true });

// ---------- routing ----------
async function leaveSong() {
  await stop(true);
  state.current = null;
  state.loadingId = null;
  closeSearch();
}
async function openFromHash() {
  const id = decodeURIComponent(location.hash.slice(1));
  if (!id || id === 'main') {
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
window.addEventListener('hashchange', openFromHash);
onIndex(() => { openFromHash().catch(() => { /* the banner shows the error */ }); });
getIndex().catch(() => { revealExamples(); /* the banner shows the error; fallback cards stay */ });
