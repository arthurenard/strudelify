/**
 * General MIDI program number -> Strudel soundfont name.
 *
 * Every name below is a key of `@strudel/soundfonts` gm.mjs (125 fonts; the four acoustic pianos
 * share `gm_piano`, so 128 programs map onto 125 names). Verified against the installed package by
 * `test/gm.test.ts`.
 */
export const GM_NAMES: string[] = [
  'gm_piano', 'gm_piano', 'gm_piano', 'gm_piano', 'gm_epiano1', 'gm_epiano2', 'gm_harpsichord', 'gm_clavinet',
  'gm_celesta', 'gm_glockenspiel', 'gm_music_box', 'gm_vibraphone', 'gm_marimba', 'gm_xylophone', 'gm_tubular_bells', 'gm_dulcimer',
  'gm_drawbar_organ', 'gm_percussive_organ', 'gm_rock_organ', 'gm_church_organ', 'gm_reed_organ', 'gm_accordion', 'gm_harmonica', 'gm_bandoneon',
  'gm_acoustic_guitar_nylon', 'gm_acoustic_guitar_steel', 'gm_electric_guitar_jazz', 'gm_electric_guitar_clean', 'gm_electric_guitar_muted', 'gm_overdriven_guitar', 'gm_distortion_guitar', 'gm_guitar_harmonics',
  'gm_acoustic_bass', 'gm_electric_bass_finger', 'gm_electric_bass_pick', 'gm_fretless_bass', 'gm_slap_bass_1', 'gm_slap_bass_2', 'gm_synth_bass_1', 'gm_synth_bass_2',
  'gm_violin', 'gm_viola', 'gm_cello', 'gm_contrabass', 'gm_tremolo_strings', 'gm_pizzicato_strings', 'gm_orchestral_harp', 'gm_timpani',
  'gm_string_ensemble_1', 'gm_string_ensemble_2', 'gm_synth_strings_1', 'gm_synth_strings_2', 'gm_choir_aahs', 'gm_voice_oohs', 'gm_synth_choir', 'gm_orchestra_hit',
  'gm_trumpet', 'gm_trombone', 'gm_tuba', 'gm_muted_trumpet', 'gm_french_horn', 'gm_brass_section', 'gm_synth_brass_1', 'gm_synth_brass_2',
  'gm_soprano_sax', 'gm_alto_sax', 'gm_tenor_sax', 'gm_baritone_sax', 'gm_oboe', 'gm_english_horn', 'gm_bassoon', 'gm_clarinet',
  'gm_piccolo', 'gm_flute', 'gm_recorder', 'gm_pan_flute', 'gm_blown_bottle', 'gm_shakuhachi', 'gm_whistle', 'gm_ocarina',
  'gm_lead_1_square', 'gm_lead_2_sawtooth', 'gm_lead_3_calliope', 'gm_lead_4_chiff', 'gm_lead_5_charang', 'gm_lead_6_voice', 'gm_lead_7_fifths', 'gm_lead_8_bass_lead',
  'gm_pad_new_age', 'gm_pad_warm', 'gm_pad_poly', 'gm_pad_choir', 'gm_pad_bowed', 'gm_pad_metallic', 'gm_pad_halo', 'gm_pad_sweep',
  'gm_fx_rain', 'gm_fx_soundtrack', 'gm_fx_crystal', 'gm_fx_atmosphere', 'gm_fx_brightness', 'gm_fx_goblins', 'gm_fx_echoes', 'gm_fx_sci_fi',
  'gm_sitar', 'gm_banjo', 'gm_shamisen', 'gm_koto', 'gm_kalimba', 'gm_bagpipe', 'gm_fiddle', 'gm_shanai',
  'gm_tinkle_bell', 'gm_agogo', 'gm_steel_drums', 'gm_woodblock', 'gm_taiko_drum', 'gm_melodic_tom', 'gm_synth_drum', 'gm_reverse_cymbal',
  'gm_guitar_fret_noise', 'gm_breath_noise', 'gm_seashore', 'gm_bird_tweet', 'gm_telephone', 'gm_helicopter', 'gm_applause', 'gm_gunshot',
];

