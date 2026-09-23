/** Note-event rendering: no rhythmic quantisation or averaged note velocities. */
import { ACOUSTIC_DRUMS } from './acoustic-drums.js';
import type { Song, Track, NoteEvent } from './types.js';
import { barLength, barStart, barIndex, partName } from './midi.js';
import { gmName, drumName, percName, percTrim, PERC_SAMPLES, NOMINAL_VOLUME } from './gm.js';
import { barRange, capTracks, noteName, soundFor, spellsFlats, uniqueNames, EARLY_BEATS, type CompileOptions } from './strudel.js';

// Integer timing weights keep Strudel's rational arithmetic bounded (100 million units per bar).
const UNITS = 100_000_000;
const number = (n: number) => String(Number(n.toFixed(8)));

/** Each bar contains exact onset weights in native Strudel functions; duration is independent of the next onset. */
function pattern(notes: NoteEvent[], song: Song, firstBar: number, bars: number, drum: boolean): string {
  const length = barLength(song.meta), end = barStart(song.meta, firstBar + bars);
  const buckets = Array.from({ length: bars }, () => [] as NoteEvent[]);
  const controls = (n: NoteEvent) => ({
    duration: Number(number(Math.max(1e-8, Math.min(n.duration, end - n.start) / length))),
    velocity: Number(number(n.velocity)),
    gain: Number(number((n.volume ?? 1) * (drum && song.meta.drumKit === 'acoustic' ? ACOUSTIC_DRUMS[n.pitch]?.gain ?? 1 : 1))),
    pan: Number(number(n.pan ?? 0.5)),
  });
  // A note just ahead of the first downbeat plays on it, ending when it did (see `barRange`).
  const downbeat = barStart(song.meta, firstBar);
  const included = notes.filter(n => n.start >= downbeat - EARLY_BEATS && n.start < end)
    .map(n => n.start >= downbeat ? n : { ...n, start: downbeat, duration: Math.max(1e-8, n.duration - (downbeat - n.start)) });
  const first = included[0] ? controls(included[0]) : { duration: 1, velocity: 1, gain: 1, pan: 0.5 };
  const keys = ['duration', 'velocity', 'gain', 'pan'] as const;
  const varying = keys.filter(key => included.some(n => controls(n)[key] !== first[key]));
  const constant = keys.filter(key => !varying.includes(key));
  for (const n of included) {
    const b = barIndex(song.meta, n.start) - firstBar;
    if (b >= 0 && b < bars) buckets[b].push(n);
  }
  const rows = buckets.map((ns, b) => {
    if (!ns.length) return 'silence';
    const from = barStart(song.meta, firstBar + b);
    const groups = new Map<number, NoteEvent[]>();
    for (const n of ns) {
      const onset = Math.min(UNITS - 1, Math.max(0, Math.round((n.start - from) / length * UNITS)));
      const group = groups.get(onset) ?? [];
      group.push(n); groups.set(onset, group);
    }
    const starts = [...groups.keys()].sort((a, b) => a - b);
    const tokens: string[] = [];
    if (starts[0] > 0) tokens.push(`[${number(starts[0])}, silence]`);
    starts.forEach((start, i) => {
      const values = groups.get(start)!.map(n => {
        const values = controls(n);
        const suffix = varying.map(key => number(values[key]));
        if (drum) {
          const acoustic = song.meta.drumKit === 'acoustic' ? ACOUSTIC_DRUMS[n.pitch] : undefined;
          const token = acoustic ? `${acoustic.sample}:${acoustic.index}` : percName(n.pitch)?.token ?? `${drumName(n.pitch)}:0`;
          const [sample, index] = token.split(':');
          return `pure(['${sample}', ${index}, ${suffix.join(', ')}])`;
        }
        return `pure(['${noteName(n.pitch, spellsFlats(song.meta))}', ${suffix.join(', ')}])`;
      });
      const value = values.length === 1 ? values[0] : `stack(${values.join(', ')})`;
      tokens.push(`[${number((starts[i + 1] ?? UNITS) - start)}, ${value}]`);
    });
    return `timecat(${tokens.join(', ')})`;
  });
  const compact: string[] = [];
  for (let i = 0; i < rows.length;) {
    let j = i + 1; while (rows[j] === rows[i]) j++;
    compact.push(`[${j - i}, ${rows[i]}]`); i = j;
  }
  // Native timecat/pure bypass the expensive mini-notation parser. Single-quoted strings stay literal in the REPL.
  const mapping = [...(drum ? ['s', 'n'] : ['note']), ...varying].map(key => `'${key}'`).join(', ');
  const setters = constant.map(key => `.${key}(${number(first[key])})`).join('');
  return `arrange(\n  ${compact.join(',\n  ')}\n).as([${mapping}])${setters}`;
}

