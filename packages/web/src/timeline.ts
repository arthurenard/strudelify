/**
 * The seekable timeline: ruler, section and chord lanes, slider, playhead, hover tooltip and, when the lanes
 * are wider than the card, an overview strip that shows the whole song and the window onto it.
 * `renderTimeline` rebuilds the lanes (song load, option change, resize only); `updatePosition` moves the
 * playhead every frame and touches nothing but transforms and, when the bar changes, a few text nodes.
 */
import { el, isMobile } from './dom.js';
import { state, chordLabel, type Current } from './state.js';
import {
  esc, fmt, chordBlocks, chordPhrases, sectionColor, sectionAbbrs, chordVariants, chordHue, fitLabel, rulerStep,
  timelineWidth, followScroll, packPhrases, cycleLabels, isFormLabel, formColor, type PhraseItem,
} from './ui.js';

/** Horizontal breathing room inside the scroll box, so the knob and its focus ring are whole at bar 1 (matches --tl-pad in CSS). */
const TL_PAD = 12;
/**
 * Least width per bar: phones 22px (a root label fits a one-bar block), wide screens 10px (a two-bar phrase still
 * carries its root). Longer songs than fit at that scale scroll sideways, with the overview strip as the map.
 */
const minPxPerBar = () => (isMobile() ? 22 : 10);
/** From this width per bar every block carries its own symbol; below it the lane shows harmonic phrases instead. */
const EXACT_PX = 20;

interface Handlers {
  seek(bar: number): void;
  currentBar(): number;
  /** Play or pause (Space on the slider, as on a media player's seek bar). */
  toggle(): void;
}
let handlers: Handlers = { seek: () => {}, currentBar: () => 0, toggle: () => {} };
/** The transport owns seeking; the timeline only reports where the user pointed. */
export function bindTimeline(h: Handlers) { handlers = h; }