/** The General MIDI instrument names (the standard's own wording), for reading track names against; `gmLabel` is the soundfont's shorter label. */
export const GM_INSTRUMENTS: string[] = [
  'Acoustic Grand Piano', 'Bright Acoustic Piano', 'Electric Grand Piano', 'Honky-tonk Piano', 'Electric Piano 1', 'Electric Piano 2', 'Harpsichord', 'Clavinet',
  'Celesta', 'Glockenspiel', 'Music Box', 'Vibraphone', 'Marimba', 'Xylophone', 'Tubular Bells', 'Dulcimer',
  'Drawbar Organ', 'Percussive Organ', 'Rock Organ', 'Church Organ', 'Reed Organ', 'Accordion', 'Harmonica', 'Tango Accordion',
  'Acoustic Guitar (nylon)', 'Acoustic Guitar (steel)', 'Electric Guitar (jazz)', 'Electric Guitar (clean)', 'Electric Guitar (muted)', 'Overdriven Guitar', 'Distortion Guitar', 'Guitar Harmonics',
  'Acoustic Bass', 'Electric Bass (finger)', 'Electric Bass (pick)', 'Fretless Bass', 'Slap Bass 1', 'Slap Bass 2', 'Synth Bass 1', 'Synth Bass 2',
  'Violin', 'Viola', 'Cello', 'Contrabass', 'Tremolo Strings', 'Pizzicato Strings', 'Orchestral Harp', 'Timpani',
  'String Ensemble 1', 'String Ensemble 2', 'Synth Strings 1', 'Synth Strings 2', 'Choir Aahs', 'Voice Oohs', 'Synth Voice', 'Orchestra Hit',
  'Trumpet', 'Trombone', 'Tuba', 'Muted Trumpet', 'French Horn', 'Brass Section', 'Synth Brass 1', 'Synth Brass 2',
  'Soprano Sax', 'Alto Sax', 'Tenor Sax', 'Baritone Sax', 'Oboe', 'English Horn', 'Bassoon', 'Clarinet',
  'Piccolo', 'Flute', 'Recorder', 'Pan Flute', 'Blown Bottle', 'Shakuhachi', 'Whistle', 'Ocarina',
  'Lead 1 (square)', 'Lead 2 (sawtooth)', 'Lead 3 (calliope)', 'Lead 4 (chiff)', 'Lead 5 (charang)', 'Lead 6 (voice)', 'Lead 7 (fifths)', 'Lead 8 (bass + lead)',
  'Pad 1 (new age)', 'Pad 2 (warm)', 'Pad 3 (polysynth)', 'Pad 4 (choir)', 'Pad 5 (bowed)', 'Pad 6 (metallic)', 'Pad 7 (halo)', 'Pad 8 (sweep)',
  'FX 1 (rain)', 'FX 2 (soundtrack)', 'FX 3 (crystal)', 'FX 4 (atmosphere)', 'FX 5 (brightness)', 'FX 6 (goblins)', 'FX 7 (echoes)', 'FX 8 (sci-fi)',
  'Sitar', 'Banjo', 'Shamisen', 'Koto', 'Kalimba', 'Bagpipe', 'Fiddle', 'Shanai',
  'Tinkle Bell', 'Agogo', 'Steel Drums', 'Woodblock', 'Taiko Drum', 'Melodic Tom', 'Synth Drum', 'Reverse Cymbal',
  'Guitar Fret Noise', 'Breath Noise', 'Seashore', 'Bird Tweet', 'Telephone Ring', 'Helicopter', 'Applause', 'Gunshot',
];

export function gmName(program: number): string {
  return GM_NAMES[Math.max(0, Math.min(127, program | 0))] ?? 'gm_piano';
}

/** Human-readable instrument name, e.g. 26 -> "electric guitar jazz". */
export function gmLabel(program: number): string {
  return gmName(program).replace(/^gm_/, '').replace(/_/g, ' ');
}

/**
 * Drum samples present in Strudel's default kit (the bare names registered by the REPL's prebake:
 * `bd brk cb cp cr hh ht lt misc mt oh rd rim sd sh tb`). `brk` is a breakbeat loop and `misc` is a
 * grab bag, so neither is used here. Hand percussion the kit lacks comes from the VCSL bank
 * (`percName`).
 */
export const DRUM_SAMPLES = new Set(['bd', 'sd', 'hh', 'oh', 'cp', 'rim', 'cr', 'rd', 'ht', 'mt', 'lt', 'sh', 'cb', 'tb']);

/**
 * General MIDI percussion key -> Strudel default-kit sample name, or null when the kit has nothing
 * for it. Every GM kit key from 35 to 59 is covered. Hand percussion the kit lacks (bongos, congas,
 * agogo, cabasa, guiro, claves, woodblocks, triangle, vibraslap, whistle, jingle bells, bell tree)
 * is played from the VCSL bank instead (`percName`); keys that neither bank can play (cuica, the GS
 * clicks and scratches below 35) are dropped. Only three approximations remain: timbales are
 * played on toms, surdos on the low tom, and sticks and castanets on the rimshot.
 */
export function drumName(key: number): string | null {
  switch (key) {
    case 35: case 36: return 'bd'; // acoustic / electric bass drum
    case 37: return 'rim'; // side stick
    case 38: case 40: return 'sd'; // acoustic / electric snare
    case 39: return 'cp'; // hand clap
    case 42: case 44: return 'hh'; // closed / pedal hi-hat
    case 46: return 'oh'; // open hi-hat
    case 49: case 57: case 52: case 55: return 'cr'; // crash 1, crash 2, china, splash
    case 51: case 53: case 59: return 'rd'; // ride 1, ride bell, ride 2
    case 41: case 43: return 'lt'; // low floor tom, high floor tom
    case 45: case 47: return 'mt'; // low tom, low-mid tom
    case 48: case 50: return 'ht'; // hi-mid tom, high tom
    case 54: return 'tb'; // tambourine
    case 56: return 'cb'; // cowbell
    case 70: case 82: return 'sh'; // maracas, shaker
    case 65: return 'ht'; // high timbale (approximation: a tom)
    case 66: return 'mt'; // low timbale (approximation: a tom)
    case 86: case 87: return 'lt'; // mute / open surdo (approximation: the low tom)
    case 31: case 85: return 'rim'; // sticks, castanets (approximation)
    default: return null;
  }
}

// ---------- hand percussion ----------

