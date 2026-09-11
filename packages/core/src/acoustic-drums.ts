/** Recorded VCSL percussion for reviewed acoustic arrangements. The REPL preloads this bank.
 * Sample indices refer to core/test/fixtures/acoustic-drums.json. Gains are conservative trims
 * based on the loudest 100 ms RMS and sample peaks, measured on 2026-09-11.
 * Low/mid toms share a low-tom recording; these are instrument matches, not the record's drum sound.
 */
export interface AcousticDrum { sample: string; index: number; gain: number }
const kick = { sample: 'bassdrum1', index: 6, gain: 1 };
const snare = { sample: 'snare_modern', index: 14, gain: 1.5 };
const lowTom = { sample: 'tom2_stick', index: 4, gain: 1.5 };
const highTom = { sample: 'tom_stick', index: 4, gain: 1.5 };
const crash = { sample: 'sus_cymbal2', index: 9, gain: 0.8 };
const ride = { sample: 'sus_cymbal', index: 15, gain: 2.8 };
export const ACOUSTIC_DRUMS: Record<number, AcousticDrum> = {
  35: kick, 36: kick,
  37: { sample: 'snare_modern', index: 43, gain: 1.5 },
  38: snare, 40: snare,
  41: lowTom, 43: lowTom, 45: lowTom, 47: lowTom, 48: highTom, 50: highTom,
  42: { sample: 'hihat', index: 8, gain: 0.8 },
  44: { sample: 'hihat', index: 0, gain: 0.8 },
  46: { sample: 'hihat', index: 13, gain: 0.8 },
  49: crash, 52: crash, 55: crash, 57: crash,
  51: ride, 59: ride, 53: { sample: 'sus_cymbal', index: 8, gain: 0.8 },
};
