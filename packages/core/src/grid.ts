/**
 * The musical grid a Full arrangement or a Main loop rounds its notes to, and where that grid starts. A MIDI file
 * whose band plays together but a few tens of milliseconds off the beat (a transcription that starts late or
 * early) would otherwise send parts to different steps: drums at -40 ms round a step early while the bass at
 * -32 ms rounds onto the beat, a 68 ms gap the file does not have. The grid is shifted by the band's common
 * offset, which moves the whole song by that much (inaudible) and keeps the parts together.
 */

/** Largest shift (seconds) of the grid: more than this is a feel or a different rhythm, not an offset. */
const MAX_SHIFT_SECONDS = 0.06;
/**
 * How strongly the notes must agree on their offset (the length of their mean direction on the grid, 0-1): a
 * band late together agrees (The Police's Every Breath You Take, 38 ms early: 0.62); loose or mixed rhythms
 * do not. Swing is kept apart by its grid instead (see `fitGrid`).
 */
const AGREEMENT = 0.5;
/** Grids whose steps are triplets: a shifted grid never replaces one of these that fits unshifted (swing). */
const TRIPLETS = new Set([12, 24]);

/**
 * The coarsest of `grids` (steps per bar, coarsest first) that places `share` of `onsets` (beats from a bar
 * line) within `tolerance` seconds of a step, and its `shift` (beats; onsets are rounded as `onset - shift`).
 * The grid is found without a shift first; a shift, the notes' common offset on a grid (their circular mean),
 * is taken when the notes agree on it and it fits a coarser grid of the same kind (straight or triplet; a
 * 48-step grid is both), or places more notes on that grid: a late transcription reads on sixteenths shifted
 * by its lateness, with its parts on the same steps, and swing, which fits triplets as played, keeps them.
 * `fallback` when no grid places enough.
 */
export function fitGrid(onsets: readonly number[], length: number, bpm: number, grids: readonly number[], fallback: number, share: number, tolerance: number): { grid: number; shift: number } {
  const seconds = 60 / bpm;
  const placed = (grid: number, shift: number) => {
    const step = length / grid;
    return onsets.filter((at) => {
      const x = at - shift;
      return Math.abs(Math.round(x / step) * step - x) * seconds <= tolerance;
    }).length;
  };
  const fits = (grid: number, shift: number) => placed(grid, shift) >= onsets.length * share;
  /** The notes' common offset on a grid, when they agree on it and it is small enough to be one. */
  const offset = (grid: number): number | null => {
    const step = length / grid;
    let c = 0, s = 0;
    for (const at of onsets) { const a = 2 * Math.PI * (at / step); c += Math.cos(a); s += Math.sin(a); }
    if (!onsets.length || Math.hypot(c, s) / onsets.length < AGREEMENT) return null;
    const shift = Math.atan2(s, c) / (2 * Math.PI) * step;
    return Math.abs(shift) * seconds <= MAX_SHIFT_SECONDS ? shift : null;
  };
  const plain = grids.find((grid) => fits(grid, 0)) ?? fallback;
  for (const grid of grids) {
    const shift = offset(grid);
    if (grid === plain) return { grid, shift: shift !== null && placed(grid, shift) > placed(grid, 0) ? shift : 0 };
    if (TRIPLETS.has(plain) !== TRIPLETS.has(grid) && plain !== 48 && plain !== fallback) continue;
    if (shift !== null && fits(grid, shift)) return { grid, shift };
  }
  const shift = offset(fallback);
  return { grid: fallback, shift: shift !== null && placed(fallback, shift) > placed(fallback, 0) ? shift : 0 };
}