const measureCtx = document.createElement('canvas').getContext('2d')!;
function textWidth(text: string, font: string): number {
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

/** Readout name of a section: annotated labels as written, derived form letters as "Part A". */
export const sectionName = (label: string) => (isFormLabel(label) ? `Part ${label}` : label);

let tlWidth = 0;
let zoomed = false;
let panning = false;
interface Block { el: HTMLElement; labels: HTMLElement[] }
let sectionEls: { el: HTMLElement; start: number; end: number }[] = [];
/** Chord blocks in lane order; `chordAt[bar]` is the index of the block covering that bar (-1 for none). */
let chordEls: Block[] = [];
let chordAt = new Int32Array(0);
const pct = (bar: number, bars: number) => `${((bar / bars) * 100).toFixed(4)}%`;
const viewport = () => Math.max(0, el.tlScroll.clientWidth - 2 * TL_PAD) || 800;
const range = (s: number, e: number) => (s === e ? `bar ${s + 1}` : `bars ${s + 1}–${e + 1}`);

/** Empty lanes and counters while a song loads. */
export function clearTimeline() {
  el.tlScroll.scrollLeft = 0;
  el.laneRuler.innerHTML = '';
  el.laneSections.innerHTML = '';
  el.laneChords.innerHTML = '';
  el.ovLanes.innerHTML = '';
  el.laneSections.hidden = false;
  el.laneChords.hidden = false;
  el.posTime.textContent = '0:00';
  el.totalTime.textContent = '0:00';
  el.posBar.textContent = '';
  el.posChord.textContent = '';
  el.posSec.textContent = '';
  el.posSrc.hidden = true;
  el.hover.hidden = true;
  el.timeline.classList.remove('positioned', 'zoomed', 'more-left', 'more-right', 'no-lanes');
  el.overview.hidden = true;
  el.tlInner.style.width = '';
  el.fill.style.setProperty('--p', '0');
  el.knob.style.setProperty('--x', '0px');
  el.playhead.style.setProperty('--x', '0px');
  el.track.setAttribute('aria-valuenow', '0');
  el.track.setAttribute('aria-valuetext', 'bar 1');
  tlWidth = 0;
  zoomed = false;
  positioned = false;
  lastTimeText = '';
  lastBarInt = -1;
  sectionEls = [];
  chordEls = [];
  chordAt = new Int32Array(0);
  activeChord = null;
  activeSection = null;
}

/** The song the lanes may show: the loaded one, and only while no other song is on its way in. */
const shown = (): Current | null => (state.current && state.loadingId === state.current.entry.id ? state.current : null);

export function renderTimeline() {
  const cur = shown();
  if (!cur) return;
  const { tl } = cur;
  el.hover.hidden = true; // a tooltip describing the old lanes must not survive a rebuild (the next pointer move redraws it)
  const view = viewport();
  tlWidth = timelineWidth(tl.bars, view, minPxPerBar());
  zoomed = tlWidth > view;
  el.tlInner.style.width = zoomed ? `${tlWidth}px` : '';
  el.timeline.classList.toggle('zoomed', zoomed);
  el.overview.hidden = !zoomed;
  const bars = Math.max(1, tl.bars);
  const pxPerBar = tlWidth / bars;
  const cs = getComputedStyle(document.documentElement);
  const uiFont = `700 11.5px ${cs.getPropertyValue('--font')}`;
  const monoFont = `500 11px ${cs.getPropertyValue('--mono')}`;
  el.timeline.classList.toggle('no-lanes', tl.bars === 0);
  renderRuler(cur, bars, pxPerBar);
  renderSections(cur, bars, pxPerBar, uiFont);
  renderChords(cur, bars, pxPerBar, monoFont);
  renderOverview(cur, bars);
  updateEdges();
  lastBarInt = -1; // force the active-block highlight to refresh
}

/** Bar numbers every `step` bars, never closer than ~44px. */
function renderRuler({ tl }: Current, bars: number, pxPerBar: number) {
  el.laneRuler.innerHTML = '';
  el.laneRuler.hidden = tl.bars === 0;
  if (!tl.bars) return;
  const step = rulerStep(pxPerBar);
  const frag = document.createDocumentFragment();
  for (let b = 0; b < tl.bars; b += step) {
    if (b > 0 && (tl.bars - b) * pxPerBar < 40) break; // the last stretch belongs to the end tick
    const t = document.createElement('span');
    t.className = 'tick num';
    t.style.left = pct(b, bars);
    t.textContent = String(b + 1);
    frag.appendChild(t);
  }
  // The end of the song is always numbered: a right-aligned tick with the last bar, whatever the cadence.
  if (tl.bars > 1) {
    const t = document.createElement('span');
    t.className = 'tick end num';
    t.textContent = String(tl.bars);
    frag.appendChild(t);
  }
  el.laneRuler.appendChild(frag);
}

/** A lane block is a button: pointer users click it, keyboard users tab to the lane and arrow along it. */
function makeBlock(className: string, label: string, first: boolean): HTMLElement {
  const d = document.createElement('div');
  d.className = className;
  d.setAttribute('role', 'button');
  d.setAttribute('aria-label', label);
  d.dataset.tip = label;
  d.tabIndex = first ? 0 : -1;
  return d;
}

/** Human-annotated structure (or the form read from the chords): the full label, else an abbreviation, else colour only. */
function renderSections({ tl }: Current, bars: number, pxPerBar: number, uiFont: string) {
  el.laneSections.innerHTML = '';
  el.laneSections.hidden = tl.sections.length === 0;
  sectionEls = [];
  const derived = tl.sections.length > 0 && tl.sections.every((s) => isFormLabel(s.label));
  el.laneSections.classList.toggle('form', derived);
  el.laneSections.setAttribute('aria-label', derived ? 'Form, read from the chords' : 'Sections');
  const frag = document.createDocumentFragment();
  const abbr = sectionAbbrs(tl.sections.map((s) => s.label));
  tl.sections.forEach((s, i) => {
    const end = s.startBar + s.bars;
    const tip = `${sectionName(s.label)} · ${range(s.startBar, end - 1)}${derived ? ' · repeated chord pattern' : ''}`;
    const d = makeBlock('sec', tip, i === 0);
    d.style.left = pct(s.startBar, bars);
    d.style.width = `calc(${pct(s.bars, bars)} - 2px)`;
    d.style.setProperty('--sec-color', derived ? formColor(s.label) : sectionColor(s.label));
    const w = s.bars * pxPerBar - 2;
    const short = abbr.get(s.label) ?? '';
    if (textWidth(s.label, uiFont) + 16 <= w) d.textContent = s.label;
    else if (short && textWidth(short, uiFont) + 8 <= w) { d.textContent = short; d.classList.add('abbr'); }
    frag.appendChild(d);
    sectionEls.push({ el: d, start: s.startBar, end });
  });
  el.laneSections.appendChild(frag);
}

/**
 * Chord lane. Zoomed in (≥ 20px per bar) every run of one symbol is a block with its own label, the widest
 * spelling that fits (B♭maj7/A → B♭maj7 → B♭), clipped by its block so it never covers a neighbour.
 * Zoomed out, one-bar blocks would be an unreadable barcode, so bars are grouped into harmonic phrases:
 * runs of one chord family and repeating cycles ("F · A♭" over sixteen alternating bars) with a hairline
 * per repetition. A lone passing chord joins the phrase before it (the tooltip lists it) and a run of quick
 * changes becomes one block that blends the colours of its chords and carries the one that sounds longest.
 * The exact chord of any bar is always in the tooltip and the transport readout.
 */
function renderChords(cur: Current, bars: number, pxPerBar: number, monoFont: string) {
  const { tl } = cur;
  const lane = el.laneChords;
  lane.innerHTML = '';
  chordEls = [];
  chordAt = new Int32Array(tl.bars).fill(-1);
  const chords = tl.chords.slice(0, tl.bars);
  const exact = pxPerBar >= EXACT_PX;
  lane.classList.toggle('phrased', !exact);
  lane.hidden = tl.bars === 0 || pxPerBar < 2.5 || !chords.some(Boolean);
  if (lane.hidden) return;
  const measure = (t: string) => textWidth(t, monoFont);
  const gap = exact ? 1 : 0;
  const frag = document.createDocumentFragment();
  interface Stripe { start: number; end: number; hue: number | null }
  interface Spec {
    start: number; end: number; kind: string; tip: string; hue: number | null;
    /** Label spellings, widest first (see `cycleLabels`); the widest that fits is drawn. */
    variants: readonly string[];
    /** A cycle: bars per repetition and the bars the cycle itself covers (a passing chord folded in extends `end` beyond them). */
    period?: number; cycleBars?: number;
    gradient?: string; stripes?: readonly Stripe[];
  }
  const add = ({ start, end, kind, tip, hue, variants, period, cycleBars, gradient, stripes = [] }: Spec) => {
    const block = makeBlock(`ch ${kind}`.trim(), tip, chordEls.length === 0);
    const span = end - start + 1;
    block.style.left = pct(start, bars);
    block.style.width = `calc(${pct(span, bars)} - ${gap}px)`;
    if (hue !== null) block.style.setProperty('--h', String(hue));
    if (period) block.style.setProperty('--cyc', `${(period * pxPerBar).toFixed(2)}px`);
    if (gradient) block.style.setProperty('--blend', gradient);
    // A passing chord folded into this block keeps its own colour as a stripe over its bars.
    for (const st of stripes) {
      if (st.hue === null) continue;
      const i = document.createElement('i');
      i.className = 'pass';
      i.style.left = pct(st.start - start, span);
      i.style.width = pct(st.end - st.start + 1, span);
      i.style.setProperty('--h', String(st.hue));
      block.appendChild(i);
    }
    // Labels. A cycle is written the way a chart writes a repeat: its chords over every repetition when they
    // fit in one, else once with a "×3" count; anything else carries the widest spelling that fits the block.
    const width = span * pxPerBar - gap;
    const reps = period && cycleBars ? Math.floor(cycleBars / period) : 1;
    const placed: { text: string; left: string }[] = [];
    if (variants.length && period && reps > 1) {
      const per = fitLabel(variants, period * pxPerBar, measure, 6);
      if (per) for (let k = 0; k < reps; k++) placed.push({ text: per, left: pct(k * period, span) });
      else {
        const once = fitLabel([...variants.map((v) => `${v} ×${reps}`), ...variants], width, measure, 6);
        if (once) placed.push({ text: once, left: '0' });
      }
    } else if (variants.length) {
      const text = fitLabel(variants, width, measure, 6);
      if (text) placed.push({ text, left: '0' });
    }
    const labels: HTMLElement[] = [];
    for (const { text, left } of placed) {
      const lab = document.createElement('span');
      lab.className = 'chl' + (text.startsWith(variants[0]) ? '' : ' abbr');
      lab.style.left = left;
      lab.textContent = text;
      block.appendChild(lab);
      labels.push(lab);
    }
    frag.appendChild(block);
    const i = chordEls.push({ el: block, labels }) - 1;
    for (let b = start; b <= end; b++) chordAt[b] = i;
  };

  if (exact) {
    for (const { start, end, label } of chordBlocks(chords)) {
      const pretty = label ? chordLabel(label) : '';
      add({ start, end, kind: label ? '' : 'none', tip: `${pretty || 'no chord'} · ${range(start, end)}`, hue: label ? chordHue(label) : null, variants: pretty ? chordVariants(pretty) : [] });
    }
    lane.appendChild(frag);
    return;
  }
  // Phrases never cross a section boundary: a cycle that straddles verse and chorus is not what a musician reads.
  const cuts = [0, ...tl.sections.map((s) => s.startBar).filter((b) => b > 0 && b < tl.bars), tl.bars];
  const phrases = cuts.slice(1).flatMap((end, k) => {
    const start = cuts[k];
    return chordPhrases(chords.slice(start, end)).map((p) => ({ ...p, start: p.start + start, end: p.end + start }));
  });
  const items: (PhraseItem & { hue: number | null; variants: string[] })[] = phrases.map((p) => {
    const none = p.cycle[0] === null;
    const pretty = p.cycle.map((f) => (f ? chordLabel(f) : ''));
    // A cycle's label is its chords in order, repeats collapsed; too wide, its head is kept and the rest counted.
    const variants = none ? [] : p.period === 1 ? [pretty[0]] : cycleLabels(pretty);
    const fits = !none && fitLabel(variants, (p.end - p.start + 1) * pxPerBar, measure, 6) !== null;
    return { start: p.start, end: p.end, period: p.period, none, pretty, variants, fits, hue: none ? null : chordHue(p.cycle[0]!) };
  });
  const describe = (it: PhraseItem) => `${cycleLabels(it.pretty)[0] ?? it.pretty.join(' · ')}${it.period > 1 ? ` ×${Math.floor((it.end - it.start + 1) / it.period)}` : ''}`;
  // Packed per section, so no block straddles two sections.
  const blocks = cuts.slice(1).flatMap((end, k) => packPhrases(items.filter((it) => it.start >= cuts[k] && it.start < end)));
  for (const b of blocks) {
    if (b.kind === 'none') { add({ start: b.start, end: b.end, kind: 'none', tip: `no chord · ${range(b.start, b.end)}`, hue: null, variants: [] }); continue; }
    if (b.kind === 'mixed') {
      // The blend runs through the colours of the chords in order, each as wide as its bars.
      const total = b.end - b.start + 1;
      const stops = b.extra.map((it) => `hsl(${it.hue ?? 0} 70% 62% / 0.34) ${(((it.start + (it.end - it.start + 1) / 2 - b.start) / total) * 100).toFixed(1)}%`);
      // The label is the progression as a musician names it: the chords in order, cut with an ellipsis when narrow.
      const all = b.extra.flatMap((it) => it.pretty).filter((c, k, a) => c && a.indexOf(c) === k);
      add({ start: b.start, end: b.end, kind: 'mixed', tip: `quick changes: ${all.join(' ')} · ${range(b.start, b.end)}`, hue: null, variants: cycleLabels(all), gradient: `linear-gradient(90deg, ${stops.join(', ')})` });
      continue;
    }
    const it = b.main!;
    const passing = b.extra.length ? ` · then ${b.extra.map(describe).join(', ')}` : '';
    add({
      start: b.start, end: b.end, kind: b.kind, tip: `${describe(it)}${passing} · ${range(b.start, b.end)}`, hue: it.hue, variants: it.variants,
      period: it.period > 1 ? it.period : undefined, cycleBars: it.end - it.start + 1, stripes: b.extra,
    });
  }
  lane.appendChild(frag);
}

/** The overview strip: the whole song in miniature (sections, else chord colours) with the visible window over it. */
function renderOverview({ tl }: Current, bars: number) {
  el.ovLanes.innerHTML = '';
  if (!zoomed) return;
  const frag = document.createDocumentFragment();
  const paint = (start: number, n: number, color: string) => {
    const d = document.createElement('i');
    d.style.left = pct(start, bars);
    d.style.width = pct(n, bars);
    d.style.background = color;
    frag.appendChild(d);
  };
  if (tl.sections.length) {
    const derived = tl.sections.every((s) => isFormLabel(s.label));
    for (const s of tl.sections) paint(s.startBar, s.bars, derived ? formColor(s.label) : sectionColor(s.label));
  } else {
    for (const { start, end, label } of chordBlocks(tl.chords.slice(0, tl.bars))) {
      const h = label ? chordHue(label) : null;
      if (h !== null) paint(start, end - start + 1, `hsl(${h} 70% 62%)`);
    }
  }
  el.ovLanes.appendChild(frag);
  updateWindow();
}
/** The overview's window mirrors the scroll box. */
function updateWindow() {
  if (!zoomed) return;
  const total = tlWidth + 2 * TL_PAD;
  const left = el.tlScroll.scrollLeft / total, width = el.tlScroll.clientWidth / total;
  el.ovWin.style.left = `${(left * 100).toFixed(3)}%`;
  el.ovWin.style.width = `${(width * 100).toFixed(3)}%`;
}

let lastTimeText = '';
let lastBarInt = -1;
let activeChord: Block | null = null;
let activeSection: HTMLElement | null = null;
let positioned = false;

/** Move the playhead, fill and counters to `bar`. Only touches transforms per frame; text updates when it changes. */
export function updatePosition(bar: number, force = false) {
  const cur = shown();
  if (!cur) return;
  const { tl } = cur;
  const frac = tl.bars ? Math.min(1, Math.max(0, bar / tl.bars)) : 0;
  const x = `${(frac * tlWidth).toFixed(2)}px`;
  el.fill.style.setProperty('--p', String(frac));
  el.knob.style.setProperty('--x', x);
  el.playhead.style.setProperty('--x', x);
  if (zoomed) el.ovPos.style.setProperty('--p', frac.toFixed(5));
  const pos = frac > 0;
  if (pos !== positioned) { positioned = pos; el.timeline.classList.toggle('positioned', pos); }
  // Zoomed timeline: page-flip the window when the playhead leaves it (never while the user scrubs or pans).
  if (zoomed && !state.scrubbing && (!panning || force)) {
    const next = followScroll(frac * tlWidth + TL_PAD, el.tlScroll.scrollLeft, el.tlScroll.clientWidth, tlWidth + 2 * TL_PAD);
    if (next !== el.tlScroll.scrollLeft) { el.tlScroll.scrollLeft = next; updateEdges(); }
  }
  const t = fmt(bar * tl.secondsPerBar);
  if (t !== lastTimeText) { el.posTime.textContent = t; lastTimeText = t; }
  const b = Math.min(tl.bars, Math.floor(bar) + 1);
  if (b !== lastBarInt + 1 || force) {
    lastBarInt = b - 1;
    el.posBar.textContent = tl.bars ? `bar ${b} / ${tl.bars}` : '';
    const chord = tl.chords[b - 1] ?? '';
    el.posChord.textContent = chord ? chordLabel(chord) : '';
    const secLabel = tl.sections.find((s) => b - 1 >= s.startBar && b - 1 < s.startBar + s.bars)?.label ?? '';
    el.posSec.textContent = sectionName(secLabel);
    el.track.setAttribute('aria-valuenow', String(b - 1));
    el.track.setAttribute('aria-valuetext', `bar ${b} of ${tl.bars}${chord ? ', ' + chordLabel(chord) : ''}${secLabel ? ', ' + sectionName(secLabel) : ''}`);
    const ci = chordAt[b - 1] ?? -1;
    const next = ci >= 0 ? chordEls[ci] ?? null : null;
    if (next !== activeChord) {
      activeChord?.el.classList.remove('active');
      next?.el.classList.add('active');
      activeChord = next;
    }
    const sec = sectionEls.find((s) => b - 1 >= s.start && b - 1 < s.end)?.el ?? null;
    if (sec !== activeSection) { activeSection?.classList.remove('active'); sec?.classList.add('active'); activeSection = sec; }
  }
}

function barAtX(clientX: number): number {
  const cur = state.current;
  if (!cur) return 0;
  const r = el.tlInner.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  return Math.min(cur.tl.bars - 1, Math.floor(frac * cur.tl.bars));
}

/**
 * The tooltip lives outside the scroll box (which clips vertically), above the ruler, so it never covers
 * the bar numbers or the lane it describes. `left` is in timeline coordinates: the lanes start at
 * `-scrollLeft` (the scroll box's padding cancels the timeline's negative margin).
 */
function showHover(bar: number) {
  const cur = state.current;
  if (!cur) return;
  const { tl } = cur;
  const sec = tl.sections.find((s) => bar >= s.startBar && bar < s.startBar + s.bars);
  el.hover.hidden = false;
  const chord = tl.chords[bar];
  el.hover.innerHTML = `<span class="ht num">${fmt(bar * tl.secondsPerBar)}</span><span class="hs num">bar ${bar + 1}</span>` +
    `${chord ? `<span class="hc">${esc(chordLabel(chord))}</span>` : ''}${sec ? `<span class="hs">${esc(sectionName(sec.label))}</span>` : ''}`;
  const cx = ((bar + 0.5) / tl.bars) * tlWidth - el.tlScroll.scrollLeft;
  // Keep the tooltip inside the timeline's width; the arrow stays on the bar.
  const half = el.hover.offsetWidth / 2, w = el.timeline.clientWidth;
  const shift = Math.min(0, w - (cx + half)) + Math.max(0, half - cx);
  el.hover.style.left = `${cx.toFixed(1)}px`;
  el.hover.style.setProperty('--shift', `${shift.toFixed(1)}px`);
}
const hideHover = () => { if (!state.scrubbing) el.hover.hidden = true; };

// ---------- slider ----------
el.track.addEventListener('pointerdown', (ev) => {
  if (!state.current || ev.button !== 0) return;
  ev.preventDefault();
  state.scrubbing = true;
  el.timeline.classList.add('scrubbing');
  el.track.setPointerCapture(ev.pointerId);
  const bar = barAtX(ev.clientX);
  updatePosition(bar);
  showHover(bar);
});
el.track.addEventListener('pointermove', (ev) => {
  if (!state.current) return;
  const bar = barAtX(ev.clientX);
  if (state.scrubbing) updatePosition(bar);
  if (state.scrubbing || ev.pointerType === 'mouse') showHover(bar);
});
const endScrub = (ev: PointerEvent) => {
  if (!state.scrubbing) return;
  state.scrubbing = false;
  el.timeline.classList.remove('scrubbing');
  if (ev.pointerType !== 'mouse') el.hover.hidden = true;
  handlers.seek(barAtX(ev.clientX));
};
el.track.addEventListener('pointerup', endScrub);
// Keyboard focus lands on the knob: in a zoomed timeline the window is scrolled to it, so the ring is never off-screen.
el.track.addEventListener('focus', () => {
  const cur = state.current;
  if (!cur || !zoomed) return;
  const x = (cur.tl.bars ? handlers.currentBar() / cur.tl.bars : 0) * tlWidth + TL_PAD;
  const next = followScroll(x, el.tlScroll.scrollLeft, el.tlScroll.clientWidth, tlWidth + 2 * TL_PAD, 16);
  if (next !== el.tlScroll.scrollLeft) { el.tlScroll.scrollLeft = next; updateEdges(); }
});
el.track.addEventListener('pointercancel', endScrub);
el.track.addEventListener('pointerleave', hideHover);
el.track.addEventListener('keydown', (e) => {
  const cur = state.current;
  if (!cur || e.metaKey || e.ctrlKey || e.altKey) return; // Cmd+K and the browser's own shortcuts pass through
  const step = e.shiftKey ? 8 : 1;
  const last = Math.max(0, cur.tl.bars - 1);
  if (e.key === 'ArrowRight' || e.key === 'ArrowUp') handlers.seek(Math.min(last, handlers.currentBar() + step));
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') handlers.seek(Math.max(0, handlers.currentBar() - step));
  else if (e.key === 'PageUp') handlers.seek(Math.min(last, handlers.currentBar() + 8));
  else if (e.key === 'PageDown') handlers.seek(Math.max(0, handlers.currentBar() - 8));
  else if (e.key === 'Home') handlers.seek(0);
  else if (e.key === 'End') handlers.seek(last);
  else if (e.key === ' ') handlers.toggle();
  else return;
  // Handled here: the page-level keys (arrows by 4 bars, Space) must not act on top of the slider's own.
  e.preventDefault();
  e.stopPropagation();
});

// ---------- lanes ----------
// One delegated listener per lane instead of a handler per block. Sections jump to their start, the ruler and
// chord lanes to the bar under the pointer. Hovering a lane previews the bar too.
const blockBar = (block: HTMLElement): number => {
  const s = sectionEls.find((x) => x.el === block);
  if (s) return s.start;
  const i = chordEls.findIndex((x) => x.el === block);
  return i >= 0 ? chordAt.indexOf(i) : 0;
};
el.laneSections.addEventListener('click', (ev) => {
  const bar = barAtX(ev.clientX);
  handlers.seek(sectionEls.find((s) => bar >= s.start && bar < s.end)?.start ?? bar);
});
for (const lane of [el.laneRuler, el.laneChords]) lane.addEventListener('click', (ev) => handlers.seek(barAtX(ev.clientX)));
for (const lane of [el.laneRuler, el.laneSections, el.laneChords]) {
  lane.addEventListener('pointermove', (ev) => { if (ev.pointerType === 'mouse' && !state.scrubbing) showHover(barAtX(ev.clientX)); });
  lane.addEventListener('pointerleave', hideHover);
}
// Keyboard: Tab reaches the first block of a lane, ← → walk along it, Enter or Space jump there (roving tabindex).
for (const lane of [el.laneSections, el.laneChords]) {
  const blocks = () => Array.from(lane.querySelectorAll<HTMLElement>('[role="button"]'));
  lane.addEventListener('keydown', (e) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[role="button"]');
    if (!target || !state.current) return;
    const all = blocks();
    const i = all.indexOf(target);
    let next: HTMLElement | undefined;
    if (e.key === 'ArrowRight') next = all[Math.min(all.length - 1, i + 1)];
    else if (e.key === 'ArrowLeft') next = all[Math.max(0, i - 1)];
    else if (e.key === 'Home') next = all[0];
    else if (e.key === 'End') next = all[all.length - 1];
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); handlers.seek(blockBar(target)); return; }
    else return;
    e.preventDefault();
    e.stopPropagation();
    if (next && next !== target) { target.tabIndex = -1; next.tabIndex = 0; next.focus(); }
  });
  lane.addEventListener('focusin', (e) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[role="button"]');
    if (!target || !state.current) return;
    for (const b of blocks()) b.tabIndex = b === target ? 0 : -1;
    const bar = blockBar(target);
    // A focused block is scrolled into view of a zoomed timeline and described by the tooltip.
    if (zoomed) target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    showHover(bar);
  });
  lane.addEventListener('focusout', (e) => { if (!lane.contains(e.relatedTarget as Node | null)) hideHover(); });
}

