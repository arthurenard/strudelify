import type { CompileOptions } from '../src/strudel.js';
import { describe, it, expect } from 'vitest';
import * as ToneMidiNs from '@tonejs/midi';
import type { Midi as MidiType } from '@tonejs/midi';
import { songFromMidi as parseMidi, scanChannelEvents, scanTrackNames, decodeText, applySustain, dedupeParts, matchParts, foldStubs, dropTrailingStrays, barStart, barIndex, beatMap, beatAt, nameSaysVocal, isCreditName, partName, reconcileName, MT32_NAME_VOTES, VOCAL_NAME_MIN_NOTE_SHARE, VOCAL_NAME_MIN_COVERAGE, MELODY_MIN_COVERAGE, Reset } from '../src/midi.js';
import { compile as compileSource, barRange, selectTracks } from '../src/strudel.js';
import { gmLabel } from '../src/gm.js';
import type { NoteEvent } from '../src/types.js';
import { PPQ, smf, rawNote } from './smf.js';

const ns = ToneMidiNs as unknown as { Midi?: typeof MidiType; default?: { Midi?: typeof MidiType } };
const Midi = (ns.Midi ?? ns.default?.Midi) as typeof MidiType;

const ID = { id: 't', title: 'T', artist: 'A' };

it('keeps guitar swells whose expression rises after every note-on', () => {
  const notes: [number, number, number][] = Array.from({ length: 32 }, (_, i) => [60 + i % 5, i, 0.9]);
  const cc = notes.flatMap(([, beat]) => [{ number: 11, beat, value: 1 }, { number: 11, beat: beat + 0.1, value: 127 }]);
  const song = songFromMidi(build([{ channel: 0, program: 30, name: 'Guitar', notes, cc }]), ID);
  expect(song.tracks[0].volume).toBeGreaterThan(0.5);
  expect(compile(song)).not.toContain('stack()');
  expect(song.tracks[0].remarks?.join(' ')).toContain('volume swells');
});

interface Part {
  channel: number;
  program?: number;
  name?: string;
  /** [pitch, startBeat, durationBeats, velocity?] */
  notes: [number, number, number, number?][];
  cc?: { number: number; beat: number; value: number }[];
}

/** Build a format-1 MIDI file: one track per part, plus optional CC-only tracks. */
// Explicit opt-in to the historical grid timing for grid-analysis regression cases.
const songFromMidi = (data: Uint8Array, identity: Parameters<typeof parseMidi>[1]) => parseMidi(data, identity, { sourceTiming: false });
// These assertions cover the optional compact-grid renderer; performance.test.ts covers the default.
const compile = (song: Parameters<typeof compileSource>[0], opts: CompileOptions = {}) => compileSource(song, { timing: 'grid', ...opts });

function build(parts: Part[], extra?: (m: MidiType) => void): Uint8Array {
  const m = new Midi();
  for (const p of parts) {
    const t = m.addTrack();
    t.channel = p.channel;
    if (p.name) t.name = p.name;
    if (p.program !== undefined) t.instrument.number = p.program;
    for (const [pitch, start, dur, vel] of p.notes) t.addNote({ midi: pitch, ticks: Math.round(start * PPQ), durationTicks: Math.round(dur * PPQ), velocity: vel ?? 0.8 });
    for (const c of p.cc ?? []) t.addCC({ number: c.number, ticks: Math.round(c.beat * PPQ), value: c.value / 127 });
  }
  extra?.(m);
  return new Uint8Array(m.toArray());
}


/** A bar of straight eighths on `pitch`, `bars` times. */
function eighths(pitch: number, bars: number, from = 0): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let b = 0; b < bars; b++) for (let i = 0; i < 8; i++) out.push([pitch, from + b * 4 + i / 2, 0.4]);
  return out;
}

describe('decodeText', () => {
  it('reads UTF-8 when the bytes are UTF-8 and Windows-1252 otherwise', () => {
    expect(decodeText(new TextEncoder().encode('Contrebasse à l’archet'))).toBe('Contrebasse à l’archet');
    expect(decodeText(new Uint8Array([0x6d, 0xc1, 0x49, 0x53, 0x20, 0x63, 0x4f, 0x52, 0x4f, 0x53]))).toBe('mÁIS cOROS'); // Latin-1, not "m�IS"
    expect(decodeText(new Uint8Array([0x93, 0x41, 0x94]))).toBe('“A”'); // the Windows-1252 quotes, not C1 controls
    expect(decodeText(new Uint8Array([0x4c, 0x65, 0x61, 0x64]))).toBe('Lead');
    expect(decodeText(new Uint8Array(0))).toBe('');
  });
  it('keeps accented track names whole through both name sources', () => {
    const raw = (bytes: number[]) => ({ tick: 0, bytes: [0xff, 0x03, bytes.length, ...bytes] });
    const utf8 = [...new TextEncoder().encode('Contrebasse à l’archet')];
    const latin1 = [0x6d, 0xc1, 0x49, 0x53, 0x20, 0x63, 0x4f, 0x52, 0x4f, 0x53];
    const notes = (channel: number, pitch: number) => Array.from({ length: 8 }, (_, i) => rawNote(channel, pitch, i, 0.5)).flat();
    const data = smf([
      // A bank before the program change makes @tonejs/midi leave the name on a note-less piece, so this name comes from the raw scan.
      [raw(utf8), { tick: 0, bytes: [0xb0, 0, 0] }, { tick: 0, bytes: [0xc0, 43] }, ...notes(0, 40)],
      // This one comes from @tonejs/midi, whose parser turns each byte into a character.
      [raw(latin1), { tick: 0, bytes: [0xc1, 54] }, ...notes(1, 67)],
      [raw([...new TextEncoder().encode('Guitare électrique')]), { tick: 0, bytes: [0xc2, 27] }, ...notes(2, 60)],
    ]);
    expect(scanTrackNames(data)).toEqual(new Map([[0, 'Contrebasse à l’archet'], [1, 'mÁIS cOROS'], [2, 'Guitare électrique']]));
    const names = songFromMidi(data, ID).tracks.map((t) => t.name).sort();
    expect(names).toEqual(['Contrebasse à l’archet', 'Guitare électrique', 'mÁIS cOROS']);
  });
});

describe('scanChannelEvents', () => {
  it('reads controllers and program changes with their channel, even on note-less tracks', () => {
    const data = build([
      { channel: 5, notes: [], cc: [{ number: 7, beat: 0, value: 90 }, { number: 10, beat: 0, value: 20 }] },
      { channel: 2, program: 33, notes: [[40, 0, 1]] },
    ]);
    const ev = scanChannelEvents(data);
    expect(ev).toContainEqual({ ticks: 0, channel: 5, kind: 'cc', number: 7, value: 90 });
    expect(ev).toContainEqual({ ticks: 0, channel: 5, kind: 'cc', number: 10, value: 20 });
    expect(ev.find((e) => e.kind === 'program' && e.number === 33)).toMatchObject({ channel: 2, ticks: 0 });
  });
  it('handles running status, meta and sysex events in a raw file', () => {
    const data = smf([[
      { tick: 0, bytes: [0xff, 0x03, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f] }, // track name "hello"
      { tick: 0, bytes: [0xf0, 0x05, 0x7e, 0x7f, 0x09, 0x01, 0xf7] }, // GM reset sysex
      { tick: 0, bytes: [0xb3, 7, 100] },
      { tick: 0, bytes: [10, 32] }, // running status: still a CC on channel 3
      { tick: 960, bytes: [0xc3, 26] },
      { tick: 960, bytes: [0xe3, 0, 64] }, // pitch bend, ignored
      ...rawNote(3, 60, 2, 1),
    ]]);
    expect(scanChannelEvents(data)).toEqual([
      { ticks: 0, channel: -1, kind: 'reset', number: Reset.GM, value: 0 },
      { ticks: 0, channel: 3, kind: 'cc', number: 7, value: 100 },
      { ticks: 0, channel: 3, kind: 'cc', number: 10, value: 32 },
      { ticks: 960, channel: 3, kind: 'program', number: 26, value: 26 },
    ]);
  });
  it('tolerates garbage', () => {
    expect(scanChannelEvents(new Uint8Array([1, 2, 3]))).toEqual([]);
    expect(scanChannelEvents(new Uint8Array(0))).toEqual([]);
  });
  it('recognises GS and XG resets and GS rhythm-part assignments', () => {
    const data = smf([[
      { tick: 0, bytes: [0xf0, 0x0a, 0x41, 0x10, 0x42, 0x12, 0x40, 0x00, 0x7f, 0x00, 0x41, 0xf7] }, // GS reset
      { tick: 0, bytes: [0xf0, 0x0a, 0x41, 0x10, 0x42, 0x12, 0x40, 0x1a, 0x15, 0x02, 0x0f, 0xf7] }, // part 11 (block 0x1A) uses drum map 2
      { tick: 0, bytes: [0xf0, 0x08, 0x43, 0x10, 0x4c, 0x00, 0x00, 0x7e, 0x00, 0xf7] }, // XG system on
      { tick: 0, bytes: [0xf0, 0x05, 0x7e, 0x7f, 0x09, 0x01, 0xf7] }, // GM on
      { tick: 0, bytes: [0xf0, 0x03, 0x12, 0x34, 0xf7] }, // something else
    ]]);
    expect(scanChannelEvents(data)).toEqual([
      { ticks: 0, channel: -1, kind: 'reset', number: Reset.GS, value: 0 },
      { ticks: 0, channel: -1, kind: 'reset', number: Reset.GS, value: 0 }, // every GS message says the file is GS
      { ticks: 0, channel: 10, kind: 'rhythm', number: 2, value: 2 },
      { ticks: 0, channel: -1, kind: 'reset', number: Reset.XG, value: 0 },
      { ticks: 0, channel: -1, kind: 'reset', number: Reset.GM, value: 0 },
    ]);
  });
});