/**
 * Hand percussion the default kit lacks is played from the VCSL bank (Versilian Community Sample
 * Library), which the Strudel REPL loads at start-up next to the kit (`@strudel/repl` prebake:
 * dough-samples `vcsl.json`). `PERC_KEYS` names, per General MIDI key, the sample and the variant
 * played (`sample:index` in the mini-notation: the loudest normal hit of the right drum, so
 * `conga:18` is the quinto for the high conga and `conga:33` the tumba for the low one, the mute
 * conga is a muted quinto hit, and the short and long guiros are the fast and the slow scrape),
 * with the variant's level and peak. The indices are pinned against the bank's file list, of
 * which `test/fixtures/vcsl.json` is a snapshot: the test checks that each index still names the
 * intended file, so a reordered upstream list cannot silently turn the quinto into a tumba.
 *
 * The VCSL samples are 20-45 dB quieter than the kit's, so each sample's layer is trimmed
 * (`percTrim`). Levels are the RMS of the loudest 100 ms window, in dBFS, measured on the sample
 * files on 2026-09-04, when the kit's snare measured -8.8, its toms -10, the clap -11.4, the rimshot
 * -17.6, the cowbell -18 and the closed hat -27. Drums (bongos, congas) are brought to
 * `PERC_TARGET.drum`, between the toms and the rimshot; the small wooden, metal and shaken
 * instruments to `PERC_TARGET.small`, between the cowbell and the hat. A sample's loudest variant
 * sets the trim, so a muted hit stays quieter than an open one, and no variant's peak is pushed
 * above `PERC_PEAK_CEILING`.
 */
export interface PercKey {
  /** VCSL sample name, as the REPL registers it. */
  sample: string;
  /** Variant index played. */
  index: number;
  /** RMS of the loudest 100 ms window of that variant, dBFS. */
  level: number;
  /** Peak of that variant, dBFS. */
  peak: number;
}
export interface PercSample {
  /** Number of variants in the bank (the index must stay below it). */
  variants: number;
  kind: 'drum' | 'small';
  /** What the layer is called in the code comment. */
  label: string;
}
export const PERC_KEYS: Record<number, PercKey> = {
  58: { sample: 'vibraslap', index: 0, level: -41.4, peak: -22.3 },
  60: { sample: 'bongo', index: 4, level: -22.7, peak: -8.9 }, // high bongo
  61: { sample: 'bongo', index: 18, level: -22.9, peak: -10.4 }, // low bongo
  62: { sample: 'conga', index: 13, level: -29.3, peak: -18.2 }, // mute high conga (quinto, muted)
  63: { sample: 'conga', index: 18, level: -24.1, peak: -13.4 }, // open high conga (quinto)
  64: { sample: 'conga', index: 33, level: -27.6, peak: -15.9 }, // low conga (tumba)
  67: { sample: 'agogo', index: 2, level: -36.1, peak: -18.4 }, // high agogo
  68: { sample: 'agogo', index: 4, level: -36.2, peak: -22.2 }, // low agogo
  69: { sample: 'cabasa', index: 4, level: -34.1, peak: -20.8 },
  71: { sample: 'ballwhistle', index: 1, level: -23.6, peak: -14.2 }, // short whistle
  72: { sample: 'ballwhistle', index: 0, level: -22.3, peak: -14.4 }, // long whistle
  73: { sample: 'guiro', index: 0, level: -46.5, peak: -30.4 }, // short guiro: the fast scrape
  74: { sample: 'guiro', index: 4, level: -50.8, peak: -35.5 }, // long guiro: the slow scrape
  75: { sample: 'clave', index: 2, level: -35.1, peak: -14.3 },
  76: { sample: 'woodblock', index: 5, level: -23.2, peak: -4.5 }, // high woodblock
  77: { sample: 'woodblock', index: 4, level: -26.4, peak: -8.5 }, // low woodblock
  80: { sample: 'triangles', index: 30, level: -38.8, peak: -23.9 }, // mute triangle
  81: { sample: 'triangles', index: 35, level: -39.9, peak: -20.2 }, // open triangle
  83: { sample: 'sleighbells', index: 4, level: -32.7, peak: -18.5 }, // jingle bell
  84: { sample: 'marktrees', index: 0, level: -35.5, peak: -22.3 }, // bell tree
};
export const PERC_SAMPLES: Record<string, PercSample> = {
  vibraslap: { variants: 4, kind: 'small', label: 'vibraslap' },
  bongo: { variants: 28, kind: 'drum', label: 'bongos' },
  conga: { variants: 34, kind: 'drum', label: 'congas' },
  agogo: { variants: 5, kind: 'small', label: 'agogo bells' },
  cabasa: { variants: 6, kind: 'small', label: 'cabasa' },
  ballwhistle: { variants: 2, kind: 'small', label: 'whistle' },
  guiro: { variants: 5, kind: 'small', label: 'guiro' },
  clave: { variants: 6, kind: 'small', label: 'claves' },
  woodblock: { variants: 10, kind: 'small', label: 'woodblocks' },
  triangles: { variants: 37, kind: 'small', label: 'triangle' },
  sleighbells: { variants: 6, kind: 'small', label: 'jingle bells' },
  marktrees: { variants: 6, kind: 'small', label: 'bell tree' },
};
/** Target level (loudest 100 ms RMS, dBFS) for a hand-percussion layer: see `PERC_KEYS`. */
export const PERC_TARGET = { drum: -14, small: -20 } as const;
/** No trimmed variant's peak may exceed this (dBFS). */
export const PERC_PEAK_CEILING = -0.5;
/** The kit's own level on the same scale (its snare), so a hand-percussion layer's amplitude relative to the kit is known (`percShare`). */
export const KIT_LEVEL = -8.8;

