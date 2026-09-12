/** Editable Strudel: small mini-notation phrases, reused explicitly in a full arrangement. */
import type { Song, Track, NoteEvent } from './types.js';
import { barLength, barStart, partName } from './midi.js';
import { gmName, drumName, percName, percTrim, NOMINAL_VOLUME } from './gm.js';
import { ACOUSTIC_DRUMS } from './acoustic-drums.js';
import { barRange, ident, noteName, soundFor, type CompileOptions } from './strudel.js';

const num = (x: number) => String(Number(x.toFixed(6)));
const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
// Prefer musical fractions only within 15 ms of the source. Source detail remains available for unquantized timing.
function tidy(beat: number, bpm: number): number {
  for (const d of [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 120, 192, 240, 480, 960]) {
    const rounded = Math.round(beat * d) / d;
    if (Math.abs(rounded - beat) <= bpm / 4000) return rounded;
  }
  return beat;
}
interface Bar { body: string; call: string; suffix: string }
const key = (b: Bar) => JSON.stringify(b);
function repetitions(tokens: string[]): string {
  const out: string[] = [];
  for (let i = 0; i < tokens.length;) {
    let j = i + 1; while (tokens[j] === tokens[i] && !tokens[i].includes('@')) j++;
    out.push(j - i > 1 ? `${tokens[i]}!${j - i}` : tokens[i]); i = j;
  }
  return out.join(' ');
}
function expression(bars: Bar[]): string {
  if (bars.every(b => b.body === '~')) return 'silence';
  if (bars.length > 1 && bars.every(b => key(b) === key(bars[0]))) return expression([bars[0]]);
  const b = bars[0];
  const body = bars.length === 1 ? b.body : `<${repetitions(bars.map(b => `[${b.body}]`))}>`;
  const quote = b.call === 'mini' ? "'" : '"';
  return `${b.call}(${quote}${body}${quote})${b.suffix}`;
}

