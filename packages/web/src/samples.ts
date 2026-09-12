/** Keep the REPL's sample names/indices portable while serving reviewed acoustic hits locally. */
interface AudioScope {
  samples(map: Record<string, string[]>): Promise<void>;
  getAudioContext(): AudioContext;
  loadBuffer(url: string, context: AudioContext): Promise<AudioBuffer>;
}
const audioScope = () => globalThis as unknown as AudioScope;
let localUrls: string[] = [];
let ready: Promise<void> | undefined;
export async function registerLocalDrums() {
  const response = await fetch('/audio/acoustic/samples.json');
  if (!response.ok) throw new Error(`Could not load drum bank (${response.status})`);
  const map = await response.json() as Record<string, string[]>;
  localUrls = [...new Set(Object.values(map).flat().filter(url => url.startsWith('/audio/acoustic/')))];
  await audioScope().samples(map);
}
export function preloadLocalDrums(): Promise<void> {
  return ready ??= Promise.all(localUrls.map(url => audioScope().loadBuffer(url, audioScope().getAudioContext())))
    .then(() => undefined).catch(error => { ready = undefined; throw error; });
}