/** The VCSL sample and variant for a General MIDI percussion key the default kit cannot play, or null. */
export function percName(key: number): (PercKey & { token: string }) | null {
  const p = PERC_KEYS[key];
  return p ? { ...p, token: `${p.sample}:${p.index}` } : null;
}

/** Trim of a hand-percussion sample's layer, in dB: its loudest variant to the target, unless a variant's peak would clip first. */
export function percTrimDb(sample: string): number {
  const used = Object.values(PERC_KEYS).filter((p) => p.sample === sample);
  const kind = PERC_SAMPLES[sample]?.kind ?? 'small';
  if (!used.length) return 0;
  const toTarget = PERC_TARGET[kind] - Math.max(...used.map((p) => p.level));
  const toCeiling = Math.min(...used.map((p) => PERC_PEAK_CEILING - p.peak));
  return Math.round(Math.min(toTarget, toCeiling) * 10) / 10;
}

/**
 * Amplitude of a trimmed hand-percussion layer relative to the kit at the same gain (a conga layer
 * brought to -14 dBFS sits at 0.55 of the snare's -8.8, a triangle at 0.28), which is what the
 * layer adds to a loud moment: the headroom check counts it at this share of its gain.
 */
export function percShare(sample: string): number {
  const kind = PERC_SAMPLES[sample]?.kind ?? 'small';
  return Math.round(Math.pow(10, (PERC_TARGET[kind] - KIT_LEVEL) / 20) * 100) / 100;
}

/** Linear gain multiplier for a hand-percussion sample's layer (see `percTrimDb`). */
export function percTrim(sample: string): number {
  return Math.round(Math.pow(10, percTrimDb(sample) / 20) * 100) / 100;
}

/** GM default channel volume (CC 7 = 100) as a 0-1 fraction: the level a part has when the file sets nothing. */
export const NOMINAL_VOLUME = 100 / 127;

/** Linear level of a part relative to a nominal one: velocity x (CC 7 x CC 11 / nominal)^2, the GM curve. */
export function mixLevel(velocity: number, volume: number | undefined): number {
  const cc = (volume ?? NOMINAL_VOLUME) / NOMINAL_VOLUME;
  return velocity * cc * cc;
}

/**
 * Parts whose level (velocity x channel volume) is below this are inaudible in any GM player (a
 * muted guide track, a part faded to nothing) and are left out rather than lifted to the gain floor.
 * A part with a real number of notes (`REAL_PART_NOTES`) is kept down to `QUIET_LEVEL` (about
 * -28 dB below a nominal part): a vocal at CC 7 = 36 and velocity 40% is quiet, not muted, and a
 * GM player renders it; a stub of a few notes at that level is not worth a track.
 */
export const AUDIBLE_LEVEL = 0.08;
export const QUIET_LEVEL = 0.03;
export const REAL_PART_NOTES = 32;

/** Whether a part at `level` (see `mixLevel`) with `notes` notes would be heard in a GM player. */
export function isAudible(level: number, notes: number): boolean {
  return level >= AUDIBLE_LEVEL || (notes >= REAL_PART_NOTES && level >= QUIET_LEVEL);
}

/** Whether the file silences the part outright: channel volume at 0, or every note at the lowest velocity. */
export function isMuted(volume: number | undefined, meanVelocity: number): boolean {
  return volume === 0 || meanVelocity <= 1 / 127 + 1e-9;
}

// ---------- bank select ----------

/**
 * Roland MT-32 patch names, in the order of the MT-32 map that Roland GS devices select with bank
 * MSB 127 (files from the late 1980s and early 1990s were often authored on an MT-32 or an SC-55 in
 * MT-32 mode, and keep `CC 0 = 127` before their program changes). Read through the General MIDI
 * table these programs are nonsense: patch 59 "Guitar 1" is GM 59 "muted trumpet", 64 "Acou Bass 1"
 * is a soprano sax, 24 "Syn Brass 1" is a nylon guitar.
 */
