/**
 * DOM handles and the small chrome widgets (status slot, error banner, toast) shared by every module.
 * Elements are looked up once at boot; a missing id is a build error, not a runtime surprise.
 */
import { esc } from './ui.js';

export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

export const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
export const isMobile = () => window.matchMedia('(max-width: 767px)').matches;

export const el = {
  // header + search
  q: $<HTMLInputElement>('q'),
  qClear: $<HTMLButtonElement>('q-clear'),
  resultsPanel: $<HTMLDivElement>('results-panel'),
  results: $<HTMLUListElement>('results'),
  resultsFoot: $<HTMLDivElement>('results-foot'),
  status: $<HTMLSpanElement>('status'),
  // banner
  banner: $<HTMLDivElement>('banner'),
  bannerText: $<HTMLSpanElement>('banner-text'),
  bannerRetry: $<HTMLButtonElement>('banner-retry'),
  bannerClose: $<HTMLButtonElement>('banner-close'),
  // sections
  song: $<HTMLElement>('song'),
  empty: $<HTMLElement>('empty'),
  notFound: $<HTMLElement>('notfound'),
  // hero
  title: $<HTMLHeadingElement>('title'),
  artist: $<HTMLParagraphElement>('artist'),
  album: $<HTMLParagraphElement>('album'),
  chips: $<HTMLDivElement>('chips'),
  art: $<HTMLImageElement>('art'),
  artFallback: $<HTMLDivElement>('art-fallback'),
  // transport
  play: $<HTMLButtonElement>('play'),
  rewind: $<HTMLButtonElement>('rewind'),
  posTime: $<HTMLSpanElement>('pos-time'),
  totalTime: $<HTMLSpanElement>('total-time'),
  posBar: $<HTMLSpanElement>('pos-bar'),
  posChord: $<HTMLSpanElement>('pos-chord'),
  posSrc: $<HTMLSpanElement>('pos-src'),
  posSec: $<HTMLSpanElement>('pos-sec'),
  // options
  optMelody: $<HTMLLabelElement>('opt-melody'),
  optBars: $<HTMLLabelElement>('opt-bars'),
  optNote: $<HTMLSpanElement>('opt-note'),
  optsSkel: $<HTMLDivElement>('opts-skel'),
  optNoteText: $<HTMLSpanElement>('opt-note-text'),
  melodyLabel: $<HTMLSpanElement>('melody-label'),
  melody: $<HTMLInputElement>('melody'),
  maxBars: $<HTMLSelectElement>('maxBars'),
  codeStyle: $<HTMLSelectElement>('code-style'),
  // timeline
  timeline: $<HTMLDivElement>('timeline'),
  tlScroll: $<HTMLDivElement>('tl-scroll'),
  tlInner: $<HTMLDivElement>('tl-inner'),
  track: $<HTMLDivElement>('track'),
  fill: $<HTMLDivElement>('fill'),
  knob: $<HTMLDivElement>('knob'),
  playhead: $<HTMLDivElement>('playhead'),
  hover: $<HTMLDivElement>('hover'),
  laneRuler: $<HTMLDivElement>('lane-ruler'),
  laneSections: $<HTMLDivElement>('lane-sections'),
  laneChords: $<HTMLDivElement>('lane-chords'),
  overview: $<HTMLDivElement>('tl-overview'),
  ovLanes: $<HTMLDivElement>('ov-lanes'),
  ovWin: $<HTMLDivElement>('ov-win'),
  ovPos: $<HTMLDivElement>('ov-pos'),
  // code
  editor: $<HTMLElement>('editor'),
  open: $<HTMLAnchorElement>('open'),
  download: $<HTMLAnchorElement>('download'),
  copy: $<HTMLButtonElement>('copy'),
  wrap: $<HTMLButtonElement>('wrap'),
  hbar: $<HTMLDivElement>('hbar'),
  hbarTrack: $<HTMLDivElement>('hbar-track'),
  hbarThumb: $<HTMLDivElement>('hbar-thumb'),
  codeToggle: $<HTMLButtonElement>('code-toggle'),
  codeBody: $<HTMLDivElement>('code-body'),
  codeLines: $<HTMLSpanElement>('code-lines'),
  codeMore: $<HTMLDivElement>('code-more'),
  codeExpand: $<HTMLButtonElement>('code-expand'),
  codeExpandLabel: $<HTMLSpanElement>('code-expand-label'),
  // landing + not found
  examples: $<HTMLDivElement>('examples'),
  ctaSearch: $<HTMLButtonElement>('cta-search'),
  ctaLabel: $<HTMLSpanElement>('cta-label'),
  nfSearch: $<HTMLButtonElement>('nf-search'),
  nfId: $<HTMLElement>('nf-id'),
  nfLedeMore: $<HTMLSpanElement>('nf-lede-more'),
  nfMatches: $<HTMLDivElement>('nf-matches'),
  more: $<HTMLElement>('more'),
  moreArtist: $<HTMLAnchorElement>('more-artist'),
  moreSongs: $<HTMLDivElement>('more-songs'),
  toast: $<HTMLDivElement>('toast'),
  top: document.querySelector<HTMLElement>('.top')!,
};

// ---------- toast ----------
const ICONS = {
  ok: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  error: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M12 8v5M12 16h.01" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  info: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
let toastTimer: number | undefined;
export function toast(message: string, kind: keyof typeof ICONS = 'ok') {
  el.toast.innerHTML = `${ICONS[kind]}<span>${esc(message)}</span>`;
  el.toast.className = `toast ${kind}`;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { el.toast.hidden = true; }, kind === 'error' ? 3200 : 1800);
}

/** The header status slot only ever shows progress ("Loading…", "Analysing…"); errors go to the banner. */
export function setStatus(text: string) { el.status.textContent = text; }

// ---------- banner ----------
let retryAction: (() => void) | null = null;
/** Show a message with, optionally, one action (Retry by default). */
export function showBanner(message: string, retry?: () => void, actionLabel = 'Retry') {
  el.bannerText.textContent = message;
  retryAction = retry ?? null;
  el.bannerRetry.hidden = !retry;
  el.bannerRetry.textContent = actionLabel;
  el.banner.hidden = false;
}
export function hideBanner() { el.banner.hidden = true; retryAction = null; }
el.bannerRetry.addEventListener('click', () => { const r = retryAction; hideBanner(); r?.(); });
el.bannerClose.addEventListener('click', hideBanner);