describe('songFromMidi bank select', () => {
  const GS_RESET = { tick: 0, bytes: [0xf0, 0x0a, 0x41, 0x10, 0x42, 0x12, 0x40, 0x00, 0x7f, 0x00, 0x41, 0xf7] };
  const XG_ON = { tick: 0, bytes: [0xf0, 0x08, 0x43, 0x10, 0x4c, 0x00, 0x00, 0x7e, 0x00, 0xf7] };
  const name = (s: string) => ({ tick: 0, bytes: [0xff, 0x03, s.length, ...[...s].map((c) => c.charCodeAt(0))] });
  /** An arpeggio in the guitar's register over `bars` bars, as raw events on `channel`. */
  const arpeggio = (channel: number, bars: number) => {
    const out: { tick: number; bytes: number[] }[] = [];
    for (let b = 0; b < bars; b++) for (let i = 0; i < 8; i++) out.push(...rawNote(channel, [45, 52, 57, 60, 64, 60, 57, 52][i], b * 4 + i / 2, 2, 70)); // ringing strings
    return out;
  };
  const lowLine = (channel: number, bars: number) => {
    const out: { tick: number; bytes: number[] }[] = [];
    for (let b = 0; b < bars; b++) for (let i = 0; i < 4; i++) out.push(...rawNote(channel, [33, 33, 40, 38][i], b * 4 + i, 0.9, 90));
    return out;
  };
  const highLine = (channel: number, bars: number) => {
    const out: { tick: number; bytes: number[] }[] = [];
    for (let b = 0; b < bars; b++) for (let i = 0; i < 8; i++) out.push(...rawNote(channel, 72 + [0, 2, 4, 7, 9, 7, 4, 2][i], b * 4 + i / 2, 0.45, 90));
    return out;
  };
  const kit = (channel = 9) => [...rawNote(channel, 36, 0, 0.25), ...rawNote(channel, 38, 1, 0.25), ...rawNote(channel, 36, 2, 0.25), ...rawNote(channel, 38, 3, 0.25)];
  /** The same raw notes transposed, so two lines are not taken for doubles. */
  const up = (events: { tick: number; bytes: number[] }[], semis: number) => events.map((e) => ({ tick: e.tick, bytes: [e.bytes[0], e.bytes[1] + semis, e.bytes[2]] }));
  it('reads programs selected with bank 127 through the MT-32 map in a GS file, and says so', () => {
    // Stairway to Heaven's layout: "a guitar" on MT-32 patch 59 (Guitar 1; a muted trumpet in GM) and "bass" on 64 (Acou Bass 1; a soprano sax in GM).
    const song = songFromMidi(smf([
      [GS_RESET],
      [name('a guitar'), { tick: 0, bytes: [0xb0, 0, 127] }, { tick: 0, bytes: [0xb0, 32, 0] }, { tick: 0, bytes: [0xc0, 59] }, ...arpeggio(0, 16)],
      [name('bass'), { tick: 0, bytes: [0xb1, 0, 127] }, { tick: 0, bytes: [0xc1, 64] }, ...lowLine(1, 16)],
      [name('piano'), { tick: 0, bytes: [0xb2, 0, 0] }, { tick: 0, bytes: [0xc2, 0] }, ...highLine(2, 16)],
      kit(),
    ]), ID);
    expect(song.tracks.find((t) => t.name === 'a guitar')).toMatchObject({ program: 24, role: 'chords' });
    expect(song.tracks.find((t) => t.name === 'bass')).toMatchObject({ program: 32, role: 'bass' });
    expect(song.tracks.find((t) => t.name === 'piano')).toMatchObject({ program: 0 });
    expect(song.meta.remarks).toContain('bank select 127 (Roland MT-32 map) read through the MT-32 patch table: ch 1 "a guitar" Guitar 1 -> acoustic guitar nylon; ch 2 "bass" Acou Bass 1 -> acoustic bass');
    const code = compile(song);
    expect(code).toContain('// chords · "a guitar" · gm_acoustic_guitar_nylon');
    expect(code).toContain('// bass · "bass" · gm_acoustic_bass');
    expect(code).not.toMatch(/gm_(muted_trumpet|soprano_sax)/);
  });
  it('ignores a stray bank 127 when the parts fit General MIDI better, and says so', () => {
    // No GS reset; a bass patch in a bass register (MT-32 says "Harmo Pan") and a track called "Trumpet" on the trumpet patch (MT-32 says "Contrabass").
    const song = songFromMidi(smf([
      [{ tick: 0, bytes: [0xb0, 0, 127] }, { tick: 0, bytes: [0xc0, 33] }, ...lowLine(0, 16)],
      [name('Trumpet'), { tick: 0, bytes: [0xb1, 0, 127] }, { tick: 0, bytes: [0xc1, 56] }, ...highLine(1, 16)],
      kit(),
    ]), ID);
    expect(song.tracks.map((t) => t.program).sort((a, b) => a - b)).toEqual([-1, 33, 56]);
    expect(song.meta.remarks).toContain('bank select 127 on channels 1, 2 is ignored: the parts fit General MIDI, not the Roland MT-32 map it names');
    // The same file with a GS reset and nothing else to go on trusts the bank.
    const gs = songFromMidi(smf([[GS_RESET], [{ tick: 0, bytes: [0xb0, 0, 127] }, { tick: 0, bytes: [0xc0, 59] }, ...arpeggio(0, 16)], kit()]), ID);
    expect(gs.tracks.find((t) => t.program === 24)).toBeDefined();
    // A bass in a high register is not a bass: the MT-32 reading (a pad) wins even without a reset, as in Let It Be.
    const pads = songFromMidi(smf([[{ tick: 0, bytes: [0xb0, 0, 127] }, { tick: 0, bytes: [0xc0, 33] }, ...highLine(0, 16)], kit()]), ID);
    expect(pads.tracks.find((t) => t.channel === 0)!.program).toBe(89);
  });
  it('keeps a track name that @tonejs/midi leaves on a note-less sub-track (name, bank, program change, notes)', () => {
    // A bank or volume before the program change makes @tonejs/midi split the track and keep the name on the first, note-less piece.
    const data = smf([
      [name('Lead Vocal'), { tick: 0, bytes: [0xb0, 7, 100] }, { tick: 0, bytes: [0xc0, 26] }, ...highLine(0, 16)],
      [name('Whole song'), ...lowLine(1, 8), ...highLine(2, 8)], // notes on two channels: names neither
      [name('Later'), ...lowLine(1, 8)], // channel 1 already has no single-channel name; this one wins for it
      kit(),
    ]);
    expect(scanTrackNames(data)).toEqual(new Map([[0, 'Lead Vocal'], [1, 'Later']]));
    const song = songFromMidi(data, ID);
    expect(song.tracks.find((t) => t.channel === 0)).toMatchObject({ name: 'Lead Vocal', role: 'melody', vocal: true });
    expect(song.tracks.find((t) => t.channel === 2)!.name).toBe('');
  });
  it('reads a bank-less file whose track names are the MT-32 patch names through the MT-32 table, and says so', () => {
    // Twist and Shout's layout: no bank select, "Sq Wave" on 47 (a timpani in GM), "Doc Solo" on 44 (tremolo strings), "El Guitar" on 62 (synth brass), "Bass" on 64 (soprano sax).
    const song = songFromMidi(smf([
      [name('El Guitar'), { tick: 0, bytes: [0xc0, 62] }, ...arpeggio(0, 16)],
      [name('Sq Wave'), { tick: 0, bytes: [0xc1, 47] }, ...highLine(1, 16)],
      [name('Doc Solo'), { tick: 0, bytes: [0xc2, 44] }, ...up(highLine(2, 16), 3)],
      [name('Bass'), { tick: 0, bytes: [0xc3, 64] }, ...lowLine(3, 16)],
      [name('Piano'), { tick: 0, bytes: [0xc4, 0] }, ...up(highLine(4, 16), -5)], // fits both tables: votes for neither, remapped with the file (Acou Piano 1 -> piano)
      kit(),
    ]), ID);
    const by = (n: string) => song.tracks.find((t) => t.name === n)!;
    expect(by('El Guitar').program).toBe(29);
    expect(by('Sq Wave').program).toBe(80);
    expect(by('Doc Solo').program).toBe(87);
    expect(by('Bass')).toMatchObject({ program: 32, role: 'bass' });
    expect(by('Piano').program).toBe(0);
    expect(song.meta.remarks).toContain('track names are the Roland MT-32 patch names at their program numbers ("El Guitar" on 62, "Sq Wave" on 47, "Doc Solo" on 44, "Bass" on 64), so with no bank select the whole file is read through the MT-32 patch table: ch 1 "El Guitar" Elec Gtr 2 -> overdriven guitar; ch 2 "Sq Wave" Square Wave -> lead 1 square; ch 3 "Doc Solo" Doctor Solo -> lead 8 bass lead; ch 4 "Bass" Acou Bass 1 -> acoustic bass');
    expect(compile(song)).not.toMatch(/gm_(timpani|tremolo_strings|synth_brass|soprano_sax)/);
    expect(MT32_NAME_VOTES).toBe(2);
  });
  it('leaves a General MIDI file alone when its names fit both tables or the General MIDI one', () => {
    // "Flute" on 73 is "Flute 2" on the MT-32 and "Flute" in GM: no evidence. "Bass" on 33 and "Trumpet" on 56 fit GM only.
    const gm = songFromMidi(smf([
      [name('Flute'), { tick: 0, bytes: [0xc0, 73] }, ...highLine(0, 16)],
      [name('Strings'), { tick: 0, bytes: [0xc1, 48] }, ...arpeggio(1, 16)],
      [name('Bass'), { tick: 0, bytes: [0xc2, 33] }, ...lowLine(2, 16)],
      kit(),
    ]), ID);
    expect(gm.tracks.map((t) => t.program).sort((a, b) => a - b)).toEqual([-1, 33, 48, 73]);
    expect(gm.meta.remarks?.some((r) => r.includes('MT-32')) ?? false).toBe(false);
    // One MT-32-named channel is not enough, and MT-32 names must outnumber GM names by more than two to one.
    const one = songFromMidi(smf([[name('Doc Solo'), { tick: 0, bytes: [0xc0, 44] }, ...highLine(0, 16)], [name('Bass'), { tick: 0, bytes: [0xc2, 33] }, ...lowLine(2, 16)], kit()]), ID);
    expect(one.tracks.find((t) => t.name === 'Doc Solo')!.program).toBe(44);
    const tied = songFromMidi(smf([
      [name('Doc Solo'), { tick: 0, bytes: [0xc0, 44] }, ...highLine(0, 16)],
      [name('Sq Wave'), { tick: 0, bytes: [0xc1, 47] }, ...up(highLine(1, 16), 3)],
      [name('Bass'), { tick: 0, bytes: [0xc2, 33] }, ...lowLine(2, 16)],
      kit(),
    ]), ID);
    expect(tied.tracks.find((t) => t.name === 'Sq Wave')!.program).toBe(47);
    // A General MIDI reset settles it.
    const reset = songFromMidi(smf([[{ tick: 0, bytes: [0xf0, 0x05, 0x7e, 0x7f, 0x09, 0x01, 0xf7] }], [name('Doc Solo'), { tick: 0, bytes: [0xc0, 44] }, ...highLine(0, 16)], [name('Sq Wave'), { tick: 0, bytes: [0xc1, 47] }, ...up(highLine(1, 16), 3)], kit()]), ID);
    expect(reset.tracks.find((t) => t.name === 'Sq Wave')!.program).toBe(47);
  });
  it('lets a General MIDI part\'s name overrule a patch of a family it contradicts, and trusts a name that fits its patch', () => {
    const song = songFromMidi(smf([
      [name('ORGAN - MELODY'), { tick: 0, bytes: [0xc0, 0] }, ...highLine(0, 16)], // the piano every channel starts on
      [name('12 String'), { tick: 0, bytes: [0xc1, 0] }, ...arpeggio(1, 16)], // a guitar, not a string section
      [name('Bass'), { tick: 0, bytes: [0xc2, 27] }, ...lowLine(2, 16)], // a bass on a guitar patch
      [name('Banjo'), { tick: 0, bytes: [0xc3, 105] }, ...up(arpeggio(3, 16), 1)], // its own patch
      [name('Horns'), { tick: 0, bytes: [0xc4, 66] }, ...up(highLine(4, 16), 5)], // a horn section on a sax: a stand-in, not a contradiction
      [name('Guitar Pad'), { tick: 0, bytes: [0xc5, 89] }, ...up(arpeggio(5, 16), 2)], // a synth asked for on a synth
      [name('Steel String'), { tick: 0, bytes: [0xc6, 25] }, ...up(arpeggio(6, 16), 3)], // its own patch
      [name('Lead Guitar'), { tick: 0, bytes: [0xc7, 81] }, ...up(highLine(7, 16), 7)], // a lead guitar on a sawtooth lead
      kit(),
    ]), ID);
    const program = (n: string) => song.tracks.find((t) => t.name === n)!.program;
    expect(program('ORGAN - MELODY')).toBe(16);
    expect(program('12 String')).toBe(25);
    expect(program('Bass')).toBe(33);
    expect(program('Banjo')).toBe(105);
    expect(program('Horns')).toBe(66);
    expect(program('Guitar Pad')).toBe(89);
    expect(program('Steel String')).toBe(25);
    expect(program('Lead Guitar')).toBe(29);
    expect(song.meta.remarks).toContain('ch 1 "ORGAN - MELODY" named as an organ, played on drawbar organ (its piano patch is not one); ch 2 "12 String" named as a guitar, played on acoustic guitar steel (its piano patch is not one); ch 3 "Bass" named as a bass, played on electric bass finger (its electric guitar clean patch is not one); ch 8 "Lead Guitar" named as a guitar, played on overdriven guitar (its lead 2 sawtooth patch is not one)');
    expect(compile(song)).toContain('// melody · "ORGAN - MELODY" · gm_drawbar_organ · instrumental lead, keeps its own instrument');
    expect(compile(song)).toContain('// bass · "Bass" · gm_electric_bass_finger');
    expect(reconcileName('Guitar', 0)).toEqual({ program: 27, why: 'named as a guitar, played on electric guitar clean (its piano patch is not one)' });
    expect(reconcileName('Piano', 0)).toEqual({ program: 0 });
    expect(reconcileName('Vocals', 0)).toEqual({ program: 0 }); // not a definite family
    // A channel that changes family mid-song ("Str etc." on strings, then a guitar) is named for its first instrument only.
    const mixed = songFromMidi(smf([
      [name('Strings'), { tick: 0, bytes: [0xc0, 48] }, ...arpeggio(0, 8), { tick: 8 * 4 * PPQ, bytes: [0xc0, 27] }, ...up(highLine(0, 16), 0).filter((e) => e.tick >= 8 * 4 * PPQ)],
      kit(),
    ]), ID);
    expect(mixed.tracks.filter((t) => t.name === 'Strings').map((t) => t.program).sort((a, b) => a - b)).toEqual([27, 48]);
    expect(mixed.meta.remarks ?? []).not.toContainEqual(expect.stringContaining('named as'));
  });
  it('lets a track name overrule a bank-127 program that neither table reads as the named instrument', () => {
    // Let It Be: "Les Paul 2" and "Overdrive Guitar" on bank 127 program 33 (a finger bass in GM, "Harmo Pan" on the MT-32), a GS file.
    const song = songFromMidi(smf([
      [GS_RESET],
      [name('Les Paul 2'), { tick: 0, bytes: [0xb0, 0, 127] }, { tick: 0, bytes: [0xc0, 33] }, ...highLine(0, 16)],
      [name('Overdrive Guitar'), { tick: 0, bytes: [0xb1, 0, 127] }, { tick: 0, bytes: [0xc1, 33] }, ...arpeggio(1, 16)],
      [name('Bass'), { tick: 0, bytes: [0xb2, 0, 0] }, { tick: 0, bytes: [0xc2, 32] }, ...lowLine(2, 16)],
      kit(),
    ]), ID);
    expect(song.tracks.find((t) => t.name === 'Les Paul 2')!.program).toBe(29);
    expect(song.tracks.find((t) => t.name === 'Overdrive Guitar')!.program).toBe(29);
    expect(song.meta.remarks).toContain('"Les Paul 2" named as a guitar, played on overdriven guitar (neither patch table reads its program as one); "Overdrive Guitar" named as a guitar, played on overdriven guitar (neither patch table reads its program as one)');
    expect(compile(song)).toContain('// chords · "Overdrive Guitar" · gm_overdriven_guitar');
    expect(compile(song)).not.toContain('gm_pad_warm');
    // A name that fits the other table's reading takes that reading: "Bass" on 34 in an MT-32-named file is a bass, not the "Chorale".
    expect(reconcileName('Bass', 52, 34)).toEqual({ program: 34, why: 'named as a bass, played on electric bass pick (the other patch table\'s reading)' });
    expect(reconcileName('Les Paul', 89, 33).program).toBe(29);
    expect(reconcileName('Vocal', 89, 33)).toEqual({ program: 89 }); // not a definite family
    expect(reconcileName('Strings', 48, 33)).toEqual({ program: 48 });
    expect(reconcileName('', 89, 33)).toEqual({ program: 89 });
    // A part named after the chosen table's own patch is what the table says: "Warm Bell" on MT-32 38 is a pad, not a tubular bell.
    const bells = songFromMidi(smf([
      [name('Warm Bell'), { tick: 0, bytes: [0xc0, 38] }, ...arpeggio(0, 16)],
      [name('Doc Solo'), { tick: 0, bytes: [0xc1, 44] }, ...highLine(1, 16)],
      [name('Sq Wave'), { tick: 0, bytes: [0xc2, 47] }, ...up(highLine(2, 16), 3)],
      kit(),
    ]), ID);
    expect(bells.tracks.find((t) => t.name === 'Warm Bell')!.program).toBe(92);
  });
  it('merges a channel split by a stray bank select mid-track back into one part', () => {
    // CC 0 = 127 sent between two identical program changes, in a file that fits General MIDI: one part, not a banked and an unbanked one.
    const song = songFromMidi(smf([
      [name('Trumpet'), { tick: 0, bytes: [0xc0, 56] }, ...highLine(0, 8), { tick: 32 * PPQ, bytes: [0xb0, 0, 127] }, { tick: 32 * PPQ, bytes: [0xc0, 56] }, ...highLine(0, 8).map((e) => ({ ...e, tick: e.tick + 32 * PPQ }))],
      [name('Bass'), { tick: 0, bytes: [0xc1, 33] }, ...lowLine(1, 16)],
      kit(),
    ]), ID);
    const trumpets = song.tracks.filter((t) => t.program === 56);
    expect(trumpets).toHaveLength(1);
    expect(trumpets[0].notes).toHaveLength(128);
    expect(song.meta.remarks).toContain('bank select 127 on channel 1 is ignored: the parts fit General MIDI, not the Roland MT-32 map it names');
  });
  it('folds a single-pitch part named as a drum on a drum-like patch into the kit', () => {
    // Twist and Shout: "Snare Drum" on the synth-drum patch hammering one pitch.
    const snare = Array.from({ length: 16 }, (_, b) => [...rawNote(3, 77, b * 4 + 1, 0.25), ...rawNote(3, 77, b * 4 + 3, 0.25)]).flat();
    const song = songFromMidi(smf([[name('Snare Drum'), { tick: 0, bytes: [0xc3, 118] }, ...snare], [name('Piano'), { tick: 0, bytes: [0xc0, 0] }, ...highLine(0, 16)], kit()]), ID);
    expect(song.tracks.some((t) => t.program === 118)).toBe(false);
    const drums = song.tracks.find((t) => t.role === 'drums')!;
    expect(drums.notes.filter((n) => n.pitch === 38)).toHaveLength(32 + 2);
    expect(song.meta.remarks).toContain('ch 4 "Snare Drum" (synth drum patch on one pitch) is played as the kit\'s snare');
    // A taiko line on two pitches, or one without a drum name, stays a pitched part.
    const taiko = songFromMidi(smf([[name('Taiko'), { tick: 0, bytes: [0xc3, 116] }, ...snare], kit()]), ID);
    expect(taiko.tracks.find((t) => t.program === 116)).toBeDefined();
  });
  it('folds several single-pitch drum parts into one kit when the file has no percussion channel', () => {
    const hits = (pitch: number, offset: number): [number, number, number][] => Array.from({ length: 16 }, (_, i) => [pitch, i * 2 + offset, 0.25]);
    const song = songFromMidi(build([
      { channel: 0, program: 118, name: 'Kick', notes: hits(60, 0) },
      { channel: 1, program: 118, name: 'Snare Drum', notes: hits(62, 1) },
      { channel: 2, program: 116, name: 'Hi-Hat', notes: hits(64, 0.5) },
      { channel: 3, program: 0, notes: eighths(60, 8) },
    ]), ID);
    const kits = song.tracks.filter((t) => t.role === 'drums');
    expect(kits).toHaveLength(1);
    expect(kits[0].notes.map((n) => n.pitch).sort((a, b) => a - b)).toEqual([...Array(16).fill(36), ...Array(16).fill(38), ...Array(16).fill(42)]);
    expect(song.tracks.filter((t) => t.program === 118 || t.program === 116)).toHaveLength(0);
    expect(song.meta.remarks!.filter((r) => r.includes('is played as the kit'))).toHaveLength(3);
    const code = compile(song);
    expect(code).toMatch(/const drums = s\("<\[bd ~ hh ~ sd ~@3 bd ~ hh ~ sd ~@3\]!8>"\)/);
    expect(code).not.toMatch(/gm_(synth_drum|taiko_drum)/);
  });
  it('applies a bank select only at the next program change', () => {
    // CC 0 = 127 after the program change (the Ventures' files): nothing is selected, the guitar stays a guitar.
    const song = songFromMidi(smf([[GS_RESET], [{ tick: 0, bytes: [0xc0, 26] }, { tick: 4, bytes: [0xb0, 0, 127] }, ...arpeggio(0, 16)], kit()]), ID);
    expect(song.tracks.find((t) => t.channel === 0)!.program).toBe(26);
    expect(song.meta.remarks?.some((r) => r.includes('bank select')) ?? false).toBe(false);
  });
  it('treats bank 127 as a drum kit in an XG file, and honours GS rhythm-part assignments', () => {
    const xg = songFromMidi(smf([[XG_ON], [{ tick: 0, bytes: [0xb3, 0, 127] }, { tick: 0, bytes: [0xc3, 25] }, ...kit(3)], [{ tick: 0, bytes: [0xc0, 0] }, ...highLine(0, 8)]]), ID);
    expect(xg.tracks.find((t) => t.role === 'drums')!.notes).toHaveLength(4);
    expect(xg.tracks.find((t) => t.channel === 3 && t.role !== 'drums')).toBeUndefined();
    const gs = songFromMidi(smf([
      [GS_RESET, { tick: 0, bytes: [0xf0, 0x0a, 0x41, 0x10, 0x42, 0x12, 0x40, 0x1a, 0x15, 0x02, 0x0f, 0xf7] }],
      [{ tick: 0, bytes: [0xca, 0] }, ...kit(10)],
      [{ tick: 0, bytes: [0xc0, 0] }, ...highLine(0, 8)],
    ]), ID);
    expect(gs.tracks.find((t) => t.role === 'drums')!.notes).toHaveLength(4);
    expect(gs.tracks.filter((t) => t.role !== 'drums')).toHaveLength(1);
  });
});