export const MT32_NAMES: string[] = [
  'Acou Piano 1', 'Acou Piano 2', 'Acou Piano 3', 'Elec Piano 1', 'Elec Piano 2', 'Elec Piano 3', 'Elec Piano 4', 'Honkytonk',
  'Elec Org 1', 'Elec Org 2', 'Elec Org 3', 'Elec Org 4', 'Pipe Org 1', 'Pipe Org 2', 'Pipe Org 3', 'Accordion',
  'Harpsi 1', 'Harpsi 2', 'Harpsi 3', 'Clavi 1', 'Clavi 2', 'Clavi 3', 'Celesta 1', 'Celesta 2',
  'Syn Brass 1', 'Syn Brass 2', 'Syn Brass 3', 'Syn Brass 4', 'Syn Bass 1', 'Syn Bass 2', 'Syn Bass 3', 'Syn Bass 4',
  'Fantasy', 'Harmo Pan', 'Chorale', 'Glasses', 'Soundtrack', 'Atmosphere', 'Warm Bell', 'Funny Vox',
  'Echo Bell', 'Ice Rain', 'Oboe 2001', 'Echo Pan', 'Doctor Solo', 'School Daze', 'Bellsinger', 'Square Wave',
  'Str Sect 1', 'Str Sect 2', 'Str Sect 3', 'Pizzicato', 'Violin 1', 'Violin 2', 'Cello 1', 'Cello 2',
  'Contrabass', 'Harp 1', 'Harp 2', 'Guitar 1', 'Guitar 2', 'Elec Gtr 1', 'Elec Gtr 2', 'Sitar',
  'Acou Bass 1', 'Acou Bass 2', 'Elec Bass 1', 'Elec Bass 2', 'Slap Bass 1', 'Slap Bass 2', 'Fretless 1', 'Fretless 2',
  'Flute 1', 'Flute 2', 'Piccolo 1', 'Piccolo 2', 'Recorder', 'Pan Pipes', 'Sax 1', 'Sax 2',
  'Sax 3', 'Sax 4', 'Clarinet 1', 'Clarinet 2', 'Oboe', 'Engl Horn', 'Bassoon', 'Harmonica',
  'Trumpet 1', 'Trumpet 2', 'Trombone 1', 'Trombone 2', 'Fr Horn 1', 'Fr Horn 2', 'Tuba', 'Brs Sect 1',
  'Brs Sect 2', 'Vibe 1', 'Vibe 2', 'Syn Mallet', 'Windbell', 'Glock', 'Tube Bell', 'Xylophone',
  'Marimba', 'Koto', 'Sho', 'Shakuhachi', 'Whistle 1', 'Whistle 2', 'Bottleblow', 'Breathpipe',
  'Timpani', 'Melodic Tom', 'Deep Snare', 'Elec Perc 1', 'Elec Perc 2', 'Taiko', 'Taiko Rim', 'Cymbal',
  'Castanets', 'Triangle', 'Orche Hit', 'Telephone', 'Bird Tweet', 'One Note Jam', 'Water Bell', 'Jungle Tune',
];

/** MT-32 patch number -> the General MIDI program that plays the same instrument (parallel to `MT32_NAMES`). */
export const MT32_TO_GM: number[] = [
  0, 1, 2, 4, 4, 5, 5, 3, // pianos, honky-tonk
  16, 17, 18, 16, 19, 19, 20, 21, // organs, accordion
  6, 6, 6, 7, 7, 7, 8, 8, // harpsichords, clavinets, celestas
  62, 63, 62, 63, 38, 39, 38, 39, // synth brass, synth bass
  88, 89, 52, 98, 97, 99, 92, 85, // fantasy, harmo pan, chorale, glasses, soundtrack, atmosphere, warm bell, funny vox
  102, 96, 68, 102, 87, 82, 98, 80, // echo bell, ice rain, oboe 2001, echo pan, doctor solo, school daze, bellsinger, square wave
  48, 49, 50, 45, 40, 40, 42, 42, // string sections, pizzicato, violins, cellos
  43, 46, 46, 24, 25, 27, 29, 104, // contrabass, harps, guitars (nylon, steel, clean, overdriven), sitar
  32, 32, 33, 34, 36, 37, 35, 35, // acoustic, electric, slap and fretless basses
  73, 73, 72, 72, 74, 75, 64, 65, // flutes, piccolos, recorder, pan pipes, saxes 1-2
  66, 67, 71, 71, 68, 69, 70, 22, // saxes 3-4, clarinets, oboe, english horn, bassoon, harmonica
  56, 56, 57, 57, 60, 60, 58, 61, // trumpets, trombones, french horns, tuba, brass section 1
  61, 11, 11, 12, 14, 9, 14, 13, // brass section 2, vibes, syn mallet, windbell, glock, tube bell, xylophone
  12, 107, 20, 77, 78, 78, 76, 76, // marimba, koto, sho (a free reed: reed organ), shakuhachi, whistles, bottle blow, breath pipe
  47, 117, 118, 118, 118, 116, 116, 119, // timpani, melodic tom, deep snare, electric percussion, taikos, cymbal
  115, 112, 55, 124, 123, 126, 98, 122, // castanets, triangle, orchestra hit, telephone, bird tweet, one-note jam, water bell, jungle tune (the last two are effects)
];

/** Bank select MSB that Roland GS devices reserve for the MT-32 map, and that Yamaha XG devices use for drum kits. */
export const MT32_BANK = 127;

/**
 * Instrument families, for reconciling what a track's name says with what its patch is. `family`
 * classes a General MIDI program; `nameFamily` reads a track name ("#EL.GTR 2", "Strijkers", "Horns").
 * Names that only say "synth" or "lead" are left unclassed: a synth can be a bass, a pad or a lead.
 */
export type Family = 'piano' | 'mallet' | 'organ' | 'guitar' | 'bass' | 'strings' | 'voice' | 'brass' | 'reed' | 'pipe' | 'synth' | 'ethnic' | 'percussion' | 'fx';

