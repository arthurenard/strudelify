import type { CompileOptions } from '../src/strudel.js';
import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { compile as compileSource, noteName, timeline, chordSummary, chooseGrid, songGrid, gridCandidates, gainsFor, panFor, selectTracks, mixParts, barRange, PAN_WIDTH_LEAD, VOCAL_LEAD_FLOOR, BACKING_VOCAL_RATIO, INSTRUMENT_LEAD_FLOOR, LEAD_OVERLAP_SHARE, LEAD_FLOOR_MIN_COVERAGE } from '../src/strudel.js';
import { AUDIBLE_LEVEL, percShare } from '../src/gm.js';
import { hash2code, shareUrl } from '../src/share.js';
import type { Song, Track, NoteEvent } from '../src/types.js';

// These assertions cover the optional compact-grid renderer; performance.test.ts covers the default.
const compile = (song: Parameters<typeof compileSource>[0], opts: CompileOptions = {}) => compileSource(song, { timing: 'grid', ...opts });

function song(): Song {
  return {
    meta: { id: 's', title: 'T', artist: 'A', bpm: 120, beatsPerBar: 4, beatUnit: 4, tonic: 'C', mode: 'major', sources: ['midi'] },
    sections: [],
    tracks: [
      { name: 'lead', program: 73, role: 'melody', notes: [
        { pitch: 60, start: 0, duration: 1, velocity: 0.8 },
        { pitch: 64, start: 1, duration: 1, velocity: 0.8 },
        { pitch: 67, start: 2, duration: 2, velocity: 0.8 },
        // bar 2 identical to bar 1
        { pitch: 60, start: 4, duration: 1, velocity: 0.8 },
        { pitch: 64, start: 5, duration: 1, velocity: 0.8 },
        { pitch: 67, start: 6, duration: 2, velocity: 0.8 },
        // bar 3: chord + rest
        { pitch: 60, start: 8, duration: 2, velocity: 0.8 },
        { pitch: 64, start: 8, duration: 2, velocity: 0.8 },
      ] },
      { name: '', program: 33, role: 'bass', notes: [{ pitch: 36, start: 0, duration: 4, velocity: 0.9 }] },
      { name: 'kit', program: -1, role: 'drums', notes: [
        { pitch: 36, start: 0, duration: 0.25, velocity: 1 }, { pitch: 42, start: 0, duration: 0.25, velocity: 1 },
        { pitch: 38, start: 1, duration: 0.25, velocity: 1 },
        { pitch: 63, start: 2, duration: 0.25, velocity: 1 }, // open high conga: a VCSL layer of its own
        { pitch: 75, start: 3, duration: 0.25, velocity: 1 }, // claves: a VCSL layer of its own
      ] },
    ],
  };
}

function line(pitch: number, bars: number, velocity = 0.8, from = 0): NoteEvent[] {
  const out: NoteEvent[] = [];
  for (let b = 0; b < bars; b++) for (let i = 0; i < 4; i++) out.push({ pitch, start: from + b * 4 + i, duration: 0.5, velocity });
  return out;
}

describe('compile (MIDI tracks)', () => {
  it('does not use JavaScript keywords or Strudel functions as part identifiers', () => {
    for (const name of ['New', 'This', 'default', 'note', 'stack', 's', 'mini']) {
      const s = song();
      s.tracks[0] = { ...s.tracks[0], name, role: 'other' };
      const code = compile(s);
      expect(() => new vm.Script(code)).not.toThrow();
      expect(code).toContain(`const part_${name.toLowerCase()} =`);
    }
  });
  const code = compile(song());
  it('sets one cycle per bar', () => {
    expect(code).toContain('setcpm(30.00)');
  });
  it('quantises notes to a 16-cell grid with elongation and rests', () => {
    expect(code).toContain('const melody = note("<[c4@4 e4@4 g4@8]!2 [[c4,e4]@8 ~@8]>")');
  });
  it('keeps an instrumental melody on its own instrument and says why', () => {
    expect(code).toContain('// melody · "lead" · gm_flute · instrumental lead, keeps its own instrument · gain');
    expect(code).toContain('.s("gm_flute")');
    expect(code).not.toContain('gm_lead_2_sawtooth');
  });
  it('holds long bass notes and pads empty bars', () => {
    expect(code).toContain('const bass = note("<c2 ~!2>")');
    expect(code).toContain('gm_electric_bass_finger');
  });
  it('maps percussion keys to the kit, and hand percussion to a VCSL layer per instrument at a trimmed gain', () => {
    expect(code).toContain('const drums = s("<[[bd,hh] ~@3 sd ~@11] ~!2>")');
    // The conga and the claves are not in the kit: each is a layer of its own, named after the instrument, on the
    // sample's loudest normal hit, and its gain is the kit's (1 here) times the trim that brings the quiet VCSL
    // sample to the kit's level (+10.1 dB for the congas, +13.8 dB for the claves, held under the peak ceiling).
    expect(code).toContain("// drums · congas · VCSL conga sample (GM key 63), trimmed +10.1 dB (x3.2) to the kit's level · gain 3.2");
    expect(code).toContain('const congas = s("<[~@8 conga:18 ~@7] ~!2>")\n  .gain(3.2)');
    expect(code).toContain("// drums · claves · VCSL clave sample (GM key 75), trimmed +13.8 dB (x4.9) to the kit's level · gain 4.9");
    expect(code).toContain('const claves = s("<[~@12 clave:2 ~@3] ~!2>")\n  .gain(4.9)');
    expect(code).toContain('stack(melody, bass, drums, congas, claves)');
  });
  it('can leave out the melody', () => {
    const noMelody = compile(song(), { melody: false });
    expect(noMelody).not.toContain('melody');
    expect(noMelody).toContain('stack(bass, drums, congas, claves)');
  });
});