describe('songFromMidi mix and controllers', () => {
  it('folds CC 7 x CC 11 into track volume and CC 10 into pan, from the track that carries them', () => {
    const data = build([
      // volume/pan for channel 3 live on a separate, note-less track (format-1 habit)
      { channel: 3, notes: [], cc: [{ number: 7, beat: 0, value: 64 }, { number: 11, beat: 0, value: 127 }, { number: 10, beat: 0, value: 0 }] },
      { channel: 3, program: 0, notes: eighths(60, 2) },
      { channel: 4, program: 48, notes: [[60, 0, 4], [64, 0, 4], [67, 0, 4]], cc: [{ number: 7, beat: 0, value: 100 }, { number: 11, beat: 0, value: 64 }] },
    ]);
    const song = songFromMidi(data, ID);
    const piano = song.tracks.find((t) => t.channel === 3)!;
    const strings = song.tracks.find((t) => t.channel === 4)!;
    expect(piano.volume).toBeCloseTo(64 / 127, 2);
    expect(piano.pan).toBe(0);
    expect(strings.volume).toBeCloseTo((100 / 127) * (64 / 127), 2);
    expect(strings.pan).toBeUndefined();
  });
  it('uses the median controller value over the notes, not a late fade-out', () => {
    const notes = eighths(60, 4);
    const data = build([{ channel: 0, program: 0, notes, cc: [{ number: 7, beat: 0, value: 100 }, { number: 7, beat: 14, value: 10 }] }]);
    const song = songFromMidi(data, ID);
    expect(song.tracks[0].volume).toBeCloseTo(100 / 127, 2);
  });
  it('renders a pan that moves mid-song at the mean and a level that moves at the median, and notes both on the part', () => {
    const notes = eighths(60, 4);
    const moving = songFromMidi(build([{ channel: 0, program: 0, notes, cc: [{ number: 10, beat: 0, value: 64 }, { number: 10, beat: 8, value: 0 }, { number: 7, beat: 0, value: 100 }, { number: 7, beat: 12, value: 40 }] }]), ID);
    const t = moving.tracks[0];
    expect(t.pan).toBe(0.25); // half the notes at 64, half at 0
    expect(t.volume).toBeCloseTo(100 / 127, 2); // three bars at 100, one at 40
    expect(t.remarks).toEqual(['level moves 31%-79% (CC 7 x CC 11), median used', 'pan moves 0-64 (CC 10), mean used']);
    expect(compile(moving)).toContain('· pan moves 0-64 (CC 10), mean used');
    // A fade-out at the very end is a movement too small at the 90th percentile to be noted.
    const steady = songFromMidi(build([{ channel: 0, program: 0, notes, cc: [{ number: 10, beat: 0, value: 20 }, { number: 7, beat: 0, value: 100 }, { number: 7, beat: 15, value: 10 }] }]), ID);
    expect(steady.tracks[0].remarks).toBeUndefined();
    expect(steady.tracks[0].pan).toBe(0.15);
  });
  it('caps a stuck note (no note-off) at 8 bars so it cannot stretch the song', () => {
    const song = songFromMidi(build([{ channel: 0, program: 0, notes: [[60, 0, 1000], ...eighths(64, 2)] }]), ID);
    expect(song.tracks[0].notes[0].duration).toBe(32);
    expect(barRange(song)!.totalBars).toBe(8);
  });
  it('lengthens notes held by the sustain pedal until it is released', () => {
    const data = build([{ channel: 0, program: 0, notes: [[60, 0, 0.5], [64, 1, 0.5], [60, 3, 0.5]], cc: [{ number: 64, beat: 0, value: 127 }, { number: 64, beat: 2, value: 0 }] }]);
    const song = songFromMidi(data, ID);
    const [a, b, c] = song.tracks[0].notes;
    expect(a.duration).toBeCloseTo(2); // pedal up at beat 2
    expect(b.duration).toBeCloseTo(1); // pedal up at beat 2
    expect(c.duration).toBeCloseTo(0.5); // pedal already up
    expect(song.meta.remarks).toContain('sustain pedal (CC 64) lengthens the held notes');
  });
  it('transposes a channel by its RPN coarse tuning', () => {
    // (@tonejs/midi writes controllers in number order, so the data entry gets a later tick.)
    const data = build([{ channel: 0, program: 0, notes: [[60, 1, 1]], cc: [
      { number: 101, beat: 0, value: 0 }, { number: 100, beat: 0, value: 2 }, { number: 6, beat: 0.5, value: 64 + 12 },
    ] }]);
    const song = songFromMidi(data, ID);
    expect(song.tracks[0].notes[0].pitch).toBe(72);
  });
  it('splits a channel that changes program mid-song into one part per instrument', () => {
    const track = [{ tick: 0, bytes: [0xc0, 0] }, { tick: 8 * PPQ, bytes: [0xc0, 40] }];
    for (const [pitch, start, dur] of eighths(60, 2).concat(eighths(62, 2, 8))) track.push(...rawNote(0, pitch, start, dur));
    const song = songFromMidi(smf([track]), ID);
    expect(song.tracks.map((t) => [t.program, t.notes.length]).sort()).toEqual([[0, 16], [40, 16]]);
  });
});

