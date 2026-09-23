/** Key finding (Krumhansl-Schmuckler) and the conventional spelling of keys and notes. */
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function corr(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

export function estimateKey(hist: number[]): { tonic: number; mode: 'major' | 'minor'; confidence: number } {
  let best = { tonic: 0, mode: 'major' as 'major' | 'minor', score: -Infinity };
  for (let t = 0; t < 12; t++) {
    const rotated = hist.map((_, i) => hist[(i + t) % 12]);
    const cm = corr(rotated, MAJOR);
    const cn = corr(rotated, MINOR);
    if (cm > best.score) best = { tonic: t, mode: 'major', score: cm };
    if (cn > best.score) best = { tonic: t, mode: 'minor', score: cn };
  }
  return { tonic: best.tonic, mode: best.mode, confidence: best.score };
}

const SHARP_TO_FLAT: Record<string, string> = { 'C#': 'Db', 'D#': 'Eb', 'F#': 'Gb', 'G#': 'Ab', 'A#': 'Bb' };
/** A sharp pitch-class name as its flat twin (`A#` -> `Bb`); anything else as it is. */
export function flatName(note: string): string { return SHARP_TO_FLAT[note] ?? note; }

/**
 * Conventional spelling of a key's tonic: the parsers name pitch classes with sharps, but B♭ major
 * is not written A♯ major. Sharp majors become their flat twins except F♯ (6 sharps either way);
 * sharp minors keep the sharp except D♯/A♯ minor, which are written E♭/B♭ minor.
 */
export function spellTonic(tonic: string, mode: 'major' | 'minor' = 'major'): string {
  if (mode === 'minor') return tonic === 'D#' || tonic === 'A#' ? flatName(tonic) : tonic;
  return tonic === 'F#' ? tonic : flatName(tonic);
}

/** Whether notes and chords in this key are conventionally spelled with flats (F, B♭, E♭ ... majors and their relative minors). */
export function prefersFlats(tonic: string | undefined, mode: 'major' | 'minor' = 'major'): boolean {
  if (!tonic) return false;
  const t = spellTonic(tonic, mode);
  if (t.endsWith('b')) return true;
  return mode === 'major' ? t === 'F' : ['D', 'G', 'C', 'F'].includes(t);
}
