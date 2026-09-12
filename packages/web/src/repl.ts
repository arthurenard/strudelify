/**
 * The embedded Strudel REPL: lazy loading of the 2 MB bundle and typed access to the editor element.
 */
import { el } from './dom.js';
import { registerLocalDrums, preloadLocalDrums } from './samples.js';
export { preloadLocalDrums };

export interface Scheduler { started: boolean; lastEnd: number; num_ticks_since_cps_change: number; now(): number; stop(): void }
export interface StrudelMirror {
  prebaked: Promise<void>;
  code: string;
  setCode(code: string): void;
  evaluate(autostart?: boolean): Promise<void>;
  stop(): Promise<void>;
  updateSettings(settings: Record<string, unknown>): void;
  repl: { scheduler: Scheduler };
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
 * The REPL (editor + synth) is code-split: the landing page renders without it, it is fetched in idle
 * time once the index is in, and a song opened before that simply waits for it.
 */
let replPromise: Promise<void> | null = null;
export const loadRepl = (): Promise<void> => (replPromise ??= import('@strudel/repl').then(() => new Promise<void>((resolve) => {
  const tick = () => (ed() ? resolve() : requestAnimationFrame(tick)); // the custom element upgrades on define
  tick();
})).then(async () => {
  // Override only reviewed sample indices after the REPL has registered its default banks.
  await ed()!.prebaked;
  await registerLocalDrums();
}));
