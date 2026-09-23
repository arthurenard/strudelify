/**
 * The code section: editor theming, wrap toggle, collapse, copy / download / open-in-strudel.cc.
 * The actions take what the editor holds, so a user's edits are what gets copied, saved or opened.
 */
import { shareUrl, MAX_SHARE_URL } from '@strudelify/core';
import { el, toast, isMobile } from './dom.js';
import { state } from './state.js';
import { ed } from './repl.js';

let shownId = '';
let lineCount = 0;
let editorConfigured = false;
/** The code last put in the editor: anything else there is the user's edit. */
let generated = '';

/** The code the editor holds: the generated code, or the user's edits to it. */
export const editorCode = (): string => ed()?.code ?? state.current?.code ?? '';
/** Whether the user has changed the code in the editor since it was generated. */
export const hasEdits = (): boolean => !!ed() && ed()!.code !== generated;
/** Put code back in the editor as the user's own (after an option change regenerated it). */
export function restoreEdits(code: string) {
  ed()?.setCode(code);
  syncActions();
}

/** Put generated code in the editor and point the actions at it. */
export function showCode(code: string, id: string) {
  if (ed() && !editorConfigured) { applyWrap(); editorConfigured = true; }
  generated = code;
  ed()?.setCode(code);
  el.download.download = `${id}.strudel.js`;
  syncActions(code);
  lineCount = code.split('\n').length;
  el.codeLines.textContent = `${lineCount} lines`;
  if (id !== shownId) { shownId = id; setExpanded(false); } // a new song starts folded; recompiles keep the choice
  requestAnimationFrame(syncCap);
}

/** Forget the shown song while the next one loads: the line count, the "Show all N lines" button and the actions. */
export function clearCode() {
  shownId = '';
  lineCount = 0;
  el.codeLines.textContent = '';
  el.codeMore.hidden = true;
  el.codeBody.classList.remove('capped');
  el.hbar.hidden = true;
  el.codeBody.classList.remove('overflowing');
  el.open.removeAttribute('href');
  el.open.removeAttribute('aria-disabled');
  if (el.download.href.startsWith('blob:')) URL.revokeObjectURL(el.download.href);
  el.download.removeAttribute('href');
  actionsCode = null;
  generated = '';
  setExpanded(false);
}

// ---------- actions ----------
/** The code the Download and Open links currently point at. */
let actionsCode: string | null = null;
const OPEN_TITLE = el.open.title;
/**
 * Point Download and Open at `code` (by default, what the editor holds now). A program longer than a
 * browser takes in a link cannot travel to strudel.cc in the URL: the link is disabled and says why.
 */
function syncActions(code = editorCode()) {
  if (code === actionsCode) return;
  actionsCode = code;
  if (el.download.href.startsWith('blob:')) URL.revokeObjectURL(el.download.href);
  el.download.href = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  const url = shareUrl(code);
  if (url.length <= MAX_SHARE_URL) {
    el.open.href = url;
    el.open.removeAttribute('aria-disabled');
    el.open.title = OPEN_TITLE;
  } else {
    el.open.removeAttribute('href');
    el.open.setAttribute('aria-disabled', 'true');
    el.open.title = `This code is too long to open in strudel.cc by link (${Math.round(url.length / 1024 / 1024 * 10) / 10} MB). Download it and paste it into strudel.cc instead.`;
  }
}
// The links follow the editor: refreshed as the pointer or the focus reaches them, and again on the click itself.
for (const link of [el.open, el.download]) {
  for (const ev of ['pointerenter', 'focus', 'pointerdown'] as const) link.addEventListener(ev, () => { if (state.current) syncActions(); });
}
el.open.addEventListener('click', (e) => {
  if (!state.current) { e.preventDefault(); return; }
  syncActions();
  if (el.open.getAttribute('aria-disabled') === 'true') { e.preventDefault(); toast('Too long to open by link: download the code and paste it into strudel.cc', 'error'); }
});

// ---------- height cap ----------
/**
 * A long file is capped at about 600px with a fade and a "Show all N lines" button, so a 60-line song does not
 * push the footer off the page; expanded, the editor grows to its content and the page scrolls (as on strudel.cc).
 * Phones never get a nested vertical scroller (CSS lifts the cap there), so the button only appears when the cap bites.
 */