describe('songFromMidi roles', () => {
  const drums = { channel: 9, notes: [[36, 0, 0.25], [38, 1, 0.25], [36, 2, 0.25], [38, 3, 0.25]] as [number, number, number][] };
  it('does not turn a low guitar riff into the bass, but keeps a real bass', () => {
    const riff: [number, number, number][] = [];
    for (let i = 0; i < 32; i++) riff.push([40 + (i % 4) * 2, i / 2, 0.4]); // E2-B2 on a muted guitar
    const bassLine: [number, number, number][] = [];
    for (let i = 0; i < 16; i++) bassLine.push([28 + (i % 2) * 7, i, 0.9]);
    const song = songFromMidi(build([{ channel: 0, program: 28, notes: riff }, { channel: 1, program: 33, notes: bassLine }, drums]), ID);
    expect(song.tracks.find((t) => t.program === 28)!.role).not.toBe('bass');
    expect(song.tracks.find((t) => t.program === 33)!.role).toBe('bass');
  });
  it('does not call a tune written on a bass patch the bass, but trusts a track named bass in a low register', () => {
    const tune: [number, number, number][] = [];
    for (let i = 0; i < 32; i++) tune.push([67 + [0, 2, 4, 5, 7, 5, 4, 2][i % 8], i / 2, 0.45]); // G4-G5 on a fretless bass
    const bassLine: [number, number, number][] = [];
    for (let i = 0; i < 32; i++) bassLine.push([40 + [0, 0, 7, 5][i % 4], i / 2, 0.45]); // E2-B2, 'bass' on a sax patch
    const song = songFromMidi(build([
      { channel: 0, program: 35, notes: tune },
      { channel: 1, program: 64, name: 'bass', notes: bassLine },
      { channel: 2, program: 33, notes: bassLine.map(([p, st, d]) => [p - 12, st, d]) },
      drums,
    ]), ID);
    expect(song.tracks.find((t) => t.program === 35)!.role).not.toBe('bass');
    expect(song.tracks.find((t) => t.program === 64)!.role).toBe('bass');
    expect(song.tracks.find((t) => t.program === 33)!.role).toBe('bass');
    // A bass patch that is also named bass is trusted up to middle C (G3-G4 here), but not a tune above it.
    const named = songFromMidi(build([{ channel: 0, program: 34, name: 'Electric Bass', notes: tune.map(([p, st, d]) => [p - 12, st, d]) }, drums]), ID);
    expect(named.tracks.find((t) => t.program === 34)!.role).toBe('bass');
    const high = songFromMidi(build([{ channel: 0, program: 38, name: 'Synth Bass', notes: tune }, drums]), ID);
    expect(high.tracks.find((t) => t.program === 38)!.role).not.toBe('bass');
    // Still: a low guitar part named 'bass drum & guitar' is not the bass by name alone.
    const kick = songFromMidi(build([{ channel: 0, program: 27, name: 'Bass Drum Guitar', notes: bassLine }, drums]), ID);
    expect(kick.tracks.find((t) => t.program === 27)!.role).not.toBe('bass');
  });
  it('classifies a genuinely low, monophonic piano line as bass', () => {
    const low: [number, number, number][] = [];
    for (let i = 0; i < 16; i++) low.push([36 + (i % 2) * 3, i, 0.9]);
    const song = songFromMidi(build([{ channel: 0, program: 0, notes: low }, { channel: 1, program: 73, notes: eighths(72, 2) }]), ID);
    expect(song.tracks.find((t) => t.program === 0)!.role).toBe('bass');
  });
  it('takes a double bass or tuba line in the bass register for the bass, but not a cello, and keeps a bass patch the main bass', () => {
    const walk = Array.from({ length: 64 }, (_, i) => [43 + [0, 4, 7, 9][i % 4], i / 2, 0.7] as [number, number, number]); // G2-E3, median C3
    const flute = Array.from({ length: 64 }, (_, i) => [72 + [0, 2, 4, 5][i % 4], i / 2, 0.6] as [number, number, number]);
    const contrabass = songFromMidi(build([{ channel: 0, program: 43, name: 'Contrebasse', notes: walk }, { channel: 1, program: 73, notes: flute }, drums]), ID);
    expect(contrabass.tracks.find((t) => t.program === 43)).toMatchObject({ role: 'bass', name: 'Contrebasse' });
    expect(compile(contrabass)).toContain('// bass · "Contrebasse" · gm_contrabass · gain');
    const tuba = songFromMidi(build([{ channel: 0, program: 58, notes: walk }, { channel: 1, program: 73, notes: flute }, drums]), ID);
    expect(tuba.tracks.find((t) => t.program === 58)!.role).toBe('bass');
    const cello = songFromMidi(build([{ channel: 0, program: 42, notes: walk }, { channel: 1, program: 73, notes: flute }, drums]), ID);
    expect(cello.tracks.find((t) => t.program === 42)!.role).toBe('other');
    // Two octaves up the same walk is a line, not the bass.
    const high = songFromMidi(build([{ channel: 0, program: 43, notes: walk.map(([p, st, v]) => [p + 24, st, v] as [number, number, number]) }, { channel: 1, program: 73, notes: flute }, drums]), ID);
    expect(high.tracks.find((t) => t.program === 43)!.role).not.toBe('bass');
    // Next to a bass patch the tuba is a second bass; the bass patch stays the main one and takes the `bass` name.
    const both = songFromMidi(build([
      { channel: 0, program: 33, notes: walk.map(([p, st]) => [p - 12, st, 0.9] as [number, number, number]) },
      { channel: 1, program: 58, notes: walk },
      { channel: 2, program: 73, notes: flute },
      drums,
    ]), ID);
    expect(both.tracks.filter((t) => t.role === 'bass').map((t) => t.program).sort((a, b) => a - b)).toEqual([33, 58]);
    const code = compile(both);
    expect(code).toMatch(/const bass = [^\n]+\n {2}\.s\("gm_electric_bass_finger"\)/);
    expect(code).toMatch(/const bass_2 = [^\n]+\n {2}\.s\("gm_tuba"\)/);
  });
  it('flags vocal-like melodies (patch or name) and leaves instrumental leads alone', () => {
    const line = eighths(65, 4);
    const choir = songFromMidi(build([{ channel: 0, program: 52, notes: line }, drums]), ID);
    expect(choir.tracks.find((t) => t.program === 52)).toMatchObject({ role: 'melody', vocal: true });
    const named = songFromMidi(build([{ channel: 0, program: 0, name: 'Lead Vocal', notes: line }, drums]), ID);
    expect(named.tracks.find((t) => t.program === 0)).toMatchObject({ role: 'melody', vocal: true });
    const guitar = songFromMidi(build([{ channel: 0, program: 26, notes: line }, drums]), ID);
    const g = guitar.tracks.find((t) => t.program === 26)!;
    expect(g.role).toBe('melody');
    expect(g.vocal).toBeUndefined();
  });
  it('prefers a lead patch with a real melodic range over a busy muted-guitar rhythm part', () => {
    const rhythm: [number, number, number][] = [];
    for (let i = 0; i < 128; i++) rhythm.push([57 + (i % 4 === 3 ? 2 : 0), i / 4, 0.2]); // 16ths on two pitches
    const tune: [number, number, number][] = [];
    for (let i = 0; i < 48; i++) tune.push([69 + [0, 2, 4, 7, 9, 7, 4, 2][i % 8], i * 0.5, 0.45]);
    const song = songFromMidi(build([{ channel: 0, program: 28, name: 'mt guitar', notes: rhythm }, { channel: 1, program: 81, notes: tune }, drums]), ID);
    expect(song.tracks.find((t) => t.program === 81)!.role).toBe('melody');
    expect(song.tracks.find((t) => t.program === 28)!.role).not.toBe('melody');
  });
  it('does not take a "lead" guitar or synth for a singer', () => {
    const line = eighths(65, 4);
    for (const name of ['lead git', 'Lead Guitar', 'lead synth', 'Lead']) {
      const song = songFromMidi(build([{ channel: 0, program: 30, name, notes: line }, drums]), ID);
      expect(song.tracks.find((t) => t.program === 30)!.vocal, name).toBeUndefined();
    }
  });
  it('reassembles a sung line spread over singer stand-in channels, leaving a guitar solo of the same length out', () => {
    // Verses on a french horn (bars 1-8), chorus on an alto sax (bars 9-16), a busy guitar solo (bars 17-24), piano triads throughout.
    const tune = (root: number, n: number, from: number, step = 0.5): [number, number, number][] =>
      Array.from({ length: n }, (_, i) => [root + [0, 2, 4, 7, 9, 7, 4, 2][i % 8], from + i * step, step * 0.9]);
    const triads = Array.from({ length: 48 }, (_, b) => [[48, b * 2, 2], [52, b * 2, 2], [55, b * 2, 2]] as [number, number, number][]).flat();
    const song = songFromMidi(build([
      { channel: 0, program: 60, notes: tune(67, 64, 0) },
      { channel: 1, program: 65, notes: tune(69, 64, 32) },
      { channel: 2, program: 30, notes: tune(72, 128, 64, 0.25) },
      { channel: 3, program: 0, notes: triads },
      drums,
    ]), ID);
    expect(song.tracks.find((t) => t.program === 60)!.role).toBe('melody');
    expect(song.tracks.find((t) => t.program === 65)!.role).toBe('melody');
    expect(song.tracks.find((t) => t.program === 30)!.role).toBe('other');
    expect(song.tracks.filter((t) => t.sungLine).map((t) => t.program).sort()).toEqual([60, 65]);
    // Stand-in patches taking turns are the singer: every section plays on the melody sound, so the lead is one consistent voice and the melody-sound option applies.
    expect(song.tracks.filter((t) => t.sungLine).every((t) => t.vocal)).toBe(true);
    const code = compile(song);
    expect(code).not.toContain('const melody =');
    expect(code).not.toContain('const melody =');
    expect(code).not.toMatch(/gm_(french_horn|alto_sax)|instrumental lead/);
    expect(compile(song, { melodySound: 'gm_lead_1_square' })).not.toContain('gm_lead_1_square');
    const noMelody = compile(song, { melody: false });
    expect(noMelody).not.toMatch(/gm_(french_horn|alto_sax|lead_2_sawtooth)/);
    expect(noMelody).toContain('gm_distortion_guitar');
    // A synth riff in sixteenths that takes turns with the sung line on another synth lead is a hook, not a verse: it stays out.
    const riff = songFromMidi(build([{ channel: 0, program: 81, notes: tune(84, 128, 0, 0.25) }, { channel: 1, program: 82, notes: tune(69, 96, 32) }, { channel: 3, program: 0, notes: triads }, drums]), ID);
    expect(riff.tracks.find((t) => t.program === 82)!.role).toBe('melody');
    expect(riff.tracks.find((t) => t.program === 81)!.role).toBe('other');
    // A guitar that takes turns with a guitar is not reassembled: the busier one is the tune on its own.
    const guitars = songFromMidi(build([{ channel: 0, program: 26, notes: tune(67, 64, 0) }, { channel: 2, program: 30, notes: tune(72, 128, 32, 0.25) }, { channel: 3, program: 0, notes: triads }, drums]), ID);
    expect(guitars.tracks.filter((t) => t.role === 'melody').map((t) => t.program)).toEqual([30]);
  });
  it('takes a line sung in two-part harmony for the tune, but not block chords', () => {
    // An organ line with a third under every fourth note (dyads, never triads) through the song, and a guitar solo late on.
    const line: [number, number, number][] = [];
    for (let i = 0; i < 128; i++) {
      const p = 72 + [0, 2, 4, 5, 7, 5, 4, 2][i % 8];
      line.push([p, i / 2, 0.45]);
      if (i % 4 === 3) line.push([p - 4, i / 2, 0.45]);
    }
    const solo: [number, number, number][] = Array.from({ length: 96 }, (_, i) => [76 + [0, 3, 5, 7, 10, 7, 5, 3][i % 8], 64 + i / 4, 0.2]);
    const song = songFromMidi(build([{ channel: 0, program: 18, notes: line }, { channel: 1, program: 29, notes: solo }, drums]), ID);
    expect(song.tracks.find((t) => t.program === 18)!.role).toBe('melody');
    expect(song.tracks.find((t) => t.program === 29)!.role).toBe('other');
    // The same line as block chords (a triad on every note) is harmony, and the solo becomes the tune.
    const chords = line.filter(([, s]) => Number.isInteger(s * 2)).flatMap(([p, s, d]) => [[p, s, d], [p - 4, s, d], [p - 7, s, d]] as [number, number, number][]);
    const blocks = songFromMidi(build([{ channel: 0, program: 18, notes: chords }, { channel: 1, program: 29, notes: solo }, drums]), ID);
    expect(blocks.tracks.find((t) => t.program === 18)!.role).toBe('chords');
    expect(blocks.tracks.find((t) => t.program === 29)!.role).toBe('melody');
  });
  it('does not let a short vocal-patch line outrank the sung line on an instrument', () => {
    // A synth choir "aah" over 4 bars against an alto sax that carries 16 bars: the sax is the tune, the choir a backing vocal.
    const tune = (root: number, n: number, from: number): [number, number, number][] =>
      Array.from({ length: n }, (_, i) => [root + [0, 2, 4, 7, 9, 7, 4, 2][i % 8], from + i / 2, 0.45]);
    const song = songFromMidi(build([{ channel: 0, program: 54, notes: tune(64, 16, 48) }, { channel: 1, program: 65, notes: tune(64, 128, 0) }, drums]), ID);
    expect(song.tracks.find((t) => t.program === 65)!.role).toBe('melody');
    expect(song.tracks.find((t) => t.program === 54)).toMatchObject({ role: 'other', vocal: true });
  });
  it('never crowns a stub, a one-bar fill, a drum-like patch or a muted line the melody, but keeps a muted sung line', () => {
    const triads = Array.from({ length: 64 }, (_, b) => [[48, b * 2, 2], [52, b * 2, 2], [55, b * 2, 2]] as [number, number, number][]).flat();
    const stub: [number, number, number][] = [[75, 34, 0.5], [77, 35, 0.5], [79, 36, 0.5]];
    const fill: [number, number, number][] = Array.from({ length: 17 }, (_, i) => [47 + (i % 2), 40 + i / 4, 0.2]);
    const parts = [{ channel: 0, program: 0, notes: triads }, { channel: 1, program: 30, notes: stub }, { channel: 2, program: 47, notes: fill }, drums];
    expect(songFromMidi(build(parts), ID).tracks.some((t) => t.role === 'melody')).toBe(false);
    // A pad line spread over a few bars is a candidate only once it covers four bars.
    const short = songFromMidi(build([...parts, { channel: 3, program: 73, notes: eighths(72, 3) }]), ID);
    expect(short.tracks.find((t) => t.program === 73)!.role).not.toBe('melody');
    const long = songFromMidi(build([...parts, { channel: 3, program: 73, notes: eighths(72, 4) }]), ID);
    expect(long.tracks.find((t) => t.program === 73)!.role).toBe('melody');
    // A muted line (CC 7 = 0) is a guide track and not the tune; named as the vocal it is the tune, and the compiler lifts it.
    const line = eighths(72, 16);
    const muted = songFromMidi(build([...parts, { channel: 3, program: 73, notes: line, cc: [{ number: 7, beat: 0, value: 0 }] }, { channel: 4, program: 65, notes: eighths(69, 8, 64) }]), ID);
    expect(muted.tracks.find((t) => t.program === 73)!.role).toBe('other');
    expect(muted.tracks.find((t) => t.program === 65)!.role).toBe('melody');
    const guide = songFromMidi(build([...parts, { channel: 3, program: 73, name: 'Vocal', notes: line, cc: [{ number: 7, beat: 0, value: 0 }] }, { channel: 4, program: 65, notes: eighths(69, 8, 64) }]), ID);
    expect(guide.tracks.find((t) => t.program === 73)).toMatchObject({ role: 'melody', vocal: true, volume: 0 });
    const code = compile(guide);
    // (The sax that takes turns with it joins the sung line, so the guide is "one section of it".)
    expect(code).not.toContain('const melody =');
    const alone = songFromMidi(build([...parts, { channel: 3, program: 73, name: 'Vocal', notes: line, cc: [{ number: 7, beat: 0, value: 0 }] }]), ID);
    expect(compile(alone)).not.toContain('const melody =');
  });
  it('reads vocal track names whatever else they mention, but not instruments described as leads or melodies', () => {
    for (const name of ['Vocals', 'Lead Vocal', 'Vocal Harmony', 'Lead Vocal (Saxophone)', 'sax vocal lead', 'Synth Vox', 'SOLO VOX SYNTH', 'backing vocals', 'Synth Voice (Backing Vox)', 'Voice 2 (Harmony)', 'Vocal/Strings', 'Melody', 'Singer']) {
      expect(nameSaysVocal(name), name).toBe(true);
    }
    for (const name of ['lead git', 'Lead Guitar', 'lead synth', 'Lead', 'Guitar melody', 'Piano', 'Melody Strings', 'Bass melody', 'Melody Cello', 'Oboe melody', 'Melody Accordion', 'Trombone Melody', 'melody vibes', 'Harp Melody', 'Banjo melody', '']) {
      expect(nameSaysVocal(name), name).toBe(false);
    }
  });
  it('gives a vocal name the melody only for a substantial part, and keeps a token "Voices" part as a backing vocal', () => {
    // Tom's Diner: a 395-note guitar line, and "Voices" with ten choir notes: the guitar is the tune.
    const tune = (root: number, n: number, from: number): [number, number, number][] =>
      Array.from({ length: n }, (_, i) => [root + [0, 2, 4, 7, 9, 7, 4, 2][i % 8], from + i / 2, 0.45]);
    const token = songFromMidi(build([{ channel: 0, program: 26, name: 'Guitar', notes: tune(64, 400, 0) }, { channel: 1, program: 52, name: 'Voices', notes: tune(67, 10, 32) }, drums]), ID);
    expect(token.tracks.find((t) => t.name === 'Guitar')!.role).toBe('melody');
    expect(token.tracks.find((t) => t.name === 'Voices')).toMatchObject({ role: 'other', vocal: true });
    // The same vocal part carrying a tenth of the busiest part's notes is the tune.
    const real = songFromMidi(build([{ channel: 0, program: 26, name: 'Guitar', notes: tune(64, 400, 0) }, { channel: 1, program: 52, name: 'Voices', notes: tune(67, 40, 32) }, drums]), ID);
    expect(real.tracks.find((t) => t.name === 'Voices')!.role).toBe('melody');
    expect(VOCAL_NAME_MIN_NOTE_SHARE).toBe(0.1);
    expect(VOCAL_NAME_MIN_COVERAGE).toBe(0.15);
  });
  it('does not crown a lick over a tenth of the song the instrumental lead', () => {
    const triads = Array.from({ length: 200 }, (_, b) => [[48, b * 2, 2], [52, b * 2, 2], [55, b * 2, 2]] as [number, number, number][]).flat(); // 100 bars
    const lick: [number, number, number][] = Array.from({ length: 40 }, (_, i) => [72 + [0, 2, 4, 7][i % 4], 120 + i / 2, 0.4]); // 5 bars
    const song = songFromMidi(build([{ channel: 0, program: 0, notes: triads }, { channel: 1, program: 30, notes: lick }, drums]), ID);
    expect(song.tracks.find((t) => t.program === 30)!.role).toBe('other');
    const longer: [number, number, number][] = Array.from({ length: 96 }, (_, i) => [72 + [0, 2, 4, 7][i % 4], 120 + i / 2, 0.4]); // 12 bars
    expect(songFromMidi(build([{ channel: 0, program: 0, notes: triads }, { channel: 1, program: 30, notes: longer }, drums]), ID).tracks.find((t) => t.program === 30)!.role).toBe('melody');
    expect(MELODY_MIN_COVERAGE).toBe(0.1);
  });
  it('keeps at most one bass by register once the song has a bass on a bass patch', () => {
    const low = (from: number, step = 2): [number, number, number][] => Array.from({ length: 32 }, (_, i) => [36 + (i % 2) * step, from + i / 2, 0.4]);
    const song = songFromMidi(build([
      { channel: 0, program: 33, notes: low(0, 6) },
      { channel: 1, program: 0, notes: low(0, 5) }, // a low piano line
      { channel: 2, program: 29, notes: low(0, 3).concat(low(16, 3)) }, // a low guitar line (below the guitar's low E), more of it
      { channel: 3, program: 73, notes: eighths(76, 8) },
      drums,
    ]), ID);
    expect(song.tracks.find((t) => t.program === 33)!.role).toBe('bass');
    expect(song.tracks.find((t) => t.program === 29)!.role).toBe('bass');
    expect(song.tracks.find((t) => t.program === 0)!.role).toBe('other');
    // Without a bass patch, low lines are basses by register as before.
    const none = songFromMidi(build([{ channel: 1, program: 0, notes: low(0, 5) }, { channel: 2, program: 29, notes: low(0, 3) }, { channel: 3, program: 73, notes: eighths(76, 8) }, drums]), ID);
    expect(none.tracks.filter((t) => t.role === 'bass')).toHaveLength(2);
  });
  it('never takes a part the file calls the bass for a singer', () => {
    const low: [number, number, number][] = Array.from({ length: 32 }, (_, i) => [40 + (i % 2) * 3, i / 2, 0.4]);
    const song = songFromMidi(build([{ channel: 0, program: 52, name: 'Bass', notes: low }, { channel: 1, program: 73, notes: eighths(76, 8) }, drums]), ID);
    const bass = song.tracks.find((t) => t.name === 'Bass')!;
    expect(bass.role).toBe('bass');
    expect(bass.vocal).toBeUndefined();
    expect(compile(song)).toContain('// bass · "Bass" · choir aahs in the file (a voice patch in the bass register), played on gm_synth_bass_1, never a voice');
  });
  it('takes a busy line on a voice patch in the bass register for the bass, not the singer, and keeps the real tune', () => {
    // Terra Promessa: "lead 6 voice" playing eighths at C1-A#1 (688 notes) under an e-piano tune; Enjoy the Silence: a synth choir playing eighths at C#1-F#2.
    const bassLine = (root: number, bars: number): [number, number, number][] => Array.from({ length: bars * 8 }, (_, i) => [root + [0, 0, 7, 0, 5, 5, 7, 3][i % 8], i / 2, 0.45]);
    const tune = (root: number, bars: number): [number, number, number][] => Array.from({ length: bars * 4 }, (_, i) => [root + [0, 2, 4, 7, 9, 7, 4, 2][i % 8], i, 0.9]);
    for (const program of [85, 54, 52]) {
      const song = songFromMidi(build([{ channel: 1, program, notes: bassLine(29, 24) }, { channel: 2, program: 4, notes: tune(72, 24) }, drums]), ID);
      const low = song.tracks.find((t) => t.program === program)!;
      expect(low.role, `program ${program}`).toBe('bass');
      expect(low.vocal).toBeUndefined();
      expect(song.tracks.find((t) => t.program === 4)!.role).toBe('melody');
      const code = compile(song);
      expect(code).toContain(`// bass · ${gmLabel(program)} in the file (a voice patch in the bass register), played on gm_synth_bass_1, never a voice`);
      expect(code).toContain('// melody · gm_epiano1 · instrumental lead, keeps its own instrument');
      expect(code).not.toMatch(/gm_(lead_6_voice|synth_choir|choir_aahs)/);
    }
    // A choir holding a low pedal in whole notes is a pedal, not a bass, and not the singer either; and the same choir singing the tune in range is the singer.
    const pedal = songFromMidi(build([{ channel: 1, program: 52, notes: Array.from({ length: 24 }, (_, b) => [29, b * 4, 4] as [number, number, number]) }, { channel: 2, program: 4, notes: tune(72, 24) }, drums]), ID);
    expect(pedal.tracks.find((t) => t.program === 52)).toMatchObject({ role: 'other', vocal: true });
    expect(pedal.tracks.find((t) => t.program === 4)!.role).toBe('melody');
    const singer = songFromMidi(build([{ channel: 1, program: 52, notes: bassLine(65, 24) }, { channel: 2, program: 4, notes: tune(72, 24) }, drums]), ID);
    expect(singer.tracks.find((t) => t.program === 52)).toMatchObject({ role: 'melody', vocal: true });
  });
  it('keeps the melody sound for a singer\'s channel that changes patch per section, and the patches for an instrumental lead that does', () => {
    // A channel that plays a piano tune for the verse and a guitar tune for the chorus is a lead in sections, not a singer; the same layout on a flute and a sax is the singer.
    const tune = (root: number, n: number, from: number): [number, number, number][] => Array.from({ length: n }, (_, i) => [root + [0, 2, 4, 7, 9, 7, 4, 2][i % 8], from + i / 2, 0.45]);
    const chords = Array.from({ length: 32 }, (_, b) => [[48, b * 2, 2], [52, b * 2, 2], [55, b * 2, 2]] as [number, number, number][]).flat();
    const layout = (verse: number, chorus: number) => {
      const lead = [{ tick: 0, bytes: [0xc3, verse] }, { tick: 16 * PPQ, bytes: [0xc3, chorus] }];
      for (const [pitch, start, dur] of tune(67, 32, 0).concat(tune(69, 32, 16))) lead.push(...rawNote(3, pitch, start, dur));
      const pad: { tick: number; bytes: number[] }[] = [{ tick: 0, bytes: [0xc0, 89] }];
      for (const [pitch, start, dur] of chords) pad.push(...rawNote(0, pitch, start, dur));
      const kit: { tick: number; bytes: number[] }[] = [];
      for (const [pitch, start, dur] of drums.notes) kit.push(...rawNote(9, pitch, start, dur));
      return songFromMidi(smf([lead, pad, kit]), ID);
    };
    const instrumental = layout(0, 27);
    const sections = instrumental.tracks.filter((t) => t.channel === 3);
    expect(sections.map((t) => [t.program, t.role, t.sungLine, t.vocal])).toEqual([[0, 'melody', true, undefined], [27, 'melody', true, undefined]]);
    const code = compile(instrumental);
    expect(code).toContain('// melody · gm_piano · instrumental lead, one section of a lead whose channel changes patch per section, keeps its own instrument');
    expect(code).toContain('// melody · gm_electric_guitar_clean · instrumental lead, one section of a lead whose channel changes patch per section, keeps its own instrument');
    expect(code).not.toMatch(/sung line|gm_lead_2_sawtooth/);
    const sung = layout(73, 65);
    expect(sung.tracks.filter((t) => t.channel === 3).map((t) => [t.program, t.role, t.sungLine, t.vocal])).toEqual([[73, 'melody', true, true], [65, 'melody', true, true]]);
    expect(compile(sung)).not.toMatch(/gm_(flute|alto_sax)/);
    expect(compile(sung)).not.toContain('gm_lead_2_sawtooth');
  });
  it('leaves a part nameless when its track name is a credit, not a part', () => {
    for (const name of ['Tracked by [Unknown]', 'Updated alot by RazTor (cns@post7.tele.dk)', 'Visit The Midi Planet', '"Come as you are" by Nirvana', 'www.midi.com', 'Sequenced by J. Smith', '(c) 1997', 'Arranged for GM']) {
      expect(isCreditName(name), name).toBe(true);
      expect(partName(name), name).toBe('');
    }
    for (const name of ['Guitar', 'Lead Vocal', 'Bass', 'Midi C4, T3', 'Rhythm Guitar 2', 'Byron Sax', 'Stand By Me', 'Walk On By', 'Visitor', 'Tracker', 'Killer Bass', 'Melody', 'File']) expect(isCreditName(name), name).toBe(false);
    for (const name of ['Sequenced by:', 'by JC', 'made MIDI by Chris Howe', 'MIDIfied by Chris Howe', 'File created by', 'Rhythm generated by', 'karaoke by', "of Chris's MIDI Project", 'ID: WWST-0012', 'Visit my Website', 'Visit MIDI MANIA!', '"Jackie\'s Strength" by', 'Copyright � by WWST',
      'All comments welcome to', 'Comments please!', 'Hi to Asrai, Matt, Nadyne', 'Thanks to Matt and', 'WinJammer Demo', 'Feedback', 'From The Album', 'Not For Sale or Reproduction', 'Words & Music:', 'If You Need More Midi', 'Come and get more', 'CAROLINA IN MY MI 2', 'B. Andersson / B. Ulvaeus', 'improved version', 'corrections :', 'unknow artist', 'Homepage:']) expect(isCreditName(name), name).toBe(true);
    // Four words are a sentence only without a part word: these are parts.
    for (const name of ['Electric Guitar (Distortion) Rhythm', 'Drums - Hi Hat/Cymbals', 'Left Hand Piano Part', 'Kurt Cobain -Clean Guitar-', 'Rhthym Guitar Clean & Dist', 'Chris Novoselic -Bass-', 'Hi-Hat', 'Water Song']) expect(isCreditName(name), name).toBe(false);
    expect(partName('  Guitar ')).toBe('Guitar');
    // No letters, nothing to call the part by: a channel number, a row of dashes, a date.
    for (const name of ['34', '-----------', '9/6/98 - 14/6/98', '"', '*\u0000*', '   ']) expect(partName(name), JSON.stringify(name)).toBe('');
    expect(partName('Гитара')).toBe('Гитара');
    // Given the song, its title, its artist, both, or "by" the artist name the song rather than a part.
    const swirl = { title: 'Raspberry Swirl', artist: 'Tori Amos' };
    for (const name of ['Raspberry Swirl', '"RASPBERRY SWIRL"', 'Tori Amos', 'Raspberry Swirl - Tori Amos', 'Tori Amos-Raspberry Swirl', '"Raspberry Swirl" by Tori Amos', 'Rasperry Swirl by Tori', 'by Tori Amos']) {
      expect(isCreditName(name, swirl), name).toBe(true);
      expect(partName(name, swirl), name).toBe('');
    }
    for (const name of ['Piano', 'Swirl', 'Stand By Me', 'Tori', 'Amos Sax']) expect(isCreditName(name, swirl), name).toBe(false);
    expect(isCreditName('TORI MIDI!!!!', swirl)).toBe(true);
    expect(isCreditName('MIDI Piano', swirl)).toBe(false);
    // A short title or artist matches only as whole words.
    expect(isCreditName('a guitar', { title: 'T', artist: 'A' })).toBe(false);
    expect(isCreditName('A', { title: 'T', artist: 'A' })).toBe(true);
    const titled = songFromMidi(build([{ channel: 0, program: 0, name: 'Bohemian Rhapsody', notes: eighths(60, 8) }, { channel: 1, program: 33, name: 'Queen', notes: eighths(40, 8) }, drums]), { id: 'q', title: 'Bohemian Rhapsody', artist: 'Queen' });
    expect(titled.tracks.map((t) => t.name)).toEqual(['', '', '']);
    expect(compile(titled)).not.toMatch(/const bohemian|const queen|"Bohemian Rhapsody" ·|"Queen" ·/);
    const triads = Array.from({ length: 16 }, (_, b) => [[52, b * 2, 2], [55, b * 2, 2], [59, b * 2, 2]] as [number, number, number][]).flat();
    const song = songFromMidi(build([
      { channel: 0, program: 27, name: 'Updated alot by RazTor (cns@post7.tele.dk)', notes: triads },
      { channel: 1, program: 33, name: 'Visit The Midi Planet', notes: [[40, 0, 4], [40, 4, 4], [40, 8, 4], [40, 12, 4], [43, 16, 4], [43, 20, 4], [40, 24, 4], [40, 28, 4]] },
      { channel: 2, program: 67, name: 'Tracked by [Unknown]', notes: eighths(64, 8) },
      drums,
    ]), ID);
    expect(song.tracks.map((t) => t.name)).toEqual(['', '', '', '']);
    const code = compile(song);
    expect(code).toContain('const electric_guitar_clean = ');
    expect(code).toContain('// chords · gm_electric_guitar_clean · gain');
    expect(code).toContain('stack(melody, bass, electric_guitar_clean, drums)');
    expect(code).not.toMatch(/raztor|midi_planet|tracked/i);
  });
  it('drops duplicate parts (same notes on another channel or patch)', () => {
    const line = eighths(64, 4);
    const song = songFromMidi(build([
      { channel: 0, program: 27, notes: line, cc: [{ number: 7, beat: 0, value: 60 }] },
      { channel: 1, program: 30, notes: line, cc: [{ number: 7, beat: 0, value: 110 }] },
      { channel: 2, program: 33, notes: [[40, 0, 4], [40, 4, 4]] },
    ]), ID);
    const pitched = song.tracks.filter((t) => t.role !== 'drums');
    expect(pitched).toHaveLength(2);
    expect(pitched.find((t) => t.program === 30)).toBeDefined(); // the louder copy survives
    // Of two copies of a low line, the one on a bass patch is kept however loud the guitar double; of a tune, the other patch.
    const low: [number, number, number][] = Array.from({ length: 32 }, (_, i) => [38 + (i % 2) * 3, i / 2, 0.4]);
    const doubled = songFromMidi(build([
      { channel: 0, program: 29, notes: low, cc: [{ number: 7, beat: 0, value: 120 }] },
      { channel: 1, program: 34, notes: low, cc: [{ number: 7, beat: 0, value: 70 }] },
      { channel: 2, program: 0, notes: eighths(72, 4) },
    ]), ID);
    expect(doubled.tracks.filter((t) => t.role !== 'drums').map((t) => t.program).sort((a, b) => a - b)).toEqual([0, 34]);
    expect(doubled.meta.remarks).toContain('duplicate parts dropped: ch 1 overdriven guitar (copy of ch 2 electric bass pick)');
    const high = songFromMidi(build([
      { channel: 0, program: 34, notes: eighths(72, 4), cc: [{ number: 7, beat: 0, value: 120 }] },
      { channel: 1, program: 73, notes: eighths(72, 4), cc: [{ number: 7, beat: 0, value: 70 }] },
    ]), ID);
    expect(high.tracks.map((t) => t.program)).toEqual([73]);
    // dedupeParts itself takes the preference as a hook.
    const a = { notes: line.map(([pitch, start, duration]) => ({ pitch, start, duration, velocity: 0.8 })), volume: 1, tag: 'a' };
    const b = { notes: line.map(([pitch, start, duration]) => ({ pitch, start, duration, velocity: 0.8 })), volume: 0.5, tag: 'b' };
    expect(dedupeParts([a, b]).map((p) => p.tag)).toEqual(['a']);
    expect(dedupeParts([a, b], { prefer: () => b }).map((p) => p.tag)).toEqual(['b']);
  });
  it('drops stray events left long after the song ends, and says so', () => {
    const song = songFromMidi(build([
      { channel: 0, program: 0, notes: eighths(60, 8) },
      { channel: 9, notes: [[36, 0, 0.25], [38, 2, 0.25], [36, 60, 20, 0.05], [42, 300, 30, 0.02], [36, 600, 1, 0.1]] },
    ]), ID);
    // The two hits spread over 130 bars are litter; the one 15 bars after the end could be a sting and stays.
    expect(song.tracks.find((t) => t.role === 'drums')!.notes).toHaveLength(3);
    expect(song.meta.remarks).toContain('2 stray notes after a silence of more than 6 bars (from bar 76) are dropped');
    expect(barRange(song)!.totalBars).toBe(20); // the 20-beat hit at beat 60 ends in bar 20
    // A drum outro a few bars after the last pitched note is not stray.
    const outro = songFromMidi(build([{ channel: 0, program: 0, notes: eighths(60, 8) }, { channel: 9, notes: [[36, 0, 0.25], [36, 44, 0.25], [38, 46, 0.25]] }]), ID);
    expect(outro.tracks.find((t) => t.role === 'drums')!.notes).toHaveLength(3);
    expect(outro.meta.remarks?.some((r) => r.includes('stray')) ?? false).toBe(false);
    const n = (start: number): NoteEvent => ({ pitch: 60, start, duration: 1, velocity: 1 });
    const parts = [{ notes: [n(0), n(1), n(2), n(3), n(4), n(5), n(6), n(7), n(100), n(200), n(210), n(300)] }];
    expect(dropTrailingStrays(parts, 4)).toEqual({ dropped: 4, atBeat: 100 });
    expect(parts[0].notes).toHaveLength(8);
    // A short sting after a pause (a few notes within a few bars) is kept.
    const sting = [{ notes: [n(0), n(1), n(2), n(3), n(4), n(5), n(6), n(7), n(40), n(41), n(44)] }];
    expect(dropTrailingStrays(sting, 4)).toEqual({ dropped: 0, atBeat: 0 });
    // A coda after a long silence keeps a song-like density and survives.
    const coda = [{ notes: Array.from({ length: 64 }, (_, i) => n(i / 2)).concat(Array.from({ length: 32 }, (_, i) => n(80 + i / 2))) }];
    expect(dropTrailingStrays(coda, 4)).toEqual({ dropped: 0, atBeat: 0 });
  });
  it('folds a few stray notes on a spare channel into the part of the same instrument', () => {
    const song = songFromMidi(build([
      { channel: 0, program: 30, notes: eighths(52, 4) }, // low rhythm guitar
      { channel: 1, program: 30, notes: eighths(76, 4) }, // high lead guitar
      { channel: 2, program: 30, notes: [[74, 16, 1], [76, 17, 1], [79, 18, 1]] }, // a lick left on its own channel
      { channel: 3, program: 71, notes: [[70, 16, 1], [72, 17, 1]] }, // a clarinet with no part of its own: kept
    ]), ID);
    const guitars = song.tracks.filter((t) => t.program === 30);
    expect(guitars).toHaveLength(2);
    expect(guitars.find((t) => t.channel === 1)!.notes).toHaveLength(35);
    expect(guitars.find((t) => t.channel === 0)!.notes).toHaveLength(32);
    expect(song.tracks.find((t) => t.program === 71)!.notes).toHaveLength(2);
  });
});

