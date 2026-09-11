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

export function parseMcgillHeader(text: string): McgillHeader {
  const h: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^#\s*(\w+):\s*(.*)$/.exec(line.trim());
    if (m) h[m[1]] = m[2].trim();
  }
  return { title: h.title ?? '', artist: h.artist ?? '', metre: h.metre ?? '4/4', tonic: h.tonic ?? '' };
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

/** Expand one bar's tokens into chord events. Returns the events and the number of beats in the bar. */
function expandBar(tokens: string[], defaultBeats: number, prev: string | null): { events: ChordEvent[]; beats: number; last: string | null } {
  let beats = defaultBeats;
  const chordTokens: string[] = [];
  for (const t of tokens) {
    const metre = /^\((\d+)\/(\d+)\)$/.exec(t);
    if (metre) { beats = Number(metre[1]); continue; }
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
  const [num, den] = header.metre.split('/').map(Number);
  const beatsPerBar = num || 4;
  const lines = text.split('\n').map(parseLine).filter((l): l is RawLine => !!l);

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
        const { events, beats, last } = expandBar(bar.split(/\s+/), beatsPerBar, prevChord);
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
  const bpm = Math.round(metreBpm * (4 / (den || 4)));

  // Merge the tonic into a key guess: McGill only gives the tonic, mode is inferred from chords.
  const mode = guessMode(sections, header.tonic);

  return {
    meta: {
      id,
      title: header.title,
      artist: header.artist,
      bpm,
      beatsPerBar,
      beatUnit: den || 4,
      tonic: header.tonic || undefined,
      mode,
      sources: ['mcgill'],
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