export function family(program: number): Family {
  if (program < 8) return 'piano';
  if (program < 16) return 'mallet';
  if (program < 24) return 'organ';
  if (program < 32) return 'guitar';
  if (program < 40) return 'bass';
  if (program < 52) return 'strings';
  if (program < 55 || program === 85 || program === 91) return 'voice';
  if (program === 55) return 'fx';
  if (program < 64) return 'brass';
  if (program < 72) return 'reed';
  if (program < 80) return 'pipe';
  if (program < 96) return 'synth';
  if (program < 104) return 'fx';
  if (program < 112) return 'ethnic';
  if (program < 120) return 'percussion';
  return 'fx';
}

const NAME_FAMILIES: [Family, RegExp][] = [
  // "Bass", "Syn.Bass", "Basse", "Basso"; not "Bass Drum", "Bassoon" or "Bass Clarinet".
  ['bass', /\bbass(?!oon|\s*(?:drum|cl))/i],
  // (A "6 String", "12-String", "Steel String" or "Nyl.Str" is a guitar, read before the string section below claims it.)
  ['guitar', /guit|gtr|\bgt\b|\bgit\b|ukulele|banjo|mandolin|les\s*paul|strat(?:ocaster)?\b|telecaster|\bfuzz\b|(?:\b(?:6|12)|steel|nylon|\bnyl\.?)[\s-]*str|(?:overdriv|distort)(?![\s\S]*(?:synth|syn\b|organ|pad|key))/i],
  ['piano', /piano|\bpno\b|clav|harpsi|honky|rhodes|wurli/i],
  ['organ', /organ|\borg\b|accord|harmonica|\bb3\b/i],
  ['strings', /string|strijk|\bstr\b|violin|viola|cello|fiddle|pizz|\bharp\b|orchestr/i],
  ['brass', /brass|\bbrs\b|horn|trumpet|\btpt\b|trombone|\btbn\b|tuba/i],
  ['reed', /\bsax|oboe|clarinet|bassoon/i],
  ['pipe', /flute|piccolo|recorder|whistle|ocarina|pan\s*pipe/i],
  ['mallet', /vibe|vibra|marimba|xylo|glock|celest|bell/i],
  ['voice', /choir|chor|vox|voice|vocal|aah|ooh/i],
];

/** The instrument family a track name says, if any. Bass wins ("Syn.Bass", "Bass Guitar"), then the other names in order. */
export function nameFamily(name: string): Family | undefined {
  for (const [f, re] of NAME_FAMILIES) if (re.test(name)) return f;
  return undefined;
}

/** Every instrument family a track name mentions ("Gtr/Strings" names two). */
export function nameFamilies(name: string): Set<Family> {
  return new Set(NAME_FAMILIES.filter(([, re]) => re.test(name)).map(([f]) => f));
}

/**
 * Families whose patches stand in for each other in ordinary arrangements, so a name of one on a
 * patch of the other is a choice, not a contradiction: a horn section written on saxes (or "Sax"
 * on a brass patch), a mandolin or a "guitar" on the plucked ethnic patches (banjo, sitar, koto,
 * shamisen), bells and blocks on the drum-like patches (tinkle bell, agogo, steel drums, woodblock).
 */
const COMPATIBLE_FAMILIES: [Family, Family][] = [['brass', 'reed'], ['guitar', 'ethnic'], ['mallet', 'percussion']];

/** Words that say a synth was meant ("Guitar Pad", "Synth Strings", "Syn Bass"): a synth lead or pad so named is what its author heard. */
const SYNTH_WORD_RE = /synth|\bsyn\b|\bpad\b/i;

/**
 * Whether a track name is consistent with the General MIDI program it sits on: the name says that
 * patch ("Banjo" on 105, "Bass&Lead" on Lead 8), mentions its family ("Piano/Guitar" on either),
 * mentions a family that stands in for it (see `COMPATIBLE_FAMILIES`), or asks for a synth on a
 * synth patch. A name that fits is trusted as it is; one that contradicts a definite family is
 * reconciled by `reconcileName`.
 */
export function nameFitsPatch(name: string, program: number): boolean {
  if (nameSaysPatch(name, GM_INSTRUMENTS[program] ?? '')) return true;
  const fam = family(program);
  const named = nameFamilies(name);
  if (named.has(fam)) return true;
  if (fam === 'synth' && SYNTH_WORD_RE.test(name)) return true;
  return COMPATIBLE_FAMILIES.some(([a, b]) => (fam === a && named.has(b)) || (fam === b && named.has(a)));
}

export const BASS_PROGRAMS = new Set([32, 33, 34, 35, 36, 37, 38, 39]);
export const GUITAR_PROGRAMS = new Set([24, 25, 26, 27, 28, 29, 30, 31]);
/**
 * Patches that stand in for a singer. A melody on one of these is rendered on the replacement
 * synth (the product never plays a voice); melodies on any other patch keep their instrument.
 */
export const VOCAL_PROGRAMS = new Set([52, 53, 54, 85, 121]);
/**
 * Patches that carry bass lines in real arrangements: basses, guitars, pianos, organs, low strings
 * and string sections, trombone, tuba, baritone sax, bassoon, synth leads and pads (but never a
 * voice patch, see `VOICE_BASS_SOUND`). A low line on one of these may be the bass by register
 * alone; a part called "bass" on any other patch (a soprano sax at G2) is played on a bass
 * soundfont instead.
 */