function renderBars(t: Track, song: Song, firstBar: number, nBars: number, token: (n: NoteEvent) => string, compact = false) {
  const length = barLength(song.meta), from = barStart(song.meta, firstBar), end = barStart(song.meta, firstBar + nBars);
  const notes = t.notes.filter(n => n.start >= from && n.start < end).map(n => ({ ...n,
    start: compact ? n.start : Math.min(end - 1e-7, Math.max(from, tidy(n.start - from, song.meta.bpm) + from)),
    duration: compact ? n.duration : Math.max(1e-7, tidy(n.duration, song.meta.bpm)),
  }));
  const controls = (n: NoteEvent) => ({
    velocity: num(n.velocity), gain: num((n.volume ?? t.volume ?? NOMINAL_VOLUME) ** 2 * 0.8), pan: num(n.pan ?? t.pan ?? 0.5),
  });
  const keys = ['velocity', 'gain', 'pan'] as const;
  const first = notes[0] ? controls(notes[0]) : { velocity: '1', gain: '1', pan: '0.5' };
  const varying = keys.filter(k => notes.some(n => controls(n)[k] !== first[k]));
  const setters = keys.filter(k => !varying.includes(k)).map(k => `.${k}(${first[k]})`).join('');
  const buckets = Array.from({ length: nBars }, () => [] as NoteEvent[]);
  for (const n of notes) buckets[Math.min(nBars - 1, Math.floor((n.start - from) / length))].push(n);
  const shape = (g: NoteEvent[]) => g.map(n => n.pitch - Math.min(...g.map(n => n.pitch))).sort((a, b) => a - b).join(',');
  const sameControls = (g: NoteEvent[]) => g.every(n => num(n.duration) === num(g[0].duration) && JSON.stringify(controls(n)) === JSON.stringify(controls(g[0])));
  const allGroups = new Map<number, NoteEvent[]>();
  if (compact) for (const n of notes) { const g = allGroups.get(n.start) ?? []; g.push(n); allGroups.set(n.start, g); }
  const onsets = [...allGroups.keys()].sort((a, b) => a - b);
  const loopLegato = compact && onsets.every((at, i) => {
    const stop = Math.min(onsets[i + 1] ?? end, from + (Math.floor((at - from) / length) + 1) * length);
    return allGroups.get(at)!.every(n => Math.abs(n.duration - (stop - at)) < 1e-6);
  });
  const loopUniform = compact && notes.every(n => num(Math.min(n.duration, end - n.start) / length) === num(Math.min(notes[0].duration, end - notes[0].start) / length));
  const groupsAcrossLoop = [...allGroups.values()];
  const loopVoicing = compact && groupsAcrossLoop.length > 0 && groupsAcrossLoop.every(g => g.length > 1 && sameControls(g) && shape(g) === shape(groupsAcrossLoop[0]));
  const bars: Bar[] = buckets.map((ns, b) => {
    if (!ns.length) return { body: '~', call: t.role === 'drums' ? 'n' : 'note', suffix: '.legato(1)' };
    // 960,000 units per bar is only a numeric representation, not a rhythmic grid.
    const units = 960_000, groups = new Map<number, NoteEvent[]>();
    for (const n of ns) {
      const at = Math.min(units - 1, Math.max(0, Math.round((n.start - from - b * length) / length * units)));
      const group = groups.get(at) ?? []; group.push(n); groups.set(at, group);
    }
    const starts = [...groups.keys()].sort((a, b) => a - b);
    const spans = starts.map((s, i) => (starts[i + 1] ?? units) - s);
    // Factor repeated chord voicings into one root pattern and a transposition stack.
    let voicing = '';
    const chordGroups = [...groups.values()];
    if (t.role !== 'drums' && (!compact || loopVoicing) && chordGroups.every(g => g.length > 1)) {
      if (chordGroups.every(g => shape(g) === shape(chordGroups[0]) && sameControls(g))) {
        voicing = `.transpose("${shape(chordGroups[0])}")`;
        for (const [at, g] of groups) groups.set(at, [g.reduce((a, b) => a.pitch <= b.pitch ? a : b)]);
      }
    }
    const durations = ns.map(n => num(Math.min(n.duration, end - n.start) / length));
    const uniform = compact ? loopUniform : durations.every(d => d === durations[0]);
    const legato = compact ? loopLegato : starts.every((s, i) => groups.get(s)!.every(n => Math.abs(Math.min(n.duration, end - n.start) / length - spans[i] / units) < 1e-6));
    // Drum samples in a live-coding loop use their natural decay; MIDI key-release lengths
    // (often several bars for percussion) are not useful rhythmic instructions.
    const naturalDrums = compact && t.role === 'drums';
    const explicit = !naturalDrums && !legato && !uniform;
    const mapped = explicit || varying.length > 0;
    const weights = [...spans, ...(starts[0] ? [starts[0]] : [])];
    const divisor = weights.reduce(gcd);
    const parts: string[] = [];
    if (starts[0]) parts.push(starts[0] === divisor ? '~' : `~@${starts[0] / divisor}`);
    starts.forEach((s, i) => {
      const values = groups.get(s)!.map(n => [token(n), ...(explicit ? [num(Math.min(n.duration, end - n.start) / length)] : []), ...varying.map(k => controls(n)[k])].join(':'));
      const value = values.length > 1 ? `[${values.join(',')}]` : values[0];
      parts.push(value + (spans[i] === divisor ? '' : `@${spans[i] / divisor}`));
    });
    const mapping = [t.role === 'drums' ? 'n' : 'note', ...(explicit ? ['duration'] : []), ...varying];
    const suffix = (mapped ? `.as([${mapping.map(k => "'" + k + "'").join(', ')}])` : '') + (naturalDrums ? '' : legato ? '.legato(1)' : uniform ? `.duration(${durations[0]})` : '') + voicing;
    return { body: repetitions(parts), call: mapped ? 'mini' : t.role === 'drums' ? 'n' : 'note', suffix };
  });
  // A short loop uses one pattern per part; rests use the same controls as its sounding bars.
  const sounding = bars.find(b => b.body !== '~');
  if (compact && sounding) for (const bar of bars) if (bar.body === '~') { bar.call = sounding.call; bar.suffix = sounding.suffix; }
  return { bars, setters };
}