describe('songFromMidi tempo and metre', () => {
  it('renders at the dominant tempo, keeps note timing in real time and says so', () => {
    const data = build([{ channel: 0, program: 0, notes: eighths(60, 8) }], (m) => {
      m.header.tempos = [{ ticks: 0, bpm: 100 }, { ticks: 8 * PPQ, bpm: 140 }, { ticks: 12 * PPQ, bpm: 100 }];
      m.header.update();
    });
    const song = songFromMidi(data, ID);
    expect(song.meta.bpm).toBe(100);
    // The one bar at 140 bpm takes 2.857 grid beats; the five 100 bpm bars after it outvote the two before, so bar 0 is phased to them.
    expect(song.meta.barOffset).toBeCloseTo(2.857 - 4, 3);
    expect(song.meta.remarks?.some((r) => r.startsWith('tempo changes (100 bpm at bar 1, 140 bpm at bar 3, 100 bpm at bar 4) are rendered at the dominant 100 bpm with note timing kept in real time'))).toBe(true);
    expect(song.meta.remarks?.some((r) => r.includes('exactly'))).toBe(false); // 140/100 is not a grid ratio
  });
  it('phases the bars to the song after a one-bar count-in at another tempo, squeezed onto the cell grid', () => {
    // One 4/4 bar at 200 bpm (2.28 beats of the 114 bpm grid, squeezed to 2.25), then the song at 114 bpm.
    const bassLine: [number, number, number][] = [];
    for (let b = 1; b <= 8; b++) for (let i = 0; i < 4; i++) bassLine.push([38, b * 4 + i, 0.9]);
    const data = build([
      { channel: 9, notes: [[42, 0, 0.25], [42, 1, 0.25], [42, 2, 0.25], [42, 3, 0.25]] }, // the count-in
      { channel: 0, program: 33, notes: bassLine },
      { channel: 1, program: 0, notes: eighths(64, 8, 4) },
    ], (m) => { m.header.tempos = [{ ticks: 0, bpm: 200 }, { ticks: 4 * PPQ, bpm: 114 }]; m.header.update(); });
    const song = songFromMidi(data, ID);
    expect(song.meta.bpm).toBe(114);
    expect(song.meta.barOffset).toBe(2.25 - 4);
    expect(song.meta.remarks).toContain('the 1 bar at 200 bpm before the 114 bpm section is squeezed by 1.3% so the section\'s first downbeat lands on the cell grid');
    expect(song.meta.remarks?.some((r) => r.startsWith('tempo changes (200 bpm at bar 1, 114 bpm at bar 2)'))).toBe(true);
    // Every downbeat of the song lands on cell 0 of its bar, and the count-in fits the cells of bar 0.
    const bass = song.tracks.find((t) => t.program === 33)!;
    for (let b = 0; b < 8; b++) expect(barIndex(song.meta, bass.notes[b * 4].start)).toBe(b + 1);
    const code = compile(song);
    expect(code).toContain('const bass = note("<~ [d2@4 d2@4 d2@4 d2@4]!8>")');
    expect(code).toContain('const melody = note("<~ [e4@2 e4@2 e4@2 e4@2 e4@2 e4@2 e4@2 e4@2]!8>")');
    expect(code).toMatch(/const drums = s\("<\[~@7 hh [^\]]+\] ~!8>"\)/); // the count-in sits in bar 0, before the song's first downbeat
    expect(barRange(song)).toMatchObject({ firstBar: 0, nBars: 9, totalBars: 9 });
    expect(beatMap([{ ticks: 0, bpm: 200 }, { ticks: 4 * PPQ, bpm: 114 }], 114, PPQ, 4)[1].beat).toBe(2.25);
    expect(beatMap([{ ticks: 0, bpm: 200 }, { ticks: 4 * PPQ, bpm: 114 }], 114, PPQ, 4)[0].squeezed).toBeCloseTo(2.25 / 2.28, 3);
    // Without the bar length there is no squeeze, and a prefix that already ends on a cell is left alone.
    expect(beatMap([{ ticks: 0, bpm: 200 }, { ticks: 4 * PPQ, bpm: 114 }], 114, PPQ)[0].squeezed).toBeUndefined();
    expect(beatMap([{ ticks: 0, bpm: 120 }, { ticks: 4 * PPQ, bpm: 60 }], 60, PPQ, 4)[0].squeezed).toBeUndefined();
  });
  it('gives a section at twice the tempo half the bars, so the song lasts as long as the file', () => {
    // 8 bars at 100 bpm (19.2 s) then 4 bars at 200 bpm (4.8 s): 24 s = 10 bars of the 100 bpm grid.
    const data = build([{ channel: 0, program: 0, notes: eighths(60, 12) }, { channel: 1, program: 33, notes: Array.from({ length: 12 }, (_, b) => [36, b * 4, 4] as [number, number, number]) }], (m) => {
      m.header.tempos = [{ ticks: 0, bpm: 100 }, { ticks: 32 * PPQ, bpm: 200 }];
      m.header.update();
    });
    const song = songFromMidi(data, ID);
    expect(song.meta.bpm).toBe(100);
    expect(barRange(song)).toMatchObject({ firstBar: 0, nBars: 10, totalBars: 10 });
    const piano = song.tracks.find((t) => t.program === 0)!;
    expect(piano.notes[64].start).toBeCloseTo(32); // the fast section starts on beat 32
    expect(piano.notes[65].start).toBeCloseTo(32.25); // its eighths are sixteenths on the grid
    expect(piano.notes[64].duration).toBeCloseTo(0.2);
    const code = compile(song);
    expect(code).toContain('const melody = note("<[c4@2 c4@2 c4@2 c4@2 c4@2 c4@2 c4@2 c4@2]!8 [c4 c4 c4 c4 c4 c4 c4 c4 c4 c4 c4 c4 c4 c4 c4 c4]!2>")');
    expect(code).toContain('const bass = note("<c2!8 [c2@8 c2@8]!2>")');
    expect(code).toContain('// note: tempo changes (100 bpm at bar 1, 200 bpm at bar 9) are rendered at the dominant 100 bpm');
  });
  it('ignores tempo stretches shorter than a bar when naming the tempo', () => {
    // A 2-tick default tempo before the real one, and a ritardando in the last bar.
    const data = build([{ channel: 0, program: 0, notes: eighths(60, 8) }], (m) => {
      m.header.tempos = [{ ticks: 0, bpm: 120 }, { ticks: 2, bpm: 100 }, { ticks: 30 * PPQ, bpm: 96 }, { ticks: 31 * PPQ, bpm: 90 }];
      m.header.update();
    });
    const song = songFromMidi(data, ID);
    expect(song.meta.bpm).toBe(100);
    expect(song.meta.remarks?.some((r) => r.startsWith('tempo changes')) ?? false).toBe(false);
  });
  it('lines the bars up after a pickup bar in another metre', () => {
    // 2/4 pickup (2 beats), then 4/4.
    const data = build([{ channel: 0, program: 0, notes: [[60, 0, 1], [62, 1, 1], ...eighths(64, 4, 2)] }], (m) => {
      m.header.timeSignatures = [{ ticks: 0, timeSignature: [2, 4] }, { ticks: 2 * PPQ, timeSignature: [4, 4] }];
    });
    const song = songFromMidi(data, ID);
    expect(song.meta.beatsPerBar).toBe(4);
    expect(song.meta.barOffset).toBe(-2);
    expect(barStart(song.meta, 1)).toBe(2);
    expect(barIndex(song.meta, 2)).toBe(1);
    expect(barIndex(song.meta, 0)).toBe(0);
    expect(song.meta.remarks?.some((r) => r.startsWith('metre changes (2/4 at bar 1, 4/4 at bar 2)'))).toBe(true);
    // The 4/4 bars after the pickup are identical, so they collapse.
    const code = compile(song);
    expect(code).toContain('<[~@8 c4@4 d4@4] [e4@2 e4@2 e4@2 e4@2 e4@2 e4@2 e4@2 e4@2]!4>');
  });
});

