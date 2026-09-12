/** Discover a short coherent instrumental passage; never assemble unrelated song parts. */
import type { Song, Track } from './types.js';
import { barLength, barStart, detectSectionsFromMidi } from './midi.js';
import { barRange, type CompileOptions } from './strudel.js';

export interface LoopSelection { song: Song; firstBar: number; bars: number; repeats: number; omittedTracks: number }
export function selectLoop(source: Song, opts: CompileOptions = {}): LoopSelection {
  const originalMeter = `${source.meta.beatsPerBar}/${source.meta.beatUnit}`;
  const regrouped = barLength(source.meta) > 16 || source.meta.beatsPerBar > 32;
  // Extreme source metres can turn two bars into minutes of music. Keep elapsed quarter-note
  // positions, but use an explicitly disclosed four-beat editing grid for these sketches.
  if (regrouped && source.tracks.length) source = { ...source, meta: { ...source.meta, beatsPerBar: 4, beatUnit: 4, barOffset: 0 } };
  if (!source.tracks.length && source.sections.length) {
    const chorus = source.sections.find(s => /chorus|refrain/i.test(s.label));
    const section = chorus ?? source.sections.find(s => s.bars >= 4) ?? source.sections[0];
    const firstBar = source.sections.slice(0, source.sections.indexOf(section)).reduce((n, s) => n + s.bars, 0);
    const bars = Math.min(4, section.bars);
    let remaining = bars * source.meta.beatsPerBar;
    const chords = section.chords.flatMap(c => {
      if (remaining <= 0) return [];
      const beats = Math.min(remaining, c.beats); remaining -= beats; return [{ ...c, beats }];
    });
    const song = { ...source, meta: { ...source.meta, loopBars: bars, remarks: [`Main loop: generated accompaniment from ${section.label}, source bars ${firstBar + 1}–${firstBar + bars}. This is a chord-chart excerpt.`] }, sections: [{ ...section, bars, chords }] };
    return { song, firstBar, bars, repeats: 1, omittedTracks: 0 };
  }
  const range = barRange(source, Number.MAX_SAFE_INTEGER);
  if (!range || !source.tracks.length) return { song: source, firstBar: 0, bars: 0, repeats: 0, omittedTracks: 0 };
  const length = barLength(source.meta), origin = barStart(source.meta, range.firstBar);
  const tracks = source.tracks.filter(t => !t.vocal && (opts.melody !== false || t.role !== 'melody'));
  if (!tracks.length) return { song: source, firstBar: range.firstBar, bars: range.totalBars, repeats: 0, omittedTracks: 0 };
  const buckets = tracks.map(t => {
    const rows = Array.from({ length: range.totalBars }, () => [] as Track['notes']);
    for (const n of t.notes) {
      const b = Math.max(0, Math.min(rows.length - 1, Math.floor((n.start - origin + 0.002) / length)));
      rows[b].push(n);
    }
    return rows;
  });
  const barKeys = Array.from({ length: range.totalBars }, (_, b) => buckets.map((rows, i) => {
    const notes = rows[b].map(n => `${n.pitch}:${Math.round((n.start - origin - b * length) / length * 16)}`).sort();
    return notes.length ? `${i}=${notes.join(',')}` : '';
  }).join('|'));
  let best = { first: 0, bars: Math.min(2, range.totalBars), repeats: 1, score: -Infinity };
  for (const bars of [...new Set([Math.min(2, range.totalBars), Math.min(4, range.totalBars)])]) {
    const counts = new Map<string, number>();
    for (let b = 0; b + bars <= range.totalBars; b += bars) {
      const key = barKeys.slice(b, b + bars).join('/'); counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (let b = 0; b + bars <= range.totalBars; b += bars) {
      const parts = buckets.map(rows => rows.slice(b, b + bars).flat());
      const active = parts.map((ns, i) => ({ t: tracks[i], ns })).filter(p => p.ns.length);
      if (!active.length) continue;
      const pitched = active.filter(p => p.t.role !== 'drums');
      if (!pitched.length && tracks.some(t => t.role !== 'drums')) continue;
      const repeats = counts.get(barKeys.slice(b, b + bars).join('/')) ?? 1;
      const roles = new Set(active.map(p => p.t.role));
      const pcs = new Set(pitched.flatMap(p => p.ns.map(n => n.pitch % 12)));
      const density = pitched.reduce((n, p) => n + p.ns.length, 0) / bars;
      const score = Math.log2(1 + repeats * bars) * 2 + (roles.has('bass') ? 2 : 0) + (roles.has('drums') ? 2 : 0)
        + Math.min(pitched.length, 2) + Math.min(pcs.size, 6) * 0.15 - bars * 0.15 - Math.max(0, density - 48) * 0.05;
      if (score > best.score) best = { first: b, bars, repeats, score };
    }
  }
  const start = origin + best.first * length, end = start + best.bars * length;
  const onsetTracks = tracks.filter(t => t.notes.some(n => n.start >= start - 0.002 && n.start < end - 0.002));
  const excerpt = (onsetTracks.length ? onsetTracks : tracks).map(t => ({ ...t, notes: t.notes.filter(n => n.start < end - 0.002 && n.start + n.duration > start + 0.002).map(n => {
    const at = Math.max(0, n.start - start), stop = Math.min(end, n.start + n.duration) - start;
    return { ...n, start: at, duration: Math.max(0.000001, stop - at) };
  }) })).filter(t => t.notes.length);
  const weight = (t: Track) => (t.role === 'bass' ? 1000 : t.role === 'melody' ? 500 : 0)
    + Math.min(100, t.notes.reduce((n, e) => n + e.duration * e.velocity * (e.volume ?? t.volume ?? 0.8), 0));
  const cap = Math.max(1, Math.min(4, opts.maxTracks ?? 4));
  const pitched = excerpt.filter(t => t.role !== 'drums').sort((a, b) => weight(b) - weight(a)).slice(0, cap);
  const selected = [...pitched, ...excerpt.filter(t => t.role === 'drums')];
  const drumWeights = new Map<number, number>();
  for (const t of selected.filter(t => t.role === 'drums')) for (const n of t.notes) {
    drumWeights.set(n.pitch, (drumWeights.get(n.pitch) ?? 0) + n.velocity);
  }
  const drumPriority = (pitch: number) => [35, 36, 38, 40, 42, 44, 46].includes(pitch) ? 1000 : 0;
  const drumVoices = [...drumWeights.keys()].sort((a, b) => drumPriority(b) - drumPriority(a) || drumWeights.get(b)! - drumWeights.get(a)!).slice(0, 6);
  for (const t of selected.filter(t => t.role === 'drums')) t.notes = t.notes.filter(n => drumVoices.includes(n.pitch));
  // A compact loop is a musical sketch: one shared rhythmic grid and stable channel controls.
  // Full arrangement/source detail retain the performance-level articulation and dynamics.
  const onsets = selected.flatMap(t => t.notes.map(n => n.start / length));
  const grid = [8, 12, 16, 24, 32].find(g => onsets.filter(at => Math.abs(Math.round(at * g) / g - at) * length * 60 / source.meta.bpm <= 0.025).length >= onsets.length * 0.95) ?? 32;
  const step = length / grid;
  const median = (ns: number[]) => [...ns].sort((a, b) => a - b)[Math.floor(ns.length / 2)] ?? 0;
  for (const track of selected) {
    track.volume = median(track.notes.map(n => n.volume ?? track.volume ?? 0.8));
    track.pan = Math.round(median(track.notes.map(n => n.pan ?? track.pan ?? 0.5)) * 10) / 10;
    const typicalVelocity = median(track.notes.map(n => n.velocity));
    const drumGate = Math.max(step, Math.round(median(track.notes.map(n => n.duration)) / step) * step);
    const attacks = new Map<string, Track['notes'][number]>();
    for (const note of track.notes) {
      const start = Math.min(best.bars * length - step, Math.max(0, Math.round(note.start / step) * step));
      const duration = track.role === 'drums' ? drumGate : Math.min(best.bars * length - start, Math.max(step, Math.round(note.duration / step) * step));
      const velocity = Math.round((note.velocity < typicalVelocity * 0.65 ? typicalVelocity * 0.5 : typicalVelocity) * 10) / 10;
      const key = `${start}:${note.pitch}`;
      const prior = attacks.get(key);
      if (!prior || prior.velocity < velocity) attacks.set(key, { pitch: note.pitch, start, duration, velocity });
    }
    track.notes = [...attacks.values()].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  }
  const omittedTracks = excerpt.length - selected.length;
  const song: Song = { meta: { ...source.meta, barOffset: 0, remarks: [
    `Main loop: source bars ${range.firstBar + best.first + 1}–${range.firstBar + best.first + best.bars}; ${best.repeats} matching passages found. This is an excerpt, not the full song.`,
    ...(source.meta.remarks ?? []).filter(r => r.startsWith('Transcription provider:')),
    ...(regrouped ? [`Source metre ${originalMeter} regrouped on a 4/4 editing grid for this short excerpt.`] : []),
    `Simplified automatically on a ${grid}-step bar grid; articulation and dynamics are reduced for editing.`,
    ...(omittedTracks ? [`${omittedTracks} secondary instrumental parts omitted from the compact loop.`] : []),
    ...(drumWeights.size > drumVoices.length ? [`${drumWeights.size - drumVoices.length} secondary percussion voices omitted from the compact loop.`] : []),
  ] }, tracks: selected, sections: [] };
  song.sections = detectSectionsFromMidi(song);
  // A rest at the end still belongs to the loop. Store the chosen length explicitly.
  song.meta.loopBars = best.bars;
  return { song, firstBar: range.firstBar + best.first, bars: best.bars, repeats: best.repeats, omittedTracks };
}
