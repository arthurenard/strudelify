/** Krumhansl-Schmuckler key finding from a 12-bin pitch-class weight histogram. */
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