export const BASS_CAPABLE_PROGRAMS = new Set([
  ...Array.from({ length: 8 }, (_, i) => i), // pianos
  ...Array.from({ length: 8 }, (_, i) => 16 + i), // organs
  ...Array.from({ length: 16 }, (_, i) => 24 + i), // guitars and basses
  42, 43, 44, 45, 48, 49, 50, 51, // cello, contrabass, tremolo and pizzicato strings, ensembles
  57, 58, 67, 70, // trombone, tuba, baritone sax, bassoon
  ...Array.from({ length: 16 }, (_, i) => 80 + i).filter((p) => !VOCAL_PROGRAMS.has(p)), // synth leads and pads
]);
/** Soundfont that stands in for a bass part whose patch cannot play a bass line. */
export const BASS_FALLBACK_SOUND = 'gm_electric_bass_finger';
/**
 * The last fret of a bass's G string (G4): a part on a bass patch whose median pitch is at or above
 * it plays where no bass does (a fretless bass carrying a vocal duet at C5, a synth bass used as a
 * lead), so a line there goes to `BASS_LEAD_SOUND`, the General MIDI synth made to cover both
 * registers; chords there keep the patch and are remarked on.
 */
export const BASS_PATCH_TOP = 67;
export const BASS_LEAD_SOUND = 'gm_lead_8_bass_lead';
/**
 * Soundfont for a bass line written on a voice patch (a synth choir or "lead 6 voice" at F1 is a
 * synth bass in every file that does it): a synth bass, never a voice.
 */
export const VOICE_BASS_SOUND = 'gm_synth_bass_1';
/**
 * Patches MIDI transcribers use to stand in for a singer when they do not use a voice: sustaining
 * single-line instruments (harmonica, violin and viola, brass, reeds, pipes, synth leads, fiddle)
 * plus the vocal patches. A sung line split over several such channels (a sax for the verse, a
 * horn for the chorus) is reassembled into one melody; guitars, pianos and organs are not in the
 * set, so a guitar solo that takes turns with the singer stays a separate part.
 */
export const SINGER_STANDIN_PROGRAMS = new Set([
  22, 40, 41, ...VOCAL_PROGRAMS,
  ...Array.from({ length: 32 }, (_, i) => 56 + i), // brass, reeds, pipes, synth leads
  110,
]);
/** Programs that are sound effects or noise: dropped from the arrangement. Breath noise (121) is kept as a vocal stand-in. */
export const FX_PROGRAMS = new Set([96, 97, 98, 99, 100, 101, 102, 103, 119, 120, 122, 123, 124, 125, 126, 127]);

/** Families a track name states definitely enough to overrule a patch number that both patch tables read as something else. */
export const DEFINITE_FAMILIES = new Set<Family>(['guitar', 'bass', 'piano', 'organ', 'strings', 'brass', 'reed', 'pipe', 'mallet']);

/**
 * The General MIDI program that best plays a part whose name says `fam` (see `nameFamily`): the
 * name's own words pick the member ("Overdrive Guitar" -> overdriven guitar, "Slap Bass" -> slap
 * bass, "Tenor Sax" -> tenor sax), otherwise the family's usual patch.
 */
export function programForName(name: string, fam: Family): number {
  const has = (re: RegExp) => re.test(name);
  switch (fam) {
    case 'guitar':
      if (has(/distort|fuzz/i)) return 30;
      if (has(/overdriv|les\s*paul|crunch|rock|heavy/i)) return 29;
      if (has(/mute/i)) return 28;
      if (has(/nylon|classic|spanish|flamenco/i)) return 24;
      if (has(/acou|steel|folk|12/i)) return 25;
      if (has(/jazz|hollow/i)) return 26;
      if (has(/lead|solo/i)) return 29; // a lead guitar written on a synth lead or an unset piano is an overdriven one, not a clean one
      return 27;
    case 'bass':
      if (has(/syn/i)) return 38;
      if (has(/slap|pop/i)) return 36;
      if (has(/fretless/i)) return 35;
      if (has(/acou|upright|double|contra/i)) return 32;
      if (has(/pick/i)) return 34;
      return 33;
    case 'piano':
      if (has(/harpsi/i)) return 6;
      if (has(/clav/i)) return 7;
      if (has(/honky/i)) return 3;
      if (has(/rhodes|wurli|\bel|\be\.?\s*p|electric/i)) return 4;
      return 0;
    case 'organ':
      if (has(/harmonica/i)) return 22;
      if (has(/accord/i)) return 21;
      if (has(/church|pipe|cathedral/i)) return 19;
      if (has(/reed|harmonium/i)) return 20;
      if (has(/rock/i)) return 18;
      if (has(/perc/i)) return 17;
      return 16;
    case 'strings':
      if (has(/viola\b/i)) return 41;
      if (has(/violin|fiddle/i)) return 40;
      if (has(/cello/i)) return 42;
      if (has(/contra|double/i)) return 43;
      if (has(/pizz/i)) return 45;
      if (has(/harp\b/i)) return 46;
      if (has(/trem/i)) return 44;
      if (has(/syn/i)) return 50;
      return 48;
    case 'brass':
      if (has(/trumpet|\btpt\b/i)) return 56;
      if (has(/trombone|\btbn\b/i)) return 57;
      if (has(/tuba/i)) return 58;
      if (has(/mute/i)) return 59;
      if (has(/fr(ench)?\s*horn/i)) return 60;
      if (has(/syn/i)) return 62;
      return 61;
    case 'reed':
      if (has(/soprano/i)) return 64;
      if (has(/tenor/i)) return 66;
      if (has(/bari/i)) return 67;
      if (has(/oboe/i)) return 68;
      if (has(/bassoon/i)) return 70;
      if (has(/clarinet/i)) return 71;
      return 65;
    case 'pipe':
      if (has(/piccolo/i)) return 72;
      if (has(/recorder/i)) return 74;
      if (has(/pan/i)) return 75;
      if (has(/whistle/i)) return 78;
      if (has(/ocarina/i)) return 79;
      return 73;
    case 'mallet':
      if (has(/marimba/i)) return 12;
      if (has(/xylo/i)) return 13;
      if (has(/glock/i)) return 9;
      if (has(/celest/i)) return 8;
      if (has(/tubular|chime/i)) return 14;
      if (has(/bell/i)) return 14;
      return 11;
    case 'voice': return 52;
    default: return 0;
  }
}