let expanded = false;
const moreLabel = () => (lineCount ? `Show all ${lineCount} lines` : 'Show all lines');
function setExpanded(v: boolean) {
  expanded = v;
  el.codeBody.classList.toggle('expanded', v);
  el.codeExpand.setAttribute('aria-expanded', String(v));
  el.codeExpandLabel.textContent = v ? 'Show less' : moreLabel();
  requestAnimationFrame(() => { ed()?.editor?.requestMeasure?.(); syncCap(); });
}
function syncCap() {
  const sc = scroller();
  const capped = !!sc && !expanded && sc.scrollHeight > sc.clientHeight + 2;
  el.codeBody.classList.toggle('capped', capped);
  el.codeMore.hidden = !(capped || expanded);
  if (!expanded) el.codeExpandLabel.textContent = moreLabel();
  syncHbar();
}
el.codeExpand.addEventListener('click', () => {
  const top = el.codeExpand.getBoundingClientRect().top;
  setExpanded(!expanded);
  // Folding back: keep the code header in view rather than leaving the viewport far below the card.
  if (expanded) return;
  const head = el.codeBody.closest('.code')?.getBoundingClientRect().top ?? 0;
  if (head < 0 || top > window.innerHeight) el.codeBody.closest('.code')?.scrollIntoView({ block: 'start', behavior: 'auto' });
});
window.addEventListener('resize', () => requestAnimationFrame(syncCap), { passive: true });

el.copy.addEventListener('click', async () => {
  if (!state.current) return;
  try {
    await navigator.clipboard.writeText(editorCode());
    toast('Copied to clipboard');
    el.copy.classList.add('done');
    setTimeout(() => el.copy.classList.remove('done'), 1500);
  } catch { toast('Copy failed — select the code and copy manually', 'error'); }
});
el.download.addEventListener('click', (e) => {
  if (!state.current) { e.preventDefault(); return; }
  syncActions();
  toast(`Saved ${state.current.entry.id}.strudel.js`, 'info');
});

// ---------- collapse ----------
function setCodeOpen(open: boolean, remember = true) {
  el.codeBody.hidden = !open;
  el.codeToggle.setAttribute('aria-expanded', String(open));
  el.wrap.hidden = !open; // wrapping only matters while the code is visible
  if (remember) { try { localStorage.setItem('code-open', open ? '1' : '0'); } catch { /* ignore */ } }
  if (open) requestAnimationFrame(() => ed()?.editor?.requestMeasure?.());
}
el.codeToggle.addEventListener('click', () => setCodeOpen(el.codeBody.hidden));
// Collapsed by default on phones (the code is a wall of long lines there); the user's choice wins once made.
{
  let pref: string | null = null;
  try { pref = localStorage.getItem('code-open'); } catch { /* ignore */ }
  if (pref === '0' || (pref === null && isMobile())) setCodeOpen(false, false);
}

// ---------- horizontal scrollbar ----------
/**
 * Unwrapped note lines run to tens of thousands of pixels, and on macOS the scroll box's own bar is an overlay
 * that only appears mid-scroll, so the card draws its own always-present bar under the code: a thumb whose size
 * says how much of the line is in view, draggable (the Wrap button in the code header is the alternative).
 */
