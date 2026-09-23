/**
 * A song's identity colour and tile letter, with no dependencies: shared by the browser modules and by the
 * Vite plugin that bakes the landing cards into index.html (landing.ts), so both paint the same colour.
 */

/** Stable 32-bit FNV-1a hash of a string. */
export function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
/** The hash mapped to a hue in [0, 360). */
export const hashHue = (s: string): number => fnv1a(s) % 360;
/**
 * The identity palette: twelve hues spaced around the wheel so that any two songs that hash to different slots
 * are clearly different colours, in two weights each (a deeper and a brighter version) so that neighbouring
 * songs that share a slot still tell apart. Hues avoid the accent green so a tile never reads as a control.
 */
const TINT_HUES = [212, 232, 256, 280, 305, 335, 358, 18, 36, 160, 182, 196];
const TINT_TONES: [number, number][] = [[52, 40], [58, 48]];
export function fallbackTint(s: string): string {
  const h = hashHue(s);
  const hue = TINT_HUES[Math.floor(h / 30) % TINT_HUES.length];
  const [sat, light] = TINT_TONES[hashHue(`${s}\u0000tone`) % TINT_TONES.length];
  return `hsl(${hue} ${sat}% ${light}%)`;
}
/**
 * A song's identity colour: the same tile colour everywhere it appears (search row, landing card, hero
 * fallback), derived from title and artist so two covers of one song never share a tile.
 */
export function songTint(entry: { title: string; artist: string }): string {
  return fallbackTint(`${entry.title}${entry.artist}`);
}

/** First alphanumeric character of a title, upper-cased, for the fallback tile. */
export function initial(title: string): string {
  return title.replace(/[^A-Za-z0-9]/g, '').slice(0, 1).toUpperCase() || '♪';
}