export function compilePerformance(song: Song, opts: Required<CompileOptions>): string[] {
  const range = barRange(song, opts.maxBars);
  if (!range) return ['silence'];
  const { firstBar, nBars } = range;
  const selected = song.tracks.filter(t => !t.vocal && (opts.melody || t.role !== 'melody'));
  const pitched = capTracks(selected.filter(t => t.role !== 'drums'), opts.maxTracks);
  const lines = ['// Instrumental transcription: detected vocal parts omitted.', '// Original note onsets, durations and velocities; no rhythmic quantisation.', ''];
  if (song.meta.drumKit === 'acoustic') lines.push('// Acoustic drums: recorded VCSL percussion; cymbal/tom variants are approximations.', '');
  const removed = song.tracks.filter(t => t.vocal);
  if (removed.length) lines.push(`// Omitted vocals: ${removed.map(t => partName(t.name) || gmName(t.program)).join(', ')}`, '');
  if (pitched.length < selected.filter(t => t.role !== 'drums').length) lines.push('// Track cap omits some instrumental parts.', '');
  const names: string[] = [];
  const uniqueName = uniqueNames();
  const emit = (t: Track, notes: NoteEvent[], base: string, sound?: string, trim = 1, fallback?: string) => {
    if (!notes.length) return;
    const name = uniqueName(base, fallback);
    names.push(name);
    // Preserve relative channel levels, without boosting quiet instrumental lines.
    const gain = trim * 0.8;
    lines.push(`// ${t.role} · ${partName(t.name) || base}${sound ? ` · ${sound}` : ''}`);
    lines.push(`const ${name} = ${pattern(notes, song, firstBar, nBars, t.role === 'drums')}`);
    lines.push(`  ${sound ? `.s('${sound}')` : ''}.mul(gain(${number(gain)}))`, '');
  };
  for (const t of pitched) {
    // Absolute onset controller levels preserve unmuting even when the track's median is zero.
    const notes = t.notes.map(n => ({ ...n, volume: (n.volume ?? t.volume ?? NOMINAL_VOLUME) ** 2, pan: n.pan ?? t.pan }));
    const patch = gmName(t.program).replace('gm_', '');
    emit(t, notes, t.role === 'bass' ? 'bass' : partName(t.name) || patch, soundFor(t, opts.melodySound).sound, 1, patch);
  }
  for (const t of selected.filter(t => t.role === 'drums')) {
    const groups = new Map<string, NoteEvent[]>();
    for (const n of t.notes) {
      const key = percName(n.pitch)?.sample ?? (drumName(n.pitch) ? 'drums' : null);
      if (!key) continue;
      const ns = groups.get(key) ?? []; ns.push({ ...n, volume: (n.volume ?? t.volume ?? NOMINAL_VOLUME) ** 2, pan: n.pan ?? t.pan }); groups.set(key, ns);
    }
    for (const [key, ns] of groups) emit(t, ns, PERC_SAMPLES[key]?.label ?? key, undefined, key === 'drums' ? 1 : percTrim(key));
  }
  if (!names.length) lines.push('// No separate instrumental parts remain with these options.');
  lines.push(names.length ? `stack(${names.join(', ')})` : 'silence');
  return lines;
}
