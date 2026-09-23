/**
 * The embedded Strudel REPL: lazy loading of the 2 MB bundle and typed access to the editor element.
 */
import { el } from './dom.js';
import { registerLocalDrums, preloadLocalDrums } from './samples.js';
export { preloadLocalDrums };

export interface Scheduler { started: boolean; lastEnd: number; num_ticks_since_cps_change: number; now(): number; pause(): void; stop(): void }
/** The parts of a Strudel pattern the player queries: the events that start in a span of cycles. */
export interface Hap { value: Record<string, unknown> | null; hasOnset(): boolean }
export interface Pattern { queryArc(begin: number, end: number): Hap[] }
export interface Repl {
  scheduler: Scheduler;
  /** Evaluate code and make it the playing pattern; with `autostart` false the scheduler is left as it is. */
  evaluate(code: string, autostart?: boolean): Promise<Pattern | undefined>;
  start(): void | Promise<void>;
  state: { pattern?: Pattern; evalError?: unknown };
}
export interface StrudelMirror {
  prebaked: Promise<void>;
  /** The editor's text, the user's edits included. */
  code: string;
  setCode(code: string): void;
  evaluate(autostart?: boolean): Promise<void>;
  stop(): Promise<void>;
  updateSettings(settings: Record<string, unknown>): void;
  repl: Repl;
  editor: { requestMeasure?(): void };
}

export const editorEl = el.editor as HTMLElement & { editor?: StrudelMirror };
export const ed = (): StrudelMirror | undefined => editorEl.editor;

/**
 * The REPL bundle ships its own copies of @strudel/core and @strudel/webaudio and puts their exports on
 * globalThis (that is how evaluated patterns reach them). Importing @strudel/webaudio here would load a
 * second @strudel/core, so the audio context is taken from the same scope the player uses.
 */
export const audioContext = (): AudioContext | undefined => (globalThis as { getAudioContext?: () => AudioContext }).getAudioContext?.();

/**
 * The REPL (editor + synth) is code-split and fetched when a song opens. Browsing the landing
 * page and search does not download the engine or initialize its sample banks. A failed load is
 * forgotten, so opening a song (or Retry) tries again instead of failing for good.
 */
let replPromise: Promise<void> | null = null;
export const loadRepl = (): Promise<void> => (replPromise ??= import('@strudel/repl').then(() => new Promise<void>((resolve) => {
  const tick = () => (ed() ? resolve() : requestAnimationFrame(tick)); // the custom element upgrades on define
  tick();
})).then(async () => {
  // Override only reviewed sample indices after the REPL has registered its default banks.
  await ed()!.prebaked;
  await registerLocalDrums();
}).catch((error: unknown) => {
  replPromise = null;
  throw error;
}));

/** Superdough's sound registry, which the REPL puts on globalThis with the rest of its scope. */
type SoundRegistry = (name: string) => { onTrigger(time: number, value: Record<string, unknown>, onended: () => void, cps: number): unknown } | undefined;
const getSound = (): SoundRegistry | undefined => (globalThis as { getSound?: SoundRegistry }).getSound;

/** How far ahead (seconds) the silent warm-up triggers are scheduled. */
const WARM_AHEAD = 30;
/** Sounds already fetched and decoded (name, sample index, pitch): a warm-up only asks for new ones. */
const warmed = new Set<string>();

/**
 * Fetch and decode the sounds a pattern plays between two cycles before they are needed. Strudel
 * loads a sample or a soundfont zone when its first note is due and drops that note if the load
 * takes longer ("skip hap: still loading"), so the opening bars of a song would otherwise play
 * with holes. Each sound is triggered once through its own loader, whose output is never connected
 * to the speakers: the buffers land in Strudel's caches and nothing is heard.
 */
export async function warmSounds(pattern: Pattern | undefined, from: number, to: number, cps: number): Promise<void> {
  const ctx = audioContext(), registry = getSound();
  if (!pattern || !ctx || !registry || !(to > from)) return;
  const loads: Promise<unknown>[] = [];
  for (const hap of pattern.queryArc(from, to)) {
    const v = hap.value;
    if (!v || !hap.hasOnset() || typeof v.s !== 'string') continue;
    const key = `${v.s}|${v.n ?? ''}|${v.note ?? v.freq ?? ''}`;
    if (warmed.has(key)) continue;
    const sound = registry(v.s);
    if (!sound) continue;
    warmed.add(key);
    // Scheduled well ahead: a load that outlasts the trigger time is logged as "took too long"; unconnected, the source is never heard.
    loads.push(Promise.resolve().then(() => sound.onTrigger(ctx.currentTime + WARM_AHEAD, v, () => {}, cps)).catch(() => warmed.delete(key)));
  }
  await Promise.all(loads);
}