let hbarBound: HTMLElement | null = null;
const scroller = () => el.codeBody.querySelector<HTMLElement>('.cm-scroller');
function syncHbar() {
  const sc = scroller();
  const show = !!sc && !wrapLines && !el.codeBody.hidden && sc.scrollWidth > sc.clientWidth + 2;
  el.hbar.hidden = !show;
  el.codeBody.classList.toggle('overflowing', show);
  if (!sc || !show) return;
  if (hbarBound !== sc) {
    hbarBound = sc;
    sc.addEventListener('scroll', () => requestAnimationFrame(syncHbar), { passive: true });
    new ResizeObserver(() => requestAnimationFrame(syncHbar)).observe(sc);
  }
  const frac = sc.clientWidth / sc.scrollWidth;
  const trackW = el.hbarTrack.clientWidth || 1;
  const thumbW = Math.max(24, frac * trackW);
  const maxLeft = sc.scrollWidth - sc.clientWidth;
  const pos = maxLeft > 0 ? sc.scrollLeft / maxLeft : 0;
  el.hbarThumb.style.width = `${thumbW.toFixed(1)}px`;
  el.hbarThumb.style.transform = `translateX(${(pos * (trackW - thumbW)).toFixed(1)}px)`;
  el.hbarTrack.setAttribute('aria-valuenow', String(Math.round(pos * 100)));
}
let hbarDrag: { startX: number; startLeft: number } | null = null;
el.hbarTrack.addEventListener('pointerdown', (ev) => {
  const sc = scroller();
  if (!sc || ev.button !== 0) return;
  ev.preventDefault();
  el.hbarTrack.setPointerCapture(ev.pointerId);
  const r = el.hbarTrack.getBoundingClientRect();
  const thumbW = el.hbarThumb.offsetWidth;
  const onThumb = ev.target === el.hbarThumb;
  if (!onThumb) {
    // Clicking the track puts the thumb under the pointer, then the same drag continues from there.
    const pos = Math.min(1, Math.max(0, (ev.clientX - r.left - thumbW / 2) / (r.width - thumbW)));
    sc.scrollLeft = pos * (sc.scrollWidth - sc.clientWidth);
  }
  hbarDrag = { startX: ev.clientX, startLeft: sc.scrollLeft };
  el.hbarTrack.classList.add('dragging');
});
el.hbarTrack.addEventListener('pointermove', (ev) => {
  const sc = scroller();
  if (!hbarDrag || !sc) return;
  const r = el.hbarTrack.getBoundingClientRect();
  const thumbW = el.hbarThumb.offsetWidth;
  const perPx = (sc.scrollWidth - sc.clientWidth) / Math.max(1, r.width - thumbW);
  sc.scrollLeft = hbarDrag.startLeft + (ev.clientX - hbarDrag.startX) * perPx;
});
const endHbarDrag = () => { hbarDrag = null; el.hbarTrack.classList.remove('dragging'); };
el.hbarTrack.addEventListener('pointerup', endHbarDrag);
el.hbarTrack.addEventListener('pointercancel', endHbarDrag);
el.hbarTrack.addEventListener('keydown', (e) => {
  const sc = scroller();
  if (!sc) return;
  const page = sc.clientWidth * 0.8;
  if (e.key === 'ArrowRight') sc.scrollLeft += page;
  else if (e.key === 'ArrowLeft') sc.scrollLeft -= page;
  else if (e.key === 'Home') sc.scrollLeft = 0;
  else if (e.key === 'End') sc.scrollLeft = sc.scrollWidth;
  else return;
  // The keys scroll the code; they must not also seek or rewind the song (see main.ts).
  e.preventDefault();
  e.stopPropagation();
});

// ---------- wrap ----------
/**
 * Long lines do not wrap by default: a part's notes are one line each, so the file reads as a list of
 * layers with their comments (as on strudel.cc) and scrolls sideways inside the card on an always-visible
 * bar. Wrapping is one click away and remembered.
 */
let wrapLines = false;
try { const v = localStorage.getItem('code-wrap'); if (v !== null) wrapLines = v === '1'; } catch { /* ignore */ }
/** Every editor setting at once: StrudelMirror.updateSettings() resets any key that is left out. */
const editorSettings = () => ({
  theme: 'strudelTheme',
  fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 13,
  isLineNumbersDisplayed: true,
  isActiveLineHighlighted: false,
  isPatternHighlightingEnabled: true,
  isLineWrappingEnabled: wrapLines,
});
function applyWrap() {
  el.wrap.setAttribute('aria-pressed', String(wrapLines));
  el.wrap.classList.toggle('on', wrapLines);
  el.codeBody.closest('.code')?.classList.toggle('nowrap', !wrapLines);
  ed()?.updateSettings(editorSettings());
  requestAnimationFrame(() => { ed()?.editor?.requestMeasure?.(); syncCap(); });
}
el.wrap.addEventListener('click', () => {
  wrapLines = !wrapLines;
  try { localStorage.setItem('code-wrap', wrapLines ? '1' : '0'); } catch { /* ignore */ }
  applyWrap();
});

// The editor is configured on the first song, after loadRepl resolves. Importing this module
// must not fetch the synth and sample banks while the user is only browsing covers.
