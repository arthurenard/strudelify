/**
 * Transport: play, hard stop, seek. Seeking moves the scheduler's query cursor (`lastEnd`) while
 * playing and only the playhead while paused; stop suspends the AudioContext so ringing notes are cut.
 */
import { el, toast } from './dom.js';
import { state } from './state.js';
import { ed, editorEl, audioContext } from './repl.js';
import { updatePosition } from './timeline.js';

export function setStarted(v: boolean) {
  state.started = v;
  el.play.classList.toggle('playing', v);
  el.play.setAttribute('aria-label', v ? 'Pause' : 'Play');
  el.play.title = v ? 'Pause (Space)' : 'Play (Space)';
  el.timeline.classList.toggle('playing', v);
}
editorEl.addEventListener('update', (e) => {
  const st = (e as CustomEvent).detail as { started?: boolean };
  if (typeof st?.started === 'boolean' && st.started !== state.started) setStarted(st.started);
});

/** Bar currently shown by the playhead. */
export function currentBar(): number {
  const cur = state.current;
  const s = ed()?.repl.scheduler;
  if (!cur) return 0;
  if (state.pendingSeek) return state.pendingSeek.bar;
  if (state.started && s?.started) {
    const bars = cur.tl.bars || 1;
    return Math.max(0, s.now()) % bars; // now() sits slightly below 0 for the first ticks after start
  }
  return state.pausedBar;
}

export async function play(fromBar?: number) {
  const e = ed();
  const cur = state.current;
  if (!e || !cur || el.play.getAttribute('aria-busy') === 'true') return;
  // aria-busy rather than disabled: a disabled button drops keyboard focus to <body>.
  el.play.setAttribute('aria-busy', 'true');
  try {
    const ctx = audioContext();
    if (ctx?.state === 'suspended') await ctx.resume();
    e.setCode(cur.code);
    await e.evaluate(true);
    const bar = fromBar ?? state.pausedBar;
    if (bar > 0) jump(bar); else updatePosition(0, true);
    setStarted(true);
  } catch (err) {
    toast(`Could not play: ${(err as Error).message}`, 'error');
  } finally { el.play.removeAttribute('aria-busy'); }
}

/** Hard stop: halt the scheduler and suspend the AudioContext so ringing notes are cut instantly. */
export async function stop(reset = false) {
  const e = ed();
  if (!e) return;
  state.pausedBar = reset ? 0 : Math.floor(currentBar());
  e.repl.scheduler.stop();
  setStarted(false);
  state.pendingSeek = null;
  try { await audioContext()?.suspend(); } catch { /* not created yet */ }
  if (state.current) updatePosition(state.pausedBar, true);
}

/** Move the scheduler's query cursor so the next tick starts at `bar`. */
export function jump(bar: number) {
  const s = ed()?.repl.scheduler;
  if (!s) return;
  s.lastEnd = bar;
  s.num_ticks_since_cps_change = 0;
  state.pendingSeek = { bar, until: performance.now() + 400 };
  updatePosition(bar, true);
}

/** Jump while playing; while paused just move the playhead (playback only ever starts from Play or Space). */
export function seek(bar: number) {
  const cur = state.current;
  if (!cur) return;
  bar = Math.max(0, Math.min(cur.tl.bars - 1, Math.floor(bar)));
  if (state.started) jump(bar);
  else { state.pausedBar = bar; updatePosition(bar, true); }
}

export const toggle = () => (state.started ? stop() : play());
export function rewind() {
  if (!state.current) return;
  if (state.started) jump(0); else { state.pausedBar = 0; updatePosition(0, true); }
}
el.play.addEventListener('click', toggle);
el.rewind.addEventListener('click', rewind);

function tick() {
  const cur = state.current;
  const s = ed()?.repl.scheduler;
  if (cur && state.started && s?.started && !state.scrubbing) {
    const bars = cur.tl.bars || 1;
    const now = Math.max(0, s.now()) % bars;
    const ps = state.pendingSeek;
    if (ps && (Math.abs(now - ps.bar) < 1 || performance.now() > ps.until)) state.pendingSeek = null;
    updatePosition(state.pendingSeek ? state.pendingSeek.bar : now);
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