/** Greedy phrase dictionary: name repeated 1–4-bar phrases; inline one-off fills. */
function arrangePhrases(bars: Bar[], name: string, used: Set<string>) {
  const definitions: string[] = [], rows: { count: number; ref: string; start: number }[] = [];
  const dictionary = new Map<string, string>();
  const signatures = bars.map(key);
  const occurrences = new Map<string, { count: number; end: number }>();
  for (let n = 1; n <= 4; n++) for (let i = 0; i + n <= bars.length; i++) {
    const signature = signatures.slice(i, i + n).join('\n');
    const prior = occurrences.get(signature);
    if (!prior || i >= prior.end) occurrences.set(signature, { count: (prior?.count ?? 0) + 1, end: i + n });
  }
  for (let i = 0; i < bars.length;) {
    if (bars[i].body === '~') {
      let j = i + 1; while (j < bars.length && bars[j].body === '~') j++;
      rows.push({ count: j - i, ref: 'silence', start: i }); i = j; continue;
    }
    let size = 1, best = 0;
    for (let n = 1; n <= 4 && i + n <= bars.length; n++) {
      const phrase = bars.slice(i, i + n);
      if (!phrase.every(b => b.call === phrase[0].call && b.suffix === phrase[0].suffix)) continue;
      const matches = occurrences.get(signatures.slice(i, i + n).join('\n'))?.count ?? 0;
      const saving = (matches - 1) * (expression(phrase).length - name.length - 10);
      if (matches > 1 && saving > best) { size = n; best = saving; }
    }
    const phrase = bars.slice(i, i + size), signature = signatures.slice(i, i + size).join('\n');
    let ref = dictionary.get(signature);
    if (!ref && best > 0) {
      let id = dictionary.size + 1;
      while (used.has(`${name}_riff${id}`)) id++;
      ref = `${name}_riff${id}`;
      used.add(ref);
      dictionary.set(signature, ref);
      definitions.push(`const ${ref} = ${expression(phrase)}`);
    }
    ref ??= expression(phrase);
    const last = rows[rows.length - 1];
    if (last?.ref === ref) last.count += size;
    else rows.push({ count: size, ref, start: i });
    i += size;
  }
  const layout: string[] = [];
  let line = '  ';
  for (const row of rows) {
    const item = `[${row.count}, ${row.ref}],`;
    if (line.length > 2 && line.length + item.length > 100) { layout.push(line.trimEnd()); line = '  '; }
    line += item + ' ';
  }
  if (line.trim()) layout.push(line.trimEnd());
  return { definitions, arrangement: `arrange(\n${layout.join('\n')}\n)` };
}

export function compilePatterns(song: Song, opts: Required<CompileOptions>): string[] {
  const range = barRange(song, opts.maxBars);
  if (!range) return ['silence'];
  const selected = song.tracks.filter(t => !t.vocal && (opts.melody || t.role !== 'melody'));
  const lines = [opts.form === 'loop' ? '// Automatic main loop: edit these patterns to start live coding.' : '// Live coding: edit a riff once to change every repeat.', opts.form === 'loop' ? '// Full arrangement keeps the variations; Source detail keeps the unrounded events.' : '// Timing cleaned within 15 ms; choose Source detail for the unrounded events.', ''];
  const names: string[] = [], used = new Set<string>();
  const emit = (t: Track, base: string, token: (n: NoteEvent) => string, sound: string) => {
    if (!t.notes.length) return;
    let name = ident(base), i = 2; while (used.has(name)) name = `${ident(base)}_${i++}`; used.add(name);
    const { bars, setters } = renderBars(t, song, range.firstBar, range.nBars, token, opts.form === 'loop');
    if (bars.every(b => b.body === '~')) return;
    const compact = opts.form === 'loop';
    const compatible = bars.every(b => b.call === bars[0].call && b.suffix === bars[0].suffix);
    const { definitions, arrangement } = compact && compatible
      ? { definitions: [], arrangement: expression(bars) }
      : arrangePhrases(bars, name, used);
    names.push(name);
    lines.push(...(definitions.length ? [`// ${partName(t.name) || base}: reusable phrases`, ...definitions] : []), `// ${t.role} · ${base}`, `const ${name} = ${arrangement}`, `  ${setters}${sound}`, '');
  };
  for (const t of selected.filter(t => t.role !== 'drums').slice(0, opts.maxTracks)) {
    const sound = soundFor(t, opts.melodySound).sound;
    emit(t, t.role === 'bass' ? 'bass' : partName(t.name) || gmName(t.program).replace(/^gm_/, ''), n => noteName(n.pitch), `.s('${sound}')`);
  }
  for (const t of selected.filter(t => t.role === 'drums')) {
    for (const pitch of [...new Set(t.notes.map(n => n.pitch))].sort((a, b) => a - b)) {
      const acoustic = song.meta.drumKit === 'acoustic' ? ACOUSTIC_DRUMS[pitch] : undefined;
      const perc = percName(pitch);
      const sample = acoustic?.sample ?? perc?.sample ?? drumName(pitch);
      if (!sample) continue;
      const index = acoustic?.index ?? Number(perc?.token.split(':')[1] ?? 0);
      const trim = acoustic?.gain ?? (perc ? percTrim(perc.sample) : 1);
      const label = ({ 35: 'kick', 36: 'kick', 38: 'snare', 40: 'snare', 42: 'closed_hat', 44: 'pedal_hat', 46: 'open_hat', 49: 'crash', 51: 'ride' } as Record<number, string>)[pitch] ?? `percussion_${pitch}`;
      emit({ ...t, name: label, notes: t.notes.filter(n => n.pitch === pitch) }, label, () => String(index), `.s('${sample}')${trim === 1 ? '' : `.mul(gain(${trim}))`}`);
    }
  }
  lines.push('// Mix: mute a part here, or change its sound and effects above.', names.length ? opts.form === 'loop' ? `stack(${names.join(', ')})` : `stack(\n  ${names.join(',\n  ')}\n)` : 'silence');
  return lines;
}
