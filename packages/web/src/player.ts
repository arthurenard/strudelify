/**
 * Transport: play, hard stop, seek. Seeking moves the scheduler's query cursor (`lastEnd`) while
 * playing and only the playhead while paused; stop suspends the AudioContext so ringing notes are cut.
 * What plays is what the editor holds: the generated code, or the user's edits to it.
 */
import { el, toast, setStatus } from './dom.js';
import { state, type Current } from './state.js';
import { ed, editorEl, audioContext, preloadLocalDrums, warmSounds, type Pattern } from './repl.js';
import { updatePosition } from './timeline.js';

/** Bars whose sounds are loaded before playback starts; the rest of the song loads while it plays. */
const WARM_BARS = 8;

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
  // Strudel's own Ctrl+Enter starts the scheduler, but a pause left the AudioContext suspended: wake it, or nothing is heard.
  if (st?.started) { const ctx = audioContext(); if (ctx?.state === 'suspended') void ctx.resume(); }
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

/** Evaluate the editor's code without touching the transport; throws when it does not evaluate. */
async function evaluateEditor(): Promise<Pattern | undefined> {
  const e = ed()!;
  const pattern = await e.repl.evaluate(e.code, false);
  const error = e.repl.state.evalError;
  if (error) throw error instanceof Error ? error : new Error(String(error));
  return pattern ?? e.repl.state.pattern;
}

/** Load the sounds of the song from `bar` on, a few bars at a time, until it ends or another song opens. */
async function warmRest(cur: Current, pattern: Pattern | undefined, bar: number) {
  const cps = cur.tl.cpm / 60;
  for (let from = bar; from < cur.tl.bars && state.current === cur; from += WARM_BARS) {
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the scheduler and the page run between chunks
    await warmSounds(pattern, from, Math.min(cur.tl.bars, from + WARM_BARS), cps).catch(() => {});
  }
}

export async function play(fromBar?: number) {
  const e = ed();
  const cur = state.current;
  if (!e || !cur || el.play.disabled || el.play.getAttribute('aria-busy') === 'true') return;
  // aria-busy rather than disabled: a disabled button drops keyboard focus to <body>.
  el.play.setAttribute('aria-busy', 'true');
  // Every await is a chance for another song to open; its code must not start under the new title.
  const stale = () => state.current !== cur;
  try {
    const ctx = audioContext();
    if (ctx?.state === 'suspended') await ctx.resume();
    if (stale()) return;
    if (cur.song.meta.drumKit === 'acoustic') await preloadLocalDrums();
    if (stale()) return;
    const pattern = await evaluateEditor();
    if (stale()) return;
    const bar = Math.max(0, Math.min(cur.tl.bars - 1, Math.floor(fromBar ?? state.pausedBar)));
    setStatus('Loading sounds…');
    await warmSounds(pattern, bar, Math.min(cur.tl.bars, bar + WARM_BARS), cur.tl.cpm / 60).finally(() => setStatus(''));
    if (stale()) return;
    await e.repl.start();
    if (bar > 0) jump(bar); else updatePosition(0, true);
    setStarted(true);
    void warmRest(cur, pattern, bar + WARM_BARS);
  } catch (err) {
    if (!stale()) toast(`Could not play: ${(err as Error).message}`, 'error');
  } finally { el.play.removeAttribute('aria-busy'); }
}

/** New code while playing (an option changed): swap it in without stopping, and load what it adds. */
export async function refresh() {
  const cur = state.current;
  if (!ed() || !cur || !state.started) return;
  try {
    const pattern = await evaluateEditor();
    if (state.current === cur) void warmRest(cur, pattern, Math.floor(currentBar()));
  } catch (err) {
    toast(`Could not play: ${(err as Error).message}`, 'error');
  }
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