// ---------- matching track names against the patch tables ----------

/** Abbreviations track names and the MT-32 table use, spelled out so both sides compare as whole words. */
const ABBREVIATIONS: Record<string, string> = {
  acou: 'acoustic', ac: 'acoustic', elec: 'electric', el: 'electric', gtr: 'guitar', guit: 'guitar', git: 'guitar', pno: 'piano',
  org: 'organ', str: 'string', strings: 'string', sect: 'section', brs: 'brass', syn: 'synth', fr: 'french', engl: 'english',
  harpsi: 'harpsichord', clav: 'clavinet', clavi: 'clavinet', vibe: 'vibraphone', vibes: 'vibraphone', glock: 'glockenspiel',
  perc: 'percussion', pizz: 'pizzicato', trem: 'tremolo', tpt: 'trumpet', tbn: 'trombone', trb: 'trombone', hrn: 'horn', vln: 'violin',
  vla: 'viola', flt: 'flute', bsn: 'bassoon', orche: 'orchestra', orch: 'orchestra', doc: 'doctor', sq: 'square', bttl: 'bottle',
  hmnca: 'harmonica', sx: 'sax', saxophone: 'sax', bells: 'bell', drums: 'drum', polysynth: 'poly',
};
/** Words that name no instrument, so a name made only of them matches nothing. */
const GENERIC_WORDS = new Set(['synth', 'lead', 'pad', 'solo', 'melody', 'track', 'midi', 'rhythm', 'main', 'part', 'sound', 'keys', 'etc', 'new', 'old', 'the', 'and', 'of', 'ch', 'trk', 'inst', 'intro', 'verse', 'chorus', 'fill']);

/** A name's instrument words: split on spaces, punctuation, digits and case changes ("AcouPno2" -> acou, pno), abbreviations spelled out, single letters and numbers dropped. */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 2)
    .map((w) => ABBREVIATIONS[w] ?? w);
}

/**
 * A track-name word `a` says the patch word `b` when they are equal, when `a` abbreviates `b` by
 * three letters or more ("harmo"/"harmonica", "fret"/"fretless"), or when `a` is `b` with a plural
 * or a suffix of up to two letters ("pianos"/"piano"); "strijkers" does not say "string".
 */
function sameWord(a: string, b: string): boolean {
  return a === b || (a.length >= 3 && b.startsWith(a)) || (b.length >= 3 && a.startsWith(b) && a.length - b.length <= 2);
}

/**
 * Whether a track name says the instrument `patchName` names: every instrument word of the track
 * name (in order) is found in the patch name, abbreviation-tolerant, numbers ignored. "Sq Wave"
 * names "Square Wave", "El Guitar" names "Elec Gtr 2", "AcBass2" names "Acou Bass 2", "Organ" names
 * "Elec Org 1"; "Snare Drum" does not name "Taiko Drum" (nothing says snare), and a name made only
 * of generic words ("Synth", "Lead 2") names nothing.
 */
export function nameSaysPatch(name: string, patchName: string): boolean {
  const words = nameWords(name).filter((w) => !GENERIC_WORDS.has(w));
  if (!words.length) return false;
  const target = nameWords(patchName);
  let k = 0;
  for (const w of words) {
    while (k < target.length && !sameWord(w, target[k])) k++;
    if (k >= target.length) return false;
    k++;
  }
  return true;
}

/**
 * Which patch table a named channel's program fits: its name read against the General MIDI
 * instrument name and against the Roland MT-32 patch name at the same number. `mt32` when only the MT-32 name fits
 * ("Doc Solo" at 44: GM tremolo strings), `gm` when only the GM label does ("Bass" at 33: MT-32 Harmo
 * Pan), undefined when both or neither do ("Flute" at 73: both, "Str etc." at 50: both).
 */
export function tableForName(name: string, program: number): 'gm' | 'mt32' | undefined {
  const gm = nameSaysPatch(name, GM_INSTRUMENTS[program] ?? ''), mt32 = nameSaysPatch(name, MT32_NAMES[program] ?? '');
  if (gm === mt32) return undefined;
  return gm ? 'gm' : 'mt32';
}
