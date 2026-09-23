/**
 * Parser for McGill Billboard `salami_chords.txt` files.
 *
 * File shape:
 *   # title: ...
 *   # artist: ...
 *   # metre: 4/4
 *   # tonic: C
 *   <time>\t<label>, <section name>, | C:maj . . G:min | F:maj |, (guitar)
 *   <time>\tsilence | end | Z ...
 *
 * Inside bars: chord labels, `.` repeats the previous chord for one beat,
 * `(3/4)` changes the metre for that bar, `x2` after the bars repeats the line.
 * The header comes first; a `# metre:` or `# tonic:` line later in the file marks a metre change
 * or a modulation from that point on.
 */
import type { ChordEvent, Section, Song } from './types.js';
import { harteToStrudel } from './chords.js';
import { normaliseSectionLabel } from './sections.js';

interface RawLine {
  time: number;
  sectionLetter?: string;
  sectionName?: string;
  bars: string[];
  repeat: number;
}

export interface McgillHeader {
  title: string;
  artist: string;
  metre: string;
  tonic: string;
}

const COMMENT_RE = /^#\s*(\w+):\s*(.*)$/;

/** The header's fields. The first value of each wins: a later `# metre:` or `# tonic:` is a change inside the song, not the song's metre or key. */
export function parseMcgillHeader(text: string): McgillHeader {
  const h: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = COMMENT_RE.exec(line.trim());
    if (m && !(m[1] in h)) h[m[1]] = m[2].trim();
  }
  return { title: h.title ?? '', artist: h.artist ?? '', metre: h.metre ?? '4/4', tonic: h.tonic ?? '' };
}

/** A metre such as `7/4` as [beats, unit]; undefined when it does not read as one. */
function readMetre(s: string): [number, number] | undefined {
  const m = /^(\d+)\/(\d+)$/.exec(s.trim());
  return m && Number(m[1]) > 0 && Number(m[2]) > 0 ? [Number(m[1]), Number(m[2])] : undefined;
}

