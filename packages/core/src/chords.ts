/**
 * Chord symbol handling.
 *
 * Input formats:
 *  - Harte syntax as used by the McGill Billboard annotations: `C:maj`, `D:min7`,
 *    `F:maj/5`, `A:sus4(b7,9)`, `E:1`, `G:5`, `N`.
 *  - Output is a symbol Strudel's `chord()` / `voicing()` understands, built from the
 *    tonal-style vocabulary: `C`, `Dm7`, `F/A`, `A7sus4`, `E5`, ...
 */

const PC = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_TO_SHARP: Record<string, string> = {
  Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#', Cb: 'B', Fb: 'E', 'E#': 'F', 'B#': 'C',
};

export function pitchClass(name: string): number {
  const n = FLAT_TO_SHARP[name] ?? name;
  const i = PC.indexOf(n);
  if (i < 0) throw new Error(`Unknown pitch class ${name}`);
  return i;
}

export function pcName(pc: number, preferFlats = false): string {
  const sharp = PC[((pc % 12) + 12) % 12];
  if (!preferFlats) return sharp;
  const flats: Record<string, string> = { 'C#': 'Db', 'D#': 'Eb', 'F#': 'Gb', 'G#': 'Ab', 'A#': 'Bb' };
  return flats[sharp] ?? sharp;
}

/** Semitone offset of a Harte scale degree such as `3`, `b7`, `#11`, `bb13`. */
export function degreeToSemitones(deg: string): number {
  const m = /^([b#]*)(\d+)$/.exec(deg);
  if (!m) throw new Error(`Bad degree ${deg}`);
  const acc = m[1].split('').reduce((a, c) => a + (c === 'b' ? -1 : 1), 0);
  const base: Record<number, number> = { 1: 0, 2: 2, 3: 4, 4: 5, 5: 7, 6: 9, 7: 11, 9: 14, 11: 17, 13: 21 };
  const d = Number(m[2]);
  const b = base[d];
  if (b === undefined) throw new Error(`Bad degree ${deg}`);
  return b + acc;
}

/** Harte shorthand -> tonal/Strudel chord quality suffix. */
const QUALITY: Record<string, string> = {
  maj: '', min: 'm', dim: 'dim', aug: 'aug', maj7: '^7', min7: 'm7', '7': '7', dim7: 'dim7',
  hdim7: 'm7b5', minmaj7: 'mM7', maj6: '6', min6: 'm6', '9': '9', maj9: '^9', min9: 'm9',
  '11': '11', min11: 'm11', '13': '13', maj13: '^13', min13: 'm13', sus2: 'sus2', sus4: 'sus4',
  '1': '5', '5': '5',
};

/** Extensions in parentheses that change the symbol. Others are dropped to keep symbols playable. */
function applyExtensions(quality: string, exts: string[]): string {
  let q = quality;
  const set = new Set(exts);
  if (q === 'sus4' && set.has('b7')) q = set.has('9') ? '9sus4' : '7sus4';
  else if (q === 'sus2' && set.has('b7')) q = '7sus2';
  else if (q === '' && set.has('9')) q = 'add9';
  else if (q === '' && set.has('11')) q = 'add11';
  else if (q === '6' && set.has('9')) q = '69';
  else if (q === 'm' && set.has('9')) q = 'madd9';
  else if (q === 'm7' && set.has('11')) q = 'm11';
  else if (q === '7' && set.has('#9')) q = '7#9';
  else if (q === '7' && set.has('b9')) q = '7b9';
  else if (q === '7' && set.has('#11')) q = '7#11';
  else if (q === '7' && set.has('b13')) q = '7b13';
  else if (q === 'aug' && set.has('b7')) q = 'aug7';
  else if (q === '5' && set.has('b3') && set.has('b7')) q = 'm7';
  else if (q === '5' && set.has('b3')) q = 'm';
  else if (q === '5' && set.has('3') && set.has('b7')) q = '7';
  else if (q === '5' && set.has('3')) q = '';
  else if (q === '5' && set.has('b7')) q = '7';
  else if (q === '^7' && set.has('#11')) q = '^7#11';
  return q;
}

export interface ParsedChord {
  root: string;
  quality: string;
  /** Bass note name if the chord is an inversion / slash chord. */
  bass?: string;
}

/** Parse a Harte chord label. Returns null for `N` (no chord) or unparseable labels. */
export function parseHarte(label: string): ParsedChord | null {
  if (label === 'N' || label === '*' || label === '&pause') return null;
  const m = /^([A-G][b#]?)(?::([a-z0-9]+)?)?(?:\(([^)]*)\))?(?:\/([b#]*\d+))?$/.exec(label);
  if (!m) return null;
  const root = m[1];
  const shorthand = m[2] ?? 'maj';
  const exts = m[3] ? m[3].split(',').map((s) => s.trim()).filter(Boolean) : [];
  let quality = QUALITY[shorthand];
  if (quality === undefined) return null;
  quality = applyExtensions(quality, exts);
  let bass: string | undefined;
  if (m[4] && m[4] !== '1') {
    const preferFlats = root.includes('b') || root === 'F';
    bass = pcName(pitchClass(root) + degreeToSemitones(m[4]), preferFlats);
  }
  return { root, quality, bass };
}

/** Format a parsed chord as a Strudel chord symbol. */
export function formatChord(c: ParsedChord): string {
  return c.bass ? `${c.root}${c.quality}/${c.bass}` : `${c.root}${c.quality}`;
}

export function harteToStrudel(label: string): string | null {
  const p = parseHarte(label);
  return p ? formatChord(p) : null;
}

/** Transpose a Strudel chord symbol by `semitones`. */
export function transposeSymbol(symbol: string, semitones: number): string {
  const m = /^([A-G][b#]?)([^/]*)(?:\/([A-G][b#]?))?$/.exec(symbol);
  if (!m) return symbol;
  const preferFlats = m[1].includes('b');
  const root = pcName(pitchClass(m[1]) + semitones, preferFlats);
  const bass = m[3] ? pcName(pitchClass(m[3]) + semitones, preferFlats) : undefined;
  return bass ? `${root}${m[2]}/${bass}` : `${root}${m[2]}`;
}

/**
 * Rewrite a chord symbol so Strudel's voicing dictionary accepts it. Qualities that the
 * dictionary lacks are replaced by the closest one it has (checked against strudel.cc 1.2).
 */
const VOICING_ALIASES: Record<string, string> = {
  dim: 'o', dim7: 'o7', mM7: 'm^7', sus4: 'sus', sus2: 'sus', '7sus4': '7sus', '7sus2': '7sus',
  '9sus4': '9sus', add11: '', aug7: '7#5', m13: 'm11', maj7: '^7', maj9: '^9', min7: 'm7', min: 'm', maj: '',
};
export function voicingSafe(symbol: string): string {
  const m = /^([A-G][b#]?)([^/]*)$/.exec(symbol);
  if (!m) return symbol;
  const q = VOICING_ALIASES[m[2]];
  return q === undefined ? symbol : `${m[1]}${q}`;
}