describe('helpers', () => {
  it('applySustain stops at the next strike of the same pitch and at the cap', () => {
    const notes: NoteEvent[] = [
      { pitch: 60, start: 0, duration: 0.5, velocity: 1 },
      { pitch: 60, start: 1, duration: 0.5, velocity: 1 },
      { pitch: 64, start: 1, duration: 0.5, velocity: 1 },
    ];
    applySustain(notes, [{ beat: 0, down: true }], 3);
    expect(notes[0].duration).toBe(1); // re-struck at beat 1
    expect(notes[1].duration).toBe(3); // capped
    expect(notes[2].duration).toBe(3);
  });
  it('dedupeParts keeps distinct parts and tolerates a few stray notes', () => {
    const base = eighths(60, 4).map(([pitch, start, duration]) => ({ pitch, start, duration, velocity: 0.8 }));
    const nearCopy = base.slice(0, 30).concat([{ pitch: 72, start: 15.5, duration: 0.4, velocity: 0.8 }]);
    const other = base.map((n) => ({ ...n, pitch: 67 }));
    const out = dedupeParts([{ notes: base }, { notes: nearCopy }, { notes: other }]);
    expect(out).toHaveLength(2);
    expect(out[0].notes).toBe(base);
    expect(out[1].notes).toBe(other);
  });
  it('dedupeParts matches copies offset by a few ticks and compares tiny parts too', () => {
    const base = eighths(60, 4).map(([pitch, start, duration]) => ({ pitch, start, duration, velocity: 0.8 }));
    const shifted = base.map((n) => ({ ...n, start: n.start + 0.04 })); // 20 ticks at 480 ppq
    expect(dedupeParts([{ notes: base }, { notes: shifted }])).toHaveLength(1);
    const tiny = [{ pitch: 53, start: 100, duration: 1, velocity: 0.3 }, { pitch: 53, start: 101, duration: 1, velocity: 0.3 }, { pitch: 61, start: 102, duration: 1, velocity: 0.3 }];
    expect(dedupeParts([{ notes: tiny }, { notes: tiny.map((n) => ({ ...n })) }])).toHaveLength(1);
    const late = base.map((n) => ({ ...n, start: n.start + 0.25 })); // a sixteenth-note echo is a different part by default ...
    expect(dedupeParts([{ notes: base }, { notes: late }])).toHaveLength(2);
    expect(dedupeParts([{ notes: base }, { notes: late }], { maxOffset: 0.5 })).toHaveLength(1); // ... unless delayed doubles are allowed
  });
  it('matchParts finds the constant delay between two copies', () => {
    const a = Array.from({ length: 20 }, (_, i) => ({ pitch: 60 + (i % 5), at: i }));
    const b = a.map((n) => ({ ...n, at: n.at + 0.25 }));
    expect(matchParts(a, b, 0.5)).toEqual({ shared: 20, offset: 0.25 });
    expect(matchParts(a, b, 0.2)).toEqual({ shared: 0, offset: 0 });
    expect(matchParts(a, a.map((n) => ({ ...n, at: n.at + 0.03 })), 0.5)).toEqual({ shared: 20, offset: 0 }); // within a 64th: no delay
    expect(matchParts(a, a.map((n) => ({ ...n, pitch: n.pitch + 1 })), 0.5)).toEqual({ shared: 0, offset: 0 });
  });
  it('foldStubs keeps the host order and stubs without a host', () => {
    const n = (pitch: number, start: number): NoteEvent => ({ pitch, start, duration: 1, velocity: 0.8 });
    const host = { program: 0, notes: Array.from({ length: 10 }, (_, i) => n(60, i)), ticks: Array.from({ length: 10 }, (_, i) => i * 480) };
    const stub = { program: 0, notes: [n(64, 4.5)], ticks: [4.5 * 480] };
    const alone = { program: 40, notes: [n(70, 2)], ticks: [960] };
    const out = foldStubs([host, stub, alone]);
    expect(out).toEqual([host, alone]);
    expect(host.notes.map((x) => x.start)).toEqual([0, 1, 2, 3, 4, 4.5, 5, 6, 7, 8, 9]);
    expect(host.ticks[5]).toBe(4.5 * 480);
  });
});