function parseLine(line: string): RawLine | null {
  const tab = line.indexOf('\t');
  if (tab < 0) return null;
  const time = Number(line.slice(0, tab));
  const body = line.slice(tab + 1).trim();
  if (!body.includes('|')) return null;
  const first = body.indexOf('|');
  const last = body.lastIndexOf('|');
  const pre = body.slice(0, first).split(',').map((s) => s.trim()).filter(Boolean);
  const post = body.slice(last + 1);
  const barText = body.slice(first + 1, last);
  const bars = barText.split('|').map((b) => b.trim()).filter((b) => b.length > 0);
  const rep = /x(\d+)/.exec(post);
  const out: RawLine = { time, bars, repeat: rep ? Number(rep[1]) : 1 };
  for (const p of pre) {
    if (/^[A-Z]'*$/.test(p)) out.sectionLetter = p;
    else out.sectionName = p;
  }
  return out;
}

/**
 * Expand one bar's tokens into chord events. Returns the events and the number of beats in the bar.
 * Beats are the song's beat unit (`unit`, the header metre's denominator): a `(3/8)` bar in a 4/4
 * song lasts one and a half beats, a `(2/4)` bar in 6/8 four.
 */
function expandBar(tokens: string[], defaultBeats: number, unit: number, prev: string | null): { events: ChordEvent[]; beats: number; last: string | null } {
  let beats = defaultBeats;
  const chordTokens: string[] = [];
  for (const t of tokens) {
    const metre = /^\((\d+)\/(\d+)\)$/.exec(t);
    if (metre) { if (Number(metre[1]) > 0 && Number(metre[2]) > 0) beats = Number(metre[1]) * (unit / Number(metre[2])); continue; }
    chordTokens.push(t);
  }
  if (chordTokens.length === 0) return { events: [], beats, last: prev };
  // Resolve '.' (repeat previous) to explicit symbols.
  const symbols: (string | null)[] = [];
  let last = prev;
  for (const t of chordTokens) {
    if (t === '.') { symbols.push(last); continue; }
    const s = harteToStrudel(t);
    symbols.push(s);
    last = s;
  }
  // Distribute the bar's beats across tokens. One token = whole bar, n tokens = beats/n each.
  const per = beats / symbols.length;
  const events: ChordEvent[] = [];
  for (const s of symbols) {
    const tail = events[events.length - 1];
    if (tail && tail.symbol === s) tail.beats += per;
    else events.push({ symbol: s, beats: per });
  }
  return { events, beats, last };
}

export function parseMcgill(text: string, id: string): Song {
  const header = parseMcgillHeader(text);
  // Chord lines with the metre in force: the header's, until a `# metre:` line changes it (Money's
  // 4/4 guitar solo inside a 7/4 song). The first metre line is the header's (see `parseMcgillHeader`).
  const headerMetre = readMetre(header.metre) ?? [4, 4];
  const rows: { line: RawLine; metre: [number, number] }[] = [];
  let metre = headerMetre, seenHeader = false;
  for (const row of text.split('\n')) {
    const comment = COMMENT_RE.exec(row.trim());
    if (comment) {
      if (comment[1] !== 'metre') continue;
      if (!seenHeader) { seenHeader = true; continue; }
      metre = readMetre(comment[2]) ?? metre;
      continue;
    }
    const line = parseLine(row);
    if (line) rows.push({ line, metre });
  }
  // The song's grid is the metre that lasts longest (the header's on a tie); bars in another metre
  // keep their own length, counted in the grid's beat unit.
  const quarters = new Map<string, number>();
  for (const { line, metre: [n, d] } of rows) quarters.set(`${n}/${d}`, (quarters.get(`${n}/${d}`) ?? 0) + line.bars.length * line.repeat * n * (4 / d));
  const headerKey = `${headerMetre[0]}/${headerMetre[1]}`;
  let best = headerKey;
  for (const [key, q] of quarters) if (q > (quarters.get(best) ?? 0)) best = key;
  const [num, den] = readMetre(best)!;
  const beatsPerBar = num;
  const lines = rows.map(({ line, metre: [n, d] }) => ({ ...line, barBeats: n * (den / d) }));
  // Where the metre changes, for the remark.
  const regions: string[] = [];
  let bar = 1, previous = '';
  for (const { line, metre: [n, d] } of rows) {
    if (`${n}/${d}` !== previous) { regions.push(`${n}/${d} at bar ${bar}`); previous = `${n}/${d}`; }
    bar += line.bars.length * line.repeat;
  }

  const sections: Section[] = [];
  let current: Section | null = null;
  let prevChord: string | null = null;
  // For tempo estimation: total beats vs. elapsed time between first and last chord line.
  let totalBeats = 0;
  const firstTime = lines[0]?.time ?? 0;
  let lastTime = firstTime;
  let beatsAtLastTime = 0;

  for (const line of lines) {
    if (line.sectionName || line.sectionLetter) {
      const raw = line.sectionName ?? line.sectionLetter ?? 'section';
      current = { label: normaliseSectionLabel(raw), raw, bars: 0, chords: [] };
      sections.push(current);
    }
    if (!current) {
      current = { label: 'intro', raw: 'intro', bars: 0, chords: [] };
      sections.push(current);
    }
    beatsAtLastTime = totalBeats;
    lastTime = line.time;
    for (let r = 0; r < line.repeat; r++) {
      for (const bar of line.bars) {
        const { events, beats, last } = expandBar(bar.split(/\s+/), line.barBeats, den, prevChord);
        prevChord = last;
        for (const e of events) {
          const tail = current.chords[current.chords.length - 1];
          if (tail && tail.symbol === e.symbol) tail.beats += e.beats;
          else current.chords.push({ ...e });
        }
        current.bars += 1;
        totalBeats += beats;
      }
    }
  }
  // Estimate bpm from the time span of all lines but the last (whose end time we do not know).
  const span = lastTime - firstTime;
  // Beats here are metre beats (eighths in 6/8); convert to quarter-note bpm.
  const metreBpm = span > 0 && beatsAtLastTime > 0 ? (beatsAtLastTime / span) * 60 : 120;
  const bpm = Math.round(metreBpm * (4 / den));

  // Merge the tonic into a key guess: McGill only gives the tonic, mode is inferred from chords.
  const mode = guessMode(sections, header.tonic);

  return {
    meta: {
      id,
      title: header.title,
      artist: header.artist,
      bpm,
      beatsPerBar,
      beatUnit: den,
      tonic: header.tonic || undefined,
      mode,
      sources: ['mcgill'],
      ...(regions.length > 1 ? { remarks: [`metre changes (${regions.slice(0, 4).join(', ')}${regions.length > 4 ? ', ...' : ''}) keep their bar lengths on a constant ${num}/${den} grid of one bar per cycle`] } : {}),
    },
    sections: sections.filter((s) => s.chords.length > 0),
    tracks: [],
  };
}

function guessMode(sections: Section[], tonic: string): 'major' | 'minor' | undefined {
  if (!tonic) return undefined;
  let major = 0;
  let minor = 0;
  for (const s of sections) for (const c of s.chords) {
    if (!c.symbol) continue;
    const m = /^([A-G][b#]?)(m(?!aj)|dim)?/.exec(c.symbol);
    if (!m) continue;
    if (m[1] !== tonic) continue;
    if (m[2]) minor += c.beats; else major += c.beats;
  }
  if (major === 0 && minor === 0) return undefined;
  return minor > major ? 'minor' : 'major';
}
