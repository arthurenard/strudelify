/** Raw Standard MIDI Files for tests: the events @tonejs/midi cannot write (mid-track program changes, key signatures, SMPTE timing). */

export const PPQ = 480;

export interface RawEvent { tick: number; bytes: number[] }

/** Variable-length quantity. */
export function vlq(n: number): number[] {
  const out = [n & 0x7f];
  n >>= 7;
  while (n > 0) { out.unshift((n & 0x7f) | 0x80); n >>= 7; }
  return out;
}

/**
 * Raw Standard MIDI File, format 1, from tracks given as absolute-tick events (`bytes` without
 * delta). `division` is the header's time division: ticks per quarter note, or the two SMPTE bytes.
 */
export function smf(tracks: RawEvent[][], division: [number, number] = [PPQ >> 8, PPQ & 255]): Uint8Array {
  const chunk = (id: string, body: number[]) => [...id].map((c) => c.charCodeAt(0)).concat([body.length >>> 24, (body.length >>> 16) & 255, (body.length >>> 8) & 255, body.length & 255], body);
  const out = chunk('MThd', [0, 1, 0, tracks.length, ...division]); // format 1, n tracks, division
  for (const t of tracks) {
    const events = [...t].sort((a, b) => a.tick - b.tick);
    const body: number[] = [];
    let last = 0;
    for (const e of events) { body.push(...vlq(e.tick - last), ...e.bytes); last = e.tick; }
    body.push(0, 0xff, 0x2f, 0);
    out.push(...chunk('MTrk', body));
  }
  return new Uint8Array(out);
}

/** Note on/off pair as raw events. */
export function rawNote(channel: number, pitch: number, startBeat: number, durBeats: number, velocity = 100): RawEvent[] {
  const on = Math.round(startBeat * PPQ);
  return [{ tick: on, bytes: [0x90 | channel, pitch, velocity] }, { tick: on + Math.round(durBeats * PPQ), bytes: [0x80 | channel, pitch, 0] }];
}

/** A set-tempo meta event: `bpm` quarter notes per minute, or raw microseconds per quarter with `micros`. */
export function rawTempo(beat: number, bpm: number, micros = Math.round(60_000_000 / bpm)): RawEvent {
  return { tick: Math.round(beat * PPQ), bytes: [0xff, 0x51, 0x03, (micros >> 16) & 255, (micros >> 8) & 255, micros & 255] };
}