describe('vocal exclusion in compact mode', () => {
  it('omits all vocal parts even when a replacement sound is supplied', () => {
    const s = song(); s.tracks[0].vocal = true;
    s.tracks.push({ ...s.tracks[0], name: 'Backing', role: 'chords' });
    const code = compile(s, { melodySound: 'triangle' });
    expect(code).not.toContain('const melody =');
    expect(code).not.toContain('const backing =');
    expect(selectTracks(s, 12, true).every(t => !t.vocal)).toBe(true);
  });

  it('ignores melodySound for instrumental melodies', () => {
    expect(compile(song(), { melodySound: 'triangle' })).toContain('.s("gm_flute")');
  });
});

describe('mix', () => {
  it('turns levels into gains: nominal part at 0.8, ratios kept when something is louder than 1', () => {
    expect(gainsFor([0.75])).toEqual([0.8]);
    expect(gainsFor([0.75, 0.375])).toEqual([0.8, 0.4]);
    expect(gainsFor([1.5, 0.75])).toEqual([1, 0.5]); // scaled together, not clipped
    expect(gainsFor([0.75, 0.01])).toEqual([0.8, 0.15]); // floor
  });
  it('folds channel volume into the gain and emits pan from CC 10 with 80% width, 50% for the lead', () => {
    const s = song();
    s.tracks[0] = { ...s.tracks[0], pan: 0 };
    s.tracks[1] = { ...s.tracks[1], pan: 0.9 };
    s.tracks.push({ name: 'keys', program: 0, role: 'other', notes: line(60, 3), volume: 0.5, pan: 0 });
    const code = compile(s);
    // (0.5 / 0.787)^2 * 0.8 velocity = 0.32 level, times the nominal 1.067 (the kit does not set the scale).
    expect(code).toMatch(/const keys = note\("[^"]+"\)\n {2}\.s\("gm_piano"\)\.gain\(0\.34\)\.pan\(0\.1\)/);
    // The lead is hard left in the file but no real mix pans a lead hard, so it sits at a quarter.
    expect(code).toMatch(/const melody = note\("[^"]+"\)\n {2}\.s\("gm_flute"\)\.gain\(0\.85\)\.pan\(0\.25\)/);
    expect(code).toContain('.s("gm_electric_bass_finger").gain(0.96).pan(0.82)');
    expect(code).toContain('gain 0.34 · pan 0.1');
    expect(PAN_WIDTH_LEAD).toBe(0.5);
  });
  it('leaves near-centre pans alone', () => {
    expect(panFor(undefined)).toBeUndefined();
    expect(panFor(0.5)).toBeUndefined();
    expect(panFor(0.53)).toBeUndefined();
    expect(panFor(0.25)).toBe(0.3);
    expect(panFor(0, PAN_WIDTH_LEAD)).toBe(0.25);
  });
  it('prints the analysis notes of a part (a pan or level that moves) in its comment', () => {
    const s = song();
    s.tracks[0] = { ...s.tracks[0], pan: 0.25, remarks: ['pan moves 0-64 (CC 10), mean used'] };
    expect(compile(s)).toContain('// melody · "lead" · gm_flute · instrumental lead, keeps its own instrument · gain 0.85 · pan 0.38 · pan moves 0-64 (CC 10), mean used');
  });
  it('scales a dense mix down for headroom, judged by the loudest bar', () => {
    const s = song();
    s.tracks[2].notes = s.tracks[2].notes.filter((n) => n.pitch < 60); // the kit alone: the hand-percussion layers are checked below
    for (let i = 0; i < 9; i++) s.tracks.push({ name: `pad${i}`, program: 88 + i, role: 'chords', notes: line(60 + i, 3, 0.9) });
    const code = compile(s);
    expect(code).toMatch(/\/\/ mix: up to 12 parts sound at once \(gains summing to \d+\.\d\), all gains scaled by 0\.\d+ for headroom/);
    const gains = [...code.matchAll(/\.gain\(([\d.]+)\)/g)].map((m) => Number(m[1]));
    expect(gains.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(7.1);
  });
  it('does not scale the mix when the loud parts never overlap', () => {
    // Nine pads at 0.96 each, but each in its own bar: never more than ~2 gains sound at once.
    const s = song();
    for (let i = 0; i < 9; i++) s.tracks.push({ name: `pad${i}`, program: 88 + i, role: 'chords', notes: line(60 + i, 1, 0.9, 12 + i * 4) });
    const code = compile(s);
    expect(code).not.toContain('for headroom');
    expect(mixParts([{ level: 0.75, active: [true, false] }, { level: 0.75, active: [false, true] }])).toEqual({ gains: [0.8, 0.8] });
    const stacked = mixParts(Array.from({ length: 10 }, () => ({ level: 0.75, active: [true] })));
    expect(stacked.gains.every((g) => g === 0.7)).toBe(true);
    expect(stacked.remark).toBe('mix: up to 10 parts sound at once (gains summing to 8.0), all gains scaled by 0.88 for headroom');
  });
  it('leaves the gains alone, without a remark, when the scale for headroom would round to 1.00', () => {
    // Seven parts at gain 1 plus a hand-percussion layer counted at 2%: a peak of 7.02 scales by 0.997, i.e. by nothing.
    const parts = Array.from({ length: 7 }, () => ({ level: 0.9375, active: [true] }));
    expect(mixParts([...parts, { level: 0.9375, active: [true], share: 0.02 }])).toEqual({ gains: Array(8).fill(1) });
    // One more such layer (7.04) rounds to 0.99 and is scaled.
    const scaled = mixParts([...parts, { level: 0.9375, active: [true], share: 0.02 }, { level: 0.9375, active: [true], share: 0.02 }]);
    expect(scaled.remark).toBe('mix: up to 9 parts sound at once (gains summing to 7.0), all gains scaled by 0.99 for headroom');
    expect(scaled.gains.every((g) => g === 0.99)).toBe(true);
  });
  it('leaves out parts that are inaudible in the file instead of lifting them to the gain floor', () => {
    const s = song();
    s.tracks.push({ name: 'guide', program: 0, role: 'chords', notes: line(60, 3, 0.01) });
    s.tracks.push({ name: 'faded', program: 0, role: 'chords', notes: line(64, 3, 0.9), volume: 0.2 });
    expect(selectTracks(s, 12, true).map((t) => t.name)).toEqual(['lead', '']);
    const code = compile(s);
    expect(code).not.toContain('guide');
    expect(code).not.toContain('faded');
    expect(code).not.toContain('.gain(0.15)');
    expect(AUDIBLE_LEVEL).toBe(0.08);
  });
  it('ignores a stub of a few notes: it neither takes a slot nor changes the other gains', () => {
    const s = song();
    s.tracks[0].notes = line(72, 40); // a real song's worth of melody
    const before = compile(s);
    s.tracks.push({ name: 'stray', program: 30, role: 'other', notes: [{ pitch: 66, start: 9, duration: 0.5, velocity: 0.3 }, { pitch: 66, start: 10, duration: 0.5, velocity: 0.3 }, { pitch: 68, start: 11, duration: 0.5, velocity: 0.3 }] });
    const after = compile(s);
    expect(after).not.toContain('stray');
    expect([...after.matchAll(/\.gain\(([\d.]+)\)/g)].map((m) => m[1])).toEqual([...before.matchAll(/\.gain\(([\d.]+)\)/g)].map((m) => m[1]));
    // A few notes that carry real weight (an orchestra hit four times at full velocity) stay.
    s.tracks.push({ name: 'hits', program: 55, role: 'other', notes: [0, 2, 4, 6].map((b) => ({ pitch: 72, start: b, duration: 2, velocity: 1 })) });
    expect(compile(s)).toContain('const hits = ');
    // A lone note is dropped unless it is a drone that carries real weight.
    s.tracks.push({ name: 'stuck', program: 88, role: 'other', notes: [{ pitch: 60, start: 20, duration: 4, velocity: 0.8 }] });
    s.tracks.push({ name: 'drone', program: 89, role: 'other', notes: [{ pitch: 48, start: 0, duration: 160, velocity: 0.6 }] });
    const code = compile(s);
    expect(code).not.toContain('stuck');
    expect(code).toContain('const drone = ');
  });
  it('splits quiet drum hits into a ghost-note layer', () => {
    const s = song();
    const kit: NoteEvent[] = [];
    for (let b = 0; b < 4; b++) {
      kit.push({ pitch: 36, start: b * 4, duration: 0.25, velocity: 1 }, { pitch: 38, start: b * 4 + 2, duration: 0.25, velocity: 0.95 });
      for (let i = 0; i < 4; i++) kit.push({ pitch: 38, start: b * 4 + i + 0.5, duration: 0.1, velocity: 0.25 }); // ghosts
    }
    s.tracks[2] = { name: 'kit', program: -1, role: 'drums', notes: kit };
    const code = compile(s);
    expect(code).toContain('const drums = s("<[bd ~@7 sd ~@7]!4>")');
    expect(code).toContain('const drums_ghost = s("<[~@2 sd ~@3 sd ~@3 sd ~@3 sd ~]!4>")');
    // The kit's level is its 80th-percentile velocity (0.95 here: the snare's backbeat, not the kick's 1.0), so the
    // ghosts get 0.4 x 0.95 x 1.067 (nominal scale) = 0.41 while the kit itself is clipped at 1.
    expect(code).toMatch(/drums_ghost = [^\n]+\n {2}\.gain\(0\.41\)/);
    expect(code).toContain('stack(melody, bass, drums, drums_ghost)');
  });
});

describe('hand percussion', () => {
  const kit = (hits: [number, number, number?][]): Track => ({ name: 'kit', program: -1, role: 'drums', notes: hits.map(([pitch, start, velocity]) => ({ pitch, start, duration: 0.25, velocity: velocity ?? 1 })) });
  it('renders a Latin kit as one VCSL layer per instrument, with the variant per key and the trim in the comment', () => {
    const s = song();
    const hits: [number, number, number?][] = [];
    for (let b = 0; b < 2; b++) {
      hits.push([36, b * 4], [42, b * 4 + 1], [38, b * 4 + 2], [42, b * 4 + 3]);
      hits.push([62, b * 4], [63, b * 4 + 1], [64, b * 4 + 2], [60, b * 4 + 2.5], [61, b * 4 + 3]);
      hits.push([67, b * 4 + 0.5], [68, b * 4 + 1.5], [74, b * 4 + 2], [69, b * 4 + 3.5], [81, b * 4 + 3]);
    }
    s.tracks[2] = kit(hits);
    const code = compile(s);
    expect(code).toContain('const drums = s("<[bd ~@3 hh ~@3 sd ~@3 hh ~@3]!2 ~>")');
    // Mute high conga = a muted quinto hit, open high conga = the quinto, low conga = the tumba.
    expect(code).toContain('const congas = s("<[conga:13 ~@3 conga:18 ~@3 conga:33 ~@7]!2 ~>")');
    expect(code).toContain('const bongos = s("<[~@10 bongo:4 ~ bongo:18 ~@3]!2 ~>")');
    expect(code).toContain('const agogo_bells = s("<[~@2 agogo:2 ~@3 agogo:4 ~@9]!2 ~>")');
    expect(code).toContain('const guiro = s("<[~@8 guiro:4 ~@7]!2 ~>")'); // the long guiro is the slow scrape
    expect(code).toContain('const cabasa = s("<[~@14 cabasa:4 ~]!2 ~>")');
    expect(code).toContain('const triangle = s("<[~@12 triangles:35 ~@3]!2 ~>")');
    expect(code).toContain("// drums · bongos · VCSL bongo samples (GM keys 60, 61), trimmed +8.4 dB (x2.63) to the kit's level · gain 2.63");
    expect(code).toContain("// drums · guiro · VCSL guiro sample (GM key 74), trimmed +26.5 dB (x21.13) to the kit's level · gain 21.13");
    expect(code).toContain('stack(melody, bass, drums, congas, agogo_bells, guiro, bongos, triangle, cabasa)'); // layers in order of their first hit
    // The trims are applied to the emitted gain only, and a layer counts towards the headroom at its amplitude
    // relative to the kit (0.55 for congas and bongos, 0.28 for the small instruments): six such layers over a
    // kit, a bass and a melody are not a dense moment.
    expect(code).not.toContain('for headroom');
    expect(percShare('conga')).toBe(0.55);
    expect(percShare('triangles')).toBe(0.28);
    const eight = (share?: number) => Array.from({ length: 8 }, () => ({ level: 1, active: [true], share }));
    expect(mixParts(eight()).remark).toContain('for headroom');
    expect(mixParts(eight(0.28)).remark).toBeUndefined();
  });
  it('emits no kit layer when no key of the kit is playable, and no drums at all when nothing is', () => {
    const s = song();
    s.tracks[2] = kit([[63, 0], [63, 1], [63, 2], [63, 3]]);
    const congasOnly = compile(s);
    expect(congasOnly).not.toContain('const drums');
    expect(congasOnly).toContain('const congas = s("<[conga:18 ~@3 conga:18 ~@3 conga:18 ~@3 conga:18 ~@3] ~!2>")');
    expect(congasOnly).toContain('stack(melody, bass, congas)');
    s.tracks[2] = kit([[78, 0], [79, 1], [27, 2], [33, 3]]); // cuicas, a GS click and scratch: no sample anywhere
    const nothing = compile(s);
    expect(nothing).not.toContain('const drums');
    expect(nothing).toContain('stack(melody, bass)');
  });
  it('judges ghost notes against the kit hits only, not against louder hand percussion', () => {
    const s = song();
    const hits: [number, number, number?][] = [];
    for (let b = 0; b < 4; b++) for (let i = 0; i < 4; i++) hits.push([42, b * 4 + i, 0.5], [63, b * 4 + i, 1]);
    s.tracks[2] = kit(hits);
    const code = compile(s);
    expect(code).not.toContain('drums_ghost');
    expect(code).toContain('const drums = s("<[hh ~@3 hh ~@3 hh ~@3 hh ~@3]!4>")');
    // The kit's level is its own hits' (velocity 0.5 -> 0.53), the congas' their own (1 -> clipped at 1, x3.2).
    expect(code).toMatch(/const drums = [^\n]+\n {2}\.gain\(0\.53\)/);
    expect(code).toMatch(/const congas = [^\n]+\n {2}\.gain\(3\.2\)/);
  });
});

describe('track selection', () => {
  it('guarantees the melody and the main bass, then ranks by how much each part is heard', () => {
    const s = song();
    const pad = (name: string, role: Track['role'], velocity: number, volume?: number): Track => ({ name, program: 48, role, notes: line(60, 3, velocity), volume });
    s.tracks.push(pad('quiet other', 'other', 0.3), pad('loud other', 'other', 1), pad('pad', 'chords', 0.5), pad('muted other', 'other', 1, 0.2));
    // The heavy 'other' beats the lighter 'chords' part; the chords bonus is bounded.
    expect(selectTracks(s, 4, true).map((t) => t.name)).toEqual(['lead', '', 'loud other', 'pad']);
    expect(selectTracks(s, 5, true).map((t) => t.name)).toEqual(['lead', '', 'loud other', 'pad', 'quiet other']);
    // Muted (CC 7 = 0.2 -> level 0.06) is inaudible and never selected.
    expect(selectTracks(s, 9, true).map((t) => t.name)).not.toContain('muted other');
    expect(selectTracks(s, 2, false).map((t) => t.name)).toEqual(['', 'loud other']);
    // Harmony wins a near tie.
    s.tracks.push(pad('pad2', 'chords', 0.9));
    expect(selectTracks(s, 3, true).map((t) => t.name)).toEqual(['lead', '', 'pad2']);
  });
  it('keeps the bass when a stack of louder parts would otherwise crowd it out', () => {
    const s = song();
    for (let i = 0; i < 6; i++) s.tracks.push({ name: `g${i}`, program: 29, role: 'other', notes: line(64 + i, 3, 1) });
    expect(selectTracks(s, 3, true).map((t) => t.name)).toEqual(['lead', '', 'g0']);
  });
  it('renders up to 12 pitched tracks by default', () => {
    const s = song();
    for (let i = 0; i < 14; i++) s.tracks.push({ name: `p${i}`, program: 48, role: 'other', notes: line(60, 3, 0.5 + i / 100) });
    const code = compile(s);
    expect(code.match(/^const /gm)).toHaveLength(15); // 12 pitched + drums + congas + claves
  });
});

describe('grid', () => {
  const meta = song().meta;
  it('offers straight and triplet grids per metre', () => {
    expect(gridCandidates(meta)).toEqual({ straight: 16, triplet: 24 });
    expect(gridCandidates({ ...meta, beatsPerBar: 6, beatUnit: 8 })).toEqual({ straight: 12, triplet: 18 });
    expect(gridCandidates({ ...meta, beatsPerBar: 3 })).toEqual({ straight: 12, triplet: 18 });
  });
  it('picks the triplet grid for swung eighths and keeps straight for humanised straight playing', () => {
    const swing: NoteEvent[] = [];
    for (let i = 0; i < 16; i++) swing.push({ pitch: 60, start: Math.floor(i / 2) + (i % 2) * (2 / 3), duration: 0.3, velocity: 0.8 });
    expect(chooseGrid(swing, meta)).toBe(24);
    const humanised: NoteEvent[] = [];
    for (let i = 0; i < 32; i++) humanised.push({ pitch: 60, start: i / 2 + ((i * 7) % 5 - 2) * 0.02, duration: 0.3, velocity: 0.8 });
    expect(chooseGrid(humanised, meta)).toBe(16);
  });
  it('renders a shuffle on the 24-cell grid and says so', () => {
    const s = song();
    const swing: NoteEvent[] = [];
    for (let i = 0; i < 16; i++) swing.push({ pitch: 60, start: Math.floor(i / 2) + (i % 2) * (2 / 3), duration: 0.3, velocity: 0.8 });
    s.tracks[0] = { ...s.tracks[0], notes: swing };
    const code = compile(s);
    expect(code).toContain('const melody = note("<[c4@2 ~@2 c4@2 c4@2 ~@2 c4@2 c4@2 ~@2 c4@2 c4@2 ~@2 c4@2]!2>")');
    expect(code).toContain('24-cell triplet grid');
  });
  it('decides the grid once per song from the rhythm section, and lets a part leave it only on overwhelming evidence', () => {
    const swung = (pitch: number, bars: number, velocity = 0.8): NoteEvent[] => {
      const out: NoteEvent[] = [];
      for (let b = 0; b < bars; b++) for (let i = 0; i < 8; i++) out.push({ pitch, start: b * 4 + Math.floor(i / 2) + (i % 2) * (2 / 3), duration: 0.3, velocity });
      return out;
    };
    // A shuffle: swung bass and kit, a melody that mostly sits on the beat (its own evidence is not enough for either grid), and a straight sixteenth-note hi-hat synth.
    const s = song();
    s.tracks[1].notes = swung(36, 8, 0.9);
    s.tracks[2].notes = swung(42, 8, 1);
    s.tracks[0].notes = Array.from({ length: 32 }, (_, i) => ({ pitch: 72, start: i + ((i * 7) % 5 - 2) * 0.02, duration: 0.5, velocity: 0.8 }));
    s.tracks.push({ name: 'straight', program: 81, role: 'other', notes: Array.from({ length: 128 }, (_, i) => ({ pitch: 84, start: i / 4, duration: 0.2, velocity: 0.7 })) });
    expect(songGrid(s.tracks, s.meta)).toBe(24);
    expect(chooseGrid(s.tracks[0].notes, s.meta)).toBe(16); // alone, the melody would play straight ...
    expect(chooseGrid(s.tracks[0].notes, s.meta, 24)).toBe(24); // ... but it follows the shuffle
    expect(chooseGrid(s.tracks[3].notes, s.meta, 24)).toBe(16); // sixteenths are overwhelming evidence, so the synth stays straight
    const code = compile(s);
    expect(code).toContain("// swing: the rhythm section's onsets fit a 24-cell triplet grid, used for every part unless its own onsets clearly play straight");
    expect(code).toMatch(/\/\/ melody · [^\n]+ · 24-cell triplet grid/);
    expect(code).toMatch(/\/\/ bass · [^\n]+ · 24-cell triplet grid/);
    expect(code).toMatch(/\/\/ drums · [^\n]+ · 24-cell triplet grid/);
    expect(code).toMatch(/\/\/ other · "straight" · gm_lead_2_sawtooth · gain [\d.]+\n/);
    // A straight song with one swung part: the part alone may swing (its straight-grid error is real), the rest stays straight.
    const straight = song();
    straight.tracks[1].notes = Array.from({ length: 64 }, (_, i) => ({ pitch: 36, start: i / 2, duration: 0.4, velocity: 0.9 }));
    straight.tracks.push({ name: 'shuffle', program: 18, role: 'other', notes: swung(60, 8) });
    expect(songGrid(straight.tracks, straight.meta)).toBe(16);
    expect(compile(straight)).toMatch(/\/\/ other · "shuffle" · gm_rock_organ · gain [\d.]+ · 24-cell triplet grid/);
    // Tiny timing differences never move a part off the song's grid.
    expect(chooseGrid(straight.tracks[1].notes.map((n) => ({ ...n, start: n.start + 0.005 })), straight.meta, 24)).toBe(24);
  });
  it('turns notes that share a cell but not an onset into a sub-sequence, not a chord', () => {
    const s = song();
    s.tracks[0] = { ...s.tracks[0], notes: [
      { pitch: 64, start: 0, duration: 0.1, velocity: 0.8 }, // 32nd-note pair: separate cells
      { pitch: 65, start: 0.125, duration: 0.1, velocity: 0.8 },
      { pitch: 59, start: 1.875, duration: 0.1, velocity: 0.8 }, // grace note before beat 3
      { pitch: 60, start: 2, duration: 2, velocity: 0.8 },
      { pitch: 67, start: 4, duration: 1, velocity: 0.8 }, // strummed chord: stays a chord
      { pitch: 71, start: 4.03, duration: 1, velocity: 0.8 },
    ] };
    expect(compile(s)).toContain('const melody = note("<[e4 f4 ~@6 [b3 c4@7]@8] [[g4,b4]@4 ~@12]>")');
  });
});

describe('header remarks', () => {
  it('lists analysis notes as comments', () => {
    const s = song();
    s.meta.remarks = ['pitch bends are ignored'];
    expect(compile(s)).toContain('// note: pitch bends are ignored\nsetcpm(30.00)');
  });
});

describe('length cap', () => {
  it('counts maxBars in 4/4 bars and announces truncation', () => {
    const s = song();
    s.tracks[1].notes = Array.from({ length: 300 }, (_, i) => ({ pitch: 36, start: i * 4, duration: 4, velocity: 0.9 }));
    expect(barRange(s)).toEqual({ firstBar: 0, nBars: 200, totalBars: 300 });
    expect(compile(s)).toContain('// note: rendering stops at bar 200 of 300 (max bars 200)');
    expect(compile(s, { maxBars: 400 })).not.toContain('rendering stops');
    expect(timeline(s).bars).toBe(200);
    // A song only a few bars over the cap is rendered whole (5% tolerance, at least 2 bars).
    expect(barRange(s, 290)).toEqual({ firstBar: 0, nBars: 300, totalBars: 300 });
    expect(barRange(s, 280)).toEqual({ firstBar: 0, nBars: 280, totalBars: 300 });
    expect(barRange(s, 16).nBars).toBe(16);
    // In 2/4 the same cap allows twice the bars: 200 bars of 4/4 is 800 beats.
    const half: Song = { ...s, meta: { ...s.meta, beatsPerBar: 2 } };
    expect(barRange(half)).toEqual({ firstBar: 0, nBars: 400, totalBars: 600 });
    expect(barRange(half, 100)).toEqual({ firstBar: 0, nBars: 200, totalBars: 600 });
    expect(timeline(half, { maxBars: 100 }).bars).toBe(200);
  });
});

describe('helpers', () => {
  it('names notes', () => {
    expect(noteName(60)).toBe('c4');
    expect(noteName(61)).toBe('c#4');
    expect(noteName(21)).toBe('a0');
  });
  it('round-trips share urls', () => {
    const code = 'note("c e g — ünïcode")';
    const url = shareUrl(code);
    expect(url.startsWith('https://strudel.cc/#')).toBe(true);
    expect(hash2code(url.split('#')[1])).toBe(code);
  });
});

describe('timeline', () => {
  it('matches the compiled bar count and lists a chord per bar for MIDI songs', () => {
    const s = song();
    s.sections = [{ label: 'song', raw: 'song', bars: 3, chords: [{ symbol: 'C', beats: 8 }, { symbol: null, beats: 4 }] }];
    const t = timeline(s);
    expect(t.bars).toBe(3);
    expect(t.cpm).toBe(30);
    expect(t.secondsPerBar).toBe(2);
    expect(t.chords).toEqual(['C', 'C', null]);
    expect(t.sections).toEqual([]);
  });
  it('lays out sections for chords-only songs', () => {
    const s: Song = { meta: song().meta, tracks: [], sections: [
      { label: 'intro', raw: 'intro', bars: 2, chords: [{ symbol: 'C', beats: 4 }, { symbol: 'F', beats: 4 }] },
      { label: 'verse', raw: 'verse', bars: 2, chords: [{ symbol: 'G', beats: 6 }, { symbol: 'Am', beats: 2 }] },
    ] };
    const t = timeline(s);
    expect(t.bars).toBe(4);
    expect(t.chords).toEqual(['C', 'F', 'G', 'G']);
    expect(t.sections).toEqual([{ label: 'intro', startBar: 0, bars: 2 }, { label: 'verse', startBar: 2, bars: 2 }]);
  });
});

describe('mix level reference', () => {
  it('lets only major parts set the scale: a loud short stab is clipped, not the whole mix pulled down', () => {
    expect(gainsFor([1.5, 0.75], [false, true])).toEqual([1, 0.8]);
    expect(gainsFor([1.5, 0.75], [true, true])).toEqual([1, 0.5]);
    const stab = { level: 1.5, weight: 1, active: [true, ...Array(19).fill(false)] };
    const lead = { level: 0.75, weight: 100, active: Array(20).fill(true) };
    expect(mixParts([stab, lead]).gains).toEqual([1, 0.8]);
    // A part with weight but short coverage, or with coverage but no weight, is minor; a part without a weight is major.
    expect(mixParts([{ level: 1.5, weight: 100, active: [true, ...Array(19).fill(false)] }, lead]).gains).toEqual([1, 0.8]);
    expect(mixParts([{ level: 1.5, weight: 1, active: Array(20).fill(true) }, lead]).gains).toEqual([1, 0.8]);
    expect(mixParts([{ level: 1.5, active: [true, ...Array(19).fill(false)] }, lead]).gains).toEqual([1, 0.5]);
    // The drums (weight 0) never set the level: a hot kit clips at 1 and the pitched parts keep their balance.
    const hot = song();
    hot.tracks[2].notes = hot.tracks[2].notes.map((n) => ({ ...n, velocity: 1 }));
    hot.tracks[2].volume = 1;
    expect(compile(hot)).toMatch(/const drums = [^\n]+\n {2}\.gain\(1\)/);
    expect(compile(hot)).toMatch(/const melody = [^\n]+\n {2}\.s\("gm_flute"\)\.gain\(0\.85\)/);
    const s = song();
    s.tracks[0].notes = line(72, 40);
    s.tracks[2].notes = []; // no kit: the lead sets the level
    s.tracks.push({ name: 'stab', program: 61, role: 'other', notes: [{ pitch: 72, start: 16, duration: 0.5, velocity: 1 }, { pitch: 76, start: 16, duration: 0.5, velocity: 1 }, { pitch: 79, start: 18, duration: 0.5, velocity: 1 }, { pitch: 84, start: 18, duration: 0.5, velocity: 1 }], volume: 1 });
    const code = compile(s);
    expect(code).toMatch(/const melody = [^\n]+\n {2}\.s\("gm_flute"\)\.gain\(0\.85\)/); // 0.8 velocity x 1.067, untouched by the stab (too light to be the band the lead is levelled against)
    expect(code).toMatch(/const stab = [^\n]+\n {2}\.s\("gm_brass_section"\)\.gain\(1\)/);
  });
});

describe('sounds', () => {
  it('sends a line on a bass patch above a bass\'s last fret to the bass+lead synth, keeps chords there, and leaves bass lines alone', () => {
    const s = song();
    s.tracks.push({ name: 'duet', program: 35, role: 'other', notes: line(72, 3) }); // Love Me Do: the sung duet on a fretless bass at C5
    s.tracks.push({ name: 'stabs', program: 38, role: 'chords', notes: line(72, 3).concat(line(76, 3), line(79, 3)) });
    s.tracks.push({ name: 'riff', program: 38, role: 'other', notes: line(55, 3) }); // a synth-bass riff at G3 is in range
    const code = compile(s);
    expect(code).toContain('// other · "duet" · fretless bass in the file, above a bass\'s last fret (median c5), played on gm_lead_8_bass_lead, the synth patch made for both registers · gain');
    expect(code).toMatch(/const duet = [^\n]+\n {2}\.s\("gm_lead_8_bass_lead"\)/);
    expect(code).toContain('// chords · "stabs" · gm_synth_bass_1 · chords on a synth bass 1 in the file, above a bass\'s last fret (median e5), kept · gain');
    expect(code).toMatch(/const stabs = [^\n]+\n {2}\.s\("gm_synth_bass_1"\)/);
    expect(code).toContain('// other · "riff" · gm_synth_bass_1 · gain');
    expect(code).toContain('// bass · gm_electric_bass_finger · gain');
    // A melody on such a patch is the same case, said as the lead it is.
    s.tracks[0] = { ...s.tracks[0], name: 'tune', program: 33, notes: line(72, 3) };
    expect(compile(s)).toContain('// melody · "tune" · instrumental lead, electric bass finger in the file, above a bass\'s last fret (median c5), played on gm_lead_8_bass_lead, the synth patch made for both registers · gain');
    // A singer on a bass patch is a singer first: the melody sound, never the bass+lead synth.
    s.tracks[0] = { ...s.tracks[0], vocal: true };
    expect(compile(s)).not.toContain('const melody =');
  });



  it('lifts an instrumental melody to the band and says so, leaving one that is already up front alone', () => {
    // A clarinet vocal line at CC 7 = 60 and velocity 0.6 under a rhythm guitar at CC 7 = 127: faithful to the file it would sit at a quarter of the guitar.
    const s = song();
    s.tracks[0] = { ...s.tracks[0], program: 71, name: '', notes: line(72, 40, 0.6), volume: 60 / 127 };
    s.tracks.push({ name: 'rhythm', program: 30, role: 'chords', notes: line(52, 40, 0.9).concat(line(59, 40, 0.9)), volume: 1 });
    const code = compile(s);
    const gain = (name: string) => Number(new RegExp(`const ${name} = [^\\n]+\\n {2}\\.s\\("[^"]+"\\)\\.gain\\(([\\d.]+)\\)`).exec(code)![1]);
    expect(gain('melody')).toBeCloseTo(INSTRUMENT_LEAD_FLOOR * gain('rhythm'), 1);
    expect(code).toContain('// melody · gm_clarinet · instrumental lead, keeps its own instrument · gain 0.75 · lifted to the band');
    expect(INSTRUMENT_LEAD_FLOOR).toBeLessThan(VOCAL_LEAD_FLOOR);
    // Already at the guitar's level: nothing changes and nothing is said.
    s.tracks[0].volume = 1;
    s.tracks[0].notes = line(72, 40, 0.9);
    expect(compile(s)).toContain('// melody · gm_clarinet · instrumental lead, keeps its own instrument · gain 1\n');
  });
  it('counts a loud part that plays under the lead as the band, but not one that only takes turns with it', () => {
    // A 40-bar sax tune at CC 7 = 60 and a loud guitar solo. Over bars 10-26 (40% of the sax's bars) it plays under the sax; over
    // bars 37-45 it mostly takes over from it (3 of its 8 bars under the sax, 7% of the sax's); a solo after the tune (bars 40-48) never does.
    const s = song();
    s.tracks[0] = { ...s.tracks[0], program: 65, name: '', notes: line(72, 40, 0.6), volume: 60 / 127 };
    s.tracks[1].notes = Array.from({ length: 48 }, (_, b) => ({ pitch: 36, start: b * 4, duration: 4, velocity: 0.5 }));
    const solo = (from: number, bars: number): Track => ({ name: 'solo', program: 30, role: 'other', notes: line(76, bars, 0.9, from * 4) });
    const gain = (code: string, name: string) => Number(new RegExp(`const ${name} = [^\\n]+\\n {2}\\.s\\("[^"]+"\\)\\.gain\\(([\\d.]+)\\)`).exec(code)![1]);
    const under = compile({ ...s, tracks: [...s.tracks, solo(10, 16)] });
    expect(gain(under, 'melody')).toBeCloseTo(INSTRUMENT_LEAD_FLOOR * gain(under, 'solo'), 1);
    const brief = compile({ ...s, tracks: [...s.tracks, solo(37, 8)] });
    // A part that sits entirely under the sax counts too (half of its own bars are under the lead) once it carries real weight; a two-bar stab does not.
    const under8 = compile({ ...s, tracks: [...s.tracks, solo(20, 8)] });
    expect(gain(under8, 'melody')).toBeCloseTo(INSTRUMENT_LEAD_FLOOR * gain(under8, 'solo'), 1);
    const stab = compile({ ...s, tracks: [...s.tracks, solo(20, 2)] });
    expect(gain(stab, 'melody')).toBe(gain(brief, 'melody'));
    expect(gain(brief, 'melody')).toBeLessThan(0.5 * gain(brief, 'solo'));
    const after = compile({ ...s, tracks: [...s.tracks, solo(40, 8)] });
    expect(gain(after, 'melody')).toBe(gain(brief, 'melody'));
    expect(LEAD_OVERLAP_SHARE).toBe(0.25);
  });



  it('lifts an instrumental lead only when it plays through a third of the song, and says why not', () => {
    // A 12-bar guitar lick at CC 7 = 60 in a 48-bar song under a loud rhythm guitar: the file's level is kept.
    const s = song();
    s.tracks[0] = { ...s.tracks[0], program: 30, name: '', notes: line(72, 12, 0.6, 80), volume: 60 / 127 };
    s.tracks[1].notes = Array.from({ length: 48 }, (_, b) => ({ pitch: 36, start: b * 4, duration: 4, velocity: 0.5 }));
    s.tracks.push({ name: 'rhythm', program: 27, role: 'chords', notes: line(52, 48, 0.9).concat(line(59, 48, 0.9)), volume: 1 });
    const code = compile(s);
    const gain = (c: string, name: string) => Number(new RegExp(`const ${name} = [^\\n]+\\n {2}\\.s\\("[^"]+"\\)\\.gain\\(([\\d.]+)\\)`).exec(c)![1]);
    expect(gain(code, 'melody')).toBeLessThan(0.5 * gain(code, 'rhythm'));
    expect(code).toContain("instrumental lead, keeps its own instrument · gain 0.15 · plays in 25% of the bars, so it keeps the file's level rather than being lifted to the band");
    // Through the song it is lifted; a vocal lead is lifted whatever its coverage.
    s.tracks[0].notes = line(72, 20, 0.6, 80);
    expect(compile(s)).toContain('lifted to the band');
    s.tracks[0] = { ...s.tracks[0], vocal: true, name: 'Vocal', notes: line(72, 12, 0.6, 80) };
    expect(compile(s)).not.toContain('const melody =');
    expect(LEAD_FLOOR_MIN_COVERAGE).toBeCloseTo(1 / 3, 6);
  });
  it('names parts from their track name, capped to the leading words, and from the patch when the name is a credit', () => {
    const s = song();
    s.tracks.push({ name: 'Electric Guitar (Distortion) Rhythm', program: 30, role: 'other', notes: line(60, 3) });
    s.tracks.push({ name: 'Updated alot by RazTor (cns@post7.tele.dk)', program: 27, role: 'other', notes: line(67, 3) });
    const code = compile(s);
    expect(code).toContain('const electric_guitar = ');
    expect(code).toContain('const electric_guitar_clean = ');
    expect(code).toContain('// other · "Electric Guitar (Distortion) Rhythm" · gm_distortion_guitar');
    expect(code).toContain('// other · gm_electric_guitar_clean · gain');
    expect(code).not.toMatch(/raztor/);
  });
  it('never makes a junk identifier: ordinals are dropped, and a name without a Latin word falls back to the patch', () => {
    const s = song();
    s.tracks.push(
      { name: '1st Guitar', program: 27, role: 'other', notes: line(60, 3) },
      { name: '12 String', program: 25, role: 'other', notes: line(64, 3) },
      { name: 'Гитара', program: 29, role: 'other', notes: line(67, 3) },
      { name: '"', program: 30, role: 'other', notes: line(71, 3) },
      { name: '1946', program: 62, role: 'other', notes: line(72, 3) },
    );
    const code = compile(s);
    expect(code).toContain('const guitar = ');
    expect(code).toContain('const string = ');
    expect(code).toContain('const overdriven_guitar = ');
    expect(code).toContain('const distortion_guitar = ');
    expect(code).toContain('const synth_brass_1 = ');
    expect(code).toContain('// other · "Гитара" · gm_overdriven_guitar');
    expect(code).not.toMatch(/const t_|const _|\bt_\d/);
    const idents = [...code.matchAll(/^const (\w+) =/gm)].map((m) => m[1]);
    expect(new Set(idents).size).toBe(idents.length);
    expect(idents.every((id) => /^[a-z][a-z0-9_]*$/.test(id))).toBe(true);
  });
  it('plays a bass part on a bass sound when its patch cannot play one', () => {
    const s = song();
    s.tracks[1] = { ...s.tracks[1], name: 'bass', program: 64 };
    expect(compile(s)).toContain('// bass · "bass" · soprano sax in the file, played on gm_electric_bass_finger · gain');
    s.tracks[1] = { ...s.tracks[1], name: 'bass', program: 26 }; // a jazz guitar can play a bass line
    expect(compile(s)).toContain('// bass · "bass" · gm_electric_guitar_jazz · gain');
  });
  it('names a second part of the same instrument without renaming the patch', () => {
    const s = song();
    s.tracks.push({ name: '', program: 62, role: 'other', notes: line(60, 3) }, { name: '', program: 62, role: 'other', notes: line(67, 3) });
    const code = compile(s);
    expect(code).toContain('const synth_brass_1 = ');
    expect(code).toContain('const synth_brass_1_2 = ');
    expect(code).not.toContain('const synth_brass_2 = ');
  });
});

describe('chordSummary', () => {
  it('collapses repeats, separates sections with | and caps the length', () => {
    const sections = [
      { label: 'a', bars: 2, chords: [{ symbol: 'C', beats: 4 }, { symbol: 'C', beats: 4 }, { symbol: 'G', beats: 4 }] },
      { label: 'b', bars: 1, chords: [{ symbol: null, beats: 4 }, { symbol: 'F', beats: 4 }] },
    ];
    expect(chordSummary(sections)).toBe('C G | N F');
    const long = [{ label: 'x', bars: 60, chords: Array.from({ length: 60 }, (_, i) => ({ symbol: `C${i}`, beats: 4 })) }];
    const out = chordSummary(long);
    expect(out.split(' ')).toHaveLength(40);
    const wide = [{ label: 'y', bars: 200, chords: Array.from({ length: 40 }, (_, i) => ({ symbol: `Chord${i}sus4add9`, beats: 4 })) }];
    expect(chordSummary(wide).length).toBeLessThanOrEqual(400);
    expect(chordSummary([])).toBe('');
  });
});