describe('songFromMidi doubled leads, delayed doubles and split channels', () => {
  const drums = { channel: 9, notes: [[36, 0, 0.25], [38, 1, 0.25], [36, 2, 0.25], [38, 3, 0.25]] as [number, number, number][] };
  /** A tune of `n` eighths on a pentatonic figure from `root`. */
  const tune = (root: number, n: number, from = 0): [number, number, number][] =>
    Array.from({ length: n }, (_, i) => [root + [0, 2, 4, 7, 9, 7, 4, 2][i % 8], from + i / 2, 0.45]);
  it('treats a lead doubled in octaves as the melody, not as chords', () => {
    const line = tune(67, 64);
    const octaves = line.flatMap(([p, s, d]) => [[p, s, d], [p - 12, s, d]] as [number, number, number][]);
    const triads = Array.from({ length: 16 }, (_, b) => [[48, b * 2, 2], [52, b * 2, 2], [55, b * 2, 2]] as [number, number, number][]).flat();
    const song = songFromMidi(build([{ channel: 0, program: 75, notes: octaves }, { channel: 1, program: 0, notes: triads }, drums]), ID);
    expect(song.tracks.find((t) => t.program === 75)!.role).toBe('melody');
    expect(song.tracks.find((t) => t.program === 0)!.role).toBe('chords');
    expect(compile(song)).toMatch(/const melody = note\("<\[\[g3,g4\]/); // the octave is kept
    // Real double-stops (thirds and sixths) still count as harmony.
    const thirds = line.flatMap(([p, s, d]) => [[p, s, d], [p - 4, s, d]] as [number, number, number][]);
    const dyads = songFromMidi(build([{ channel: 0, program: 26, notes: thirds }, drums]), ID);
    expect(dyads.tracks.find((t) => t.program === 26)!.role).toBe('chords');
  });
  it('drops a copy delayed by 200 ms at a slow tempo, says so, and the melody toggle then silences the whole line', () => {
    const line = tune(64, 96);
    const late = line.map(([p, s, d]) => [p, s + 0.26, d] as [number, number, number]); // 0.26 beats = 200 ms at 78 bpm
    const data = build([
      { channel: 0, program: 30, notes: line, cc: [{ number: 10, beat: 0, value: 127 }] },
      { channel: 1, program: 30, notes: late, cc: [{ number: 10, beat: 0, value: 0 }] },
      { channel: 2, program: 33, notes: Array.from({ length: 12 }, (_, b) => [40, b * 4, 4] as [number, number, number]) },
      drums,
    ], (m) => { m.header.tempos = [{ ticks: 0, bpm: 78 }]; m.header.update(); });
    const song = songFromMidi(data, ID);
    const guitars = song.tracks.filter((t) => t.program === 30);
    expect(guitars).toHaveLength(1);
    expect(guitars[0]).toMatchObject({ channel: 0, role: 'melody' });
    expect(song.meta.remarks).toContain('duplicate parts dropped: ch 2 distortion guitar (copy of ch 1 distortion guitar, 0.26 beats late)');
    expect(compile(song, { melody: false })).not.toContain('gm_distortion_guitar');
    // A copy a full beat late (a real echo part) is not a double.
    const echo = songFromMidi(build([{ channel: 0, program: 30, notes: line }, { channel: 1, program: 30, notes: line.map(([p, s, d]) => [p, s + 1, d] as [number, number, number]) }, drums]), ID);
    expect(echo.tracks.filter((t) => t.program === 30)).toHaveLength(2);
  });
  it('measures a double\'s delay on the file clock, so an eighth stays an eighth through a tempo change', () => {
    // 8 bars at 78 bpm then 8 bars at 156 bpm; the copy is always half a file beat late (385 then 192 ms).
    const line = tune(64, 128);
    const late = line.map(([p, s, d]) => [p, s + 0.5, d] as [number, number, number]);
    const data = build([{ channel: 0, program: 30, notes: line }, { channel: 1, program: 30, notes: late }, drums], (m) => {
      m.header.tempos = [{ ticks: 0, bpm: 78 }, { ticks: 32 * PPQ, bpm: 156 }];
      m.header.update();
    });
    const song = songFromMidi(data, ID);
    expect(song.tracks.filter((t) => t.program === 30)).toHaveLength(1);
    expect(song.meta.remarks?.some((r) => r.includes('0.5 beats late'))).toBe(true);
  });
  it('gives the melody to a channel whose singer changes patch per section, and renders every part of it', () => {
    // The singer's channel: pan flute, then alto sax, then shakuhachi, each section too short to beat the piano riff on its own.
    const riff: [number, number, number][] = [];
    for (let i = 0; i < 96; i++) riff.push([60 + [0, 4, 7, 11][i % 4], i / 2, 0.4]);
    const track = [{ tick: 0, bytes: [0xc3, 75] }, { tick: 16 * PPQ, bytes: [0xc3, 65] }, { tick: 32 * PPQ, bytes: [0xc3, 77] }];
    for (const [pitch, start, dur] of tune(67, 32).concat(tune(67, 32, 16), tune(69, 32, 32))) track.push(...rawNote(3, pitch, start, dur));
    const piano: { tick: number; bytes: number[] }[] = [{ tick: 0, bytes: [0xc0, 0] }];
    for (const [pitch, start, dur] of riff) piano.push(...rawNote(0, pitch, start, dur));
    const kit: { tick: number; bytes: number[] }[] = [];
    for (const [pitch, start, dur] of drums.notes) kit.push(...rawNote(9, pitch, start, dur));
    const song = songFromMidi(smf([track, piano, kit]), ID);
    const singer = song.tracks.filter((t) => t.channel === 3);
    expect(singer.map((t) => [t.program, t.role])).toEqual([[75, 'melody'], [65, 'melody'], [77, 'melody']]);
    expect(singer.every((t) => t.sungLine)).toBe(true);
    expect(song.tracks.find((t) => t.program === 0)!.role).toBe('other');
    expect(selectTracks(song, 3, true).map((t) => t.program)).toEqual([0]); // only the instrumental part
    const code = compile(song);
    expect(code).not.toContain('const melody = ');
    expect(code).not.toContain('const melody_2 = ');
    expect(code).not.toContain('const melody_3 = ');
    expect(compile(song, { melody: false })).not.toMatch(/gm_(pan_flute|alto_sax|shakuhachi)/);
    // Parts of one channel that play together (a keyboard split) are not a singer.
    const together = songFromMidi(build([{ channel: 0, program: 75, notes: tune(67, 32) }, { channel: 0, program: 65, notes: tune(72, 32).map(([p, s, d]) => [p, s + 0.25, d] as [number, number, number]) }, { channel: 1, program: 0, notes: riff }, drums]), ID);
    expect(together.tracks.filter((t) => t.role === 'melody')).toHaveLength(1);
  });
  it('labels a low line as bass on any patch but a pad or string section, and plays it on a bass sound', () => {
    const drone = Array.from({ length: 64 }, (_, i) => [38 + (i % 3), i, 1] as [number, number, number]); // E2-F#2 string pedal
    const low = Array.from({ length: 64 }, (_, i) => [31 + [0, 0, 7, 5][i % 4], i / 2, 0.4] as [number, number, number]); // G1-D2 on a "soprano sax"
    const song = songFromMidi(build([{ channel: 0, program: 48, notes: drone }, { channel: 1, program: 64, notes: low }, { channel: 2, program: 73, notes: tune(72, 64) }, drums]), ID);
    expect(song.tracks.find((t) => t.program === 48)!.role).toBe('other');
    expect(song.tracks.find((t) => t.program === 64)!.role).toBe('bass');
    const code = compile(song);
    expect(code).toContain('// bass · soprano sax in the file, played on gm_electric_bass_finger · gain');
    expect(code).toMatch(/const bass = note\("[^"]+"\)\n {2}\.s\("gm_electric_bass_finger"\)/);
    expect(code).not.toContain('gm_soprano_sax');
  });
});

describe('beatMap', () => {
  it('snaps a tempo within 5% of a simple ratio and keeps the others in real time', () => {
    const map = beatMap([{ ticks: 0, bpm: 78 }, { ticks: 960, bpm: 154 }, { ticks: 1920, bpm: 100 }], 78, 480);
    expect(map).toEqual([
      { ticks: 0, beat: 0, ratio: 1, bpm: 78, snapped: false },
      { ticks: 960, beat: 2, ratio: 0.5, bpm: 154, snapped: true },
      { ticks: 1920, beat: 3, ratio: 0.78, bpm: 100, snapped: false },
    ]);
    expect(beatAt(map, 1440, 480)).toBe(2.5);
    expect(beatAt(map, 2400, 480)).toBeCloseTo(3.78);
    expect(beatMap([], 120, 480)).toEqual([{ ticks: 0, beat: 0, ratio: 1, bpm: 120, snapped: false }]);
    expect(beatMap([{ ticks: 0, bpm: 60 }, { ticks: 0, bpm: 120 }], 120, 480)[0].bpm).toBe(120); // the later event at a tick wins
  });
  it('keeps a near-double-tempo section on the cell grid and says so', () => {
    // 8 bars at 100 bpm, then 4 bars at 197 bpm: rendered as exactly 2x (200 bpm), 1.5% fast.
    const data = build([{ channel: 0, program: 0, notes: eighths(60, 12) }], (m) => {
      m.header.tempos = [{ ticks: 0, bpm: 100 }, { ticks: 32 * PPQ, bpm: 197 }];
      m.header.update();
    });
    const song = songFromMidi(data, ID);
    const piano = song.tracks[0];
    expect(piano.notes[64].start).toBe(32);
    expect(piano.notes[95].start).toBe(32 + 31 * 0.25); // every fast eighth lands on a sixteenth cell
    expect(song.meta.remarks).toContain('tempo changes (100 bpm at bar 1, 197 bpm at bar 9) are rendered at the dominant 100 bpm with note timing kept in real time, so the other sections are stretched across the grid; 197 bpm plays as exactly 2x the dominant tempo (200 bpm) so its bars stay on the grid');
    expect(compile(song)).toContain('[c4 c4 c4 c4 c4 c4 c4 c4 c4 c4 c4 c4 c4 c4 c4 c4]!2>');
  });
});
