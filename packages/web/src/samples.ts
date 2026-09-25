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
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  const response = await fetch(`${base}/audio/acoustic/samples.json`);
  if (!response.ok) throw new Error(`Could not load drum bank (${response.status})`);
  // The bank lists root-relative URLs; serve them under the site's base path.
  const raw = await response.json() as Record<string, string[]>;
  const map = Object.fromEntries(Object.entries(raw).map(([k, urls]) => [k, urls.map(u => u.startsWith('/audio/acoustic/') ? base + u : u)]));
  localUrls = [...new Set(Object.values(map).flat().filter(url => url.startsWith(`${base}/audio/acoustic/`)))];
  await audioScope().samples(map);
}
export function preloadLocalDrums(): Promise<void> {
  return ready ??= Promise.all(localUrls.map(url => audioScope().loadBuffer(url, audioScope().getAudioContext())))
    .then(() => undefined).catch(error => { ready = undefined; throw error; });
}