/** Edge fades tell that the zoomed lanes continue beyond the window. */
function updateEdges() {
  const left = el.tlScroll.scrollLeft;
  el.timeline.classList.toggle('more-left', zoomed && left > 2);
  el.timeline.classList.toggle('more-right', zoomed && left + el.tlScroll.clientWidth < tlWidth + 2 * TL_PAD - 2);
  updateWindow();
}
// While the user pans the zoomed lanes the playhead must not fight the scroll position.
let panTimer: number | undefined;
const holdPan = () => {
  panning = true;
  clearTimeout(panTimer);
  panTimer = window.setTimeout(() => { panning = false; }, 1200);
};
el.tlScroll.addEventListener('scroll', () => {
  updateEdges();
  if (state.scrubbing || !el.hover.hidden) el.hover.hidden = true; // the tooltip's bar has moved under it
  if (state.scrubbing) return;
  holdPan();
}, { passive: true });

// ---------- overview ----------
// Pointing at the strip centres the window there; dragging pans. Clicking never seeks (the strip is a map, not a slider).
let ovDrag = false;
const panTo = (clientX: number) => {
  const r = el.overview.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  const total = tlWidth + 2 * TL_PAD;
  el.tlScroll.scrollLeft = Math.max(0, Math.min(total - el.tlScroll.clientWidth, frac * total - el.tlScroll.clientWidth / 2));
  holdPan();
};
el.overview.addEventListener('pointerdown', (ev) => {
  if (!zoomed || ev.button !== 0) return;
  ev.preventDefault();
  ovDrag = true;
  el.overview.setPointerCapture(ev.pointerId);
  el.overview.classList.add('dragging');
  panTo(ev.clientX);
});
el.overview.addEventListener('pointermove', (ev) => { if (ovDrag) panTo(ev.clientX); });
const endOvDrag = () => { ovDrag = false; el.overview.classList.remove('dragging'); };
el.overview.addEventListener('pointerup', endOvDrag);
el.overview.addEventListener('pointercancel', endOvDrag);
el.overview.addEventListener('keydown', (e) => {
  if (!zoomed) return;
  const page = el.tlScroll.clientWidth * 0.8;
  if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); el.tlScroll.scrollLeft += page; holdPan(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); el.tlScroll.scrollLeft -= page; holdPan(); }
});

let resizeRaf = 0;
const rerender = () => { renderTimeline(); updatePosition(handlers.currentBar(), true); };
new ResizeObserver(() => {
  cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(rerender);
}).observe(el.tlScroll);
document.fonts?.ready.then(() => { if (state.current) rerender(); });
