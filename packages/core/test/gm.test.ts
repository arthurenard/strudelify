import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GM_NAMES, GM_INSTRUMENTS, gmName, gmLabel, drumName, DRUM_SAMPLES, percName, percTrim, percTrimDb, PERC_KEYS, PERC_SAMPLES, PERC_TARGET, PERC_PEAK_CEILING, FX_PROGRAMS, VOCAL_PROGRAMS, SINGER_STANDIN_PROGRAMS, NOMINAL_VOLUME, MT32_NAMES, MT32_TO_GM, MT32_BANK, family, nameFamily, nameFamilies, nameFitsPatch, BASS_PATCH_TOP, BASS_LEAD_SOUND, mixLevel, AUDIBLE_LEVEL, QUIET_LEVEL, REAL_PART_NOTES, isAudible, isMuted, nameWords, nameSaysPatch, tableForName, programForName, DEFINITE_FAMILIES } from '../src/gm.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Soundfont names registered by the installed @strudel/soundfonts package (keys of gm.mjs). */
function installedSoundfonts(): Set<string> {
  const file = path.resolve(here, '../../../node_modules/@strudel/soundfonts/gm.mjs');
  const src = fs.readFileSync(file, 'utf8');
  return new Set([...src.matchAll(/^\s{2}(gm_\w+):\s*\[/gm)].map((m) => m[1]));
}

describe('General MIDI mapping', () => {
  it('maps all 128 programs to a soundfont that Strudel actually ships', () => {
    const fonts = installedSoundfonts();
    expect(fonts.size).toBeGreaterThan(100);
    expect(GM_NAMES).toHaveLength(128);
    for (let p = 0; p < 128; p++) expect(fonts.has(gmName(p)), `program ${p} -> ${gmName(p)}`).toBe(true);
    // And every shipped font is reachable from some program.
    for (const f of fonts) expect(GM_NAMES.includes(f), f).toBe(true);
  });
  it('clamps out-of-range programs and gives readable labels', () => {
    expect(gmName(-5)).toBe('gm_piano');
    expect(gmName(999)).toBe('gm_gunshot');
    expect(gmLabel(26)).toBe('electric guitar jazz');
    expect(gmLabel(33)).toBe('electric bass finger');
  });
  it('names the patches that stand in for a singer, and the GM default volume', () => {
    for (const p of [52, 53, 54, 56, 60, 65, 71, 73, 80, 85, 110, 22]) expect(SINGER_STANDIN_PROGRAMS.has(p), `program ${p}`).toBe(true);
    for (const p of [0, 4, 18, 24, 26, 30, 33, 48, 88]) expect(SINGER_STANDIN_PROGRAMS.has(p), `program ${p}`).toBe(false);
    expect(NOMINAL_VOLUME).toBeCloseTo(100 / 127, 6);
  });
  it('keeps breath noise (a vocal stand-in) out of the effects set', () => {
    expect(FX_PROGRAMS.has(121)).toBe(false);
    expect(VOCAL_PROGRAMS.has(121)).toBe(true);
    expect(FX_PROGRAMS.has(122)).toBe(true);
  });
});

describe('drum mapping', () => {
  it('only ever names samples present in the default kit', () => {
    for (let k = 0; k < 128; k++) {
      const s = drumName(k);
      if (s !== null) expect(DRUM_SAMPLES.has(s), `key ${k} -> ${s}`).toBe(true);
    }
  });
  it('covers the whole standard kit from 35 to 59', () => {
    for (let k = 35; k <= 59; k++) {
      if (k === 58) { expect(percName(58)?.sample).toBe('vibraslap'); continue; } // nothing comparable in the kit: the VCSL vibraslap
      expect(drumName(k), `key ${k}`).not.toBeNull();
    }
    expect(drumName(42)).toBe('hh');
    expect(drumName(44)).toBe('hh');
    expect(drumName(46)).toBe('oh');
    expect(drumName(49)).toBe('cr');
    expect(drumName(51)).toBe('rd');
    expect(drumName(41)).toBe('lt');
    expect(drumName(47)).toBe('mt');
    expect(drumName(50)).toBe('ht');
  });
  it('plays hand percussion from the VCSL bank, one bank per key, and drops what neither bank has', () => {
    for (let k = 0; k < 128; k++) expect(drumName(k) !== null && percName(k) !== null, `key ${k} in both banks`).toBe(false);
    expect(percName(63)).toMatchObject({ sample: 'conga', index: 18, token: 'conga:18' }); // open high conga: the quinto
    expect(percName(62)?.token).toBe('conga:13'); // mute high conga: a muted quinto hit
    expect(percName(64)?.token).toBe('conga:33'); // low conga: the tumba
    expect(percName(60)?.sample).toBe('bongo');
    expect(percName(61)?.sample).toBe('bongo');
    expect(percName(67)?.sample).toBe('agogo');
    expect(percName(69)?.sample).toBe('cabasa');
    expect(drumName(69)).toBeNull();
    expect(percName(73)?.token).toBe('guiro:0'); // short guiro: the fast scrape
    expect(percName(74)?.token).toBe('guiro:4'); // long guiro: the slow scrape
    expect(percName(75)?.token).toBe('clave:2');
    expect(percName(76)?.sample).toBe('woodblock');
    expect(percName(81)?.token).toBe('triangles:35');
    expect(percName(83)?.sample).toBe('sleighbells');
    expect(percName(84)?.sample).toBe('marktrees');
    // Approximations that stay in the kit: timbales and surdos on toms, sticks and castanets on the rimshot, maracas on the shaker.
    expect(drumName(65)).toBe('ht');
    expect(drumName(66)).toBe('mt');
    expect(drumName(86)).toBe('lt');
    expect(drumName(31)).toBe('rim');
    expect(drumName(85)).toBe('rim');
    expect(drumName(70)).toBe('sh');
    // Neither bank: cuica, the GS clicks and scratches below 35.
    for (const k of [78, 79, 27, 28, 29, 30, 32, 33, 34, 13, 14]) { expect(drumName(k), `key ${k}`).toBeNull(); expect(percName(k), `key ${k}`).toBeNull(); }
    for (const [key, p] of Object.entries(PERC_KEYS)) {
      const bank = PERC_SAMPLES[p.sample];
      expect(bank, `key ${key} names an unknown sample ${p.sample}`).toBeDefined();
      expect(p.index, `key ${key} variant`).toBeLessThan(bank.variants);
      expect(p.level).toBeLessThanOrEqual(p.peak);
      expect(p.level).toBeGreaterThan(-60);
    }
  });
  it('pins every VCSL variant index to the intended file of the bank (a snapshot of the vcsl.json the REPL loads)', () => {
    const bank = JSON.parse(fs.readFileSync(path.resolve(here, 'fixtures/vcsl.json'), 'utf8')) as Record<string, string[] | string>;
    expect(bank._base).toBe('https://raw.githubusercontent.com/sgossner/VCSL/master/');
    const expected: Record<number, RegExp> = {
      58: /\/vibraslap_rr1\.wav$/,
      60: /\/BongoH_Hit1_/, 61: /\/BongoL_Hit1_/,
      62: /\/Quinto_HitFM/, 63: /\/Quinto_HitN_/, 64: /\/Tumba_HitN_/,
      67: /\/Agogo_High_/, 68: /\/Agogo_Low_/,
      69: /\/Cabasa1_Rub_/,
      71: /BallWhistle_Short/, 72: /BallWhistle_Long/,
      73: /\/Guiro_Fast_/, 74: /\/Guiro_Slow_/,
      75: /\/Claves1_Hit_/,
      76: /\/wood_click_ff\.wav$/, 77: /\/wood_click_f_rr/,
      80: /\/Triangle6_HitM_/, 81: /\/Triangle6_Hit_/,
      83: /\/sleighbell2_hit_loud\.wav$/,
      84: /\/windchimes_asc1\.wav$/,
    };
    expect(Object.keys(expected).sort()).toEqual(Object.keys(PERC_KEYS).sort());
    for (const [key, p] of Object.entries(PERC_KEYS)) {
      const files = bank[p.sample];
      expect(Array.isArray(files), `${p.sample} is in the bank`).toBe(true);
      expect(PERC_SAMPLES[p.sample].variants, `${p.sample} variants`).toBe((files as string[]).length);
      expect((files as string[])[p.index], `key ${key} = ${p.sample}:${p.index}`).toMatch(expected[Number(key)]);
    }
  });
  it('trims each VCSL sample to its target level without letting any variant clip', () => {
    for (const [sample, bank] of Object.entries(PERC_SAMPLES)) {
      const used = Object.values(PERC_KEYS).filter((p) => p.sample === sample);
      expect(used.length, `${sample} unused`).toBeGreaterThan(0);
      const db = percTrimDb(sample);
      expect(db).toBeGreaterThanOrEqual(0);
      expect(db).toBeLessThanOrEqual(30);
      const target = PERC_TARGET[bank.kind];
      for (const p of used) {
        expect(p.level + db, `${sample} over target`).toBeLessThanOrEqual(target + 0.05);
        expect(p.peak + db, `${sample} clips`).toBeLessThanOrEqual(PERC_PEAK_CEILING + 0.05);
      }
      // The trim is as large as it can be: the loudest variant reaches the target or a peak touches the ceiling.
      const loudest = Math.max(...used.map((p) => p.level + db)), hottest = Math.max(...used.map((p) => p.peak + db));
      expect(Math.abs(loudest - target) < 0.06 || Math.abs(hottest - PERC_PEAK_CEILING) < 0.06, `${sample} under-trimmed`).toBe(true);
      expect(percTrim(sample)).toBeCloseTo(Math.pow(10, db / 20), 1);
    }
    expect(percTrimDb('conga')).toBe(10.1); // the quinto (-24.1 dBFS) to -14
    expect(percTrim('conga')).toBe(3.2);
    expect(percTrimDb('guiro')).toBe(26.5);
    expect(percTrimDb('clave')).toBe(13.8); // 15.1 to the target, but the loud hit's peak binds first
    expect(percTrimDb('woodblock')).toBe(3.2);
  });
});

describe('MT-32 map and instrument families', () => {
  it('maps every MT-32 patch to a General MIDI program of the same instrument', () => {
    expect(MT32_NAMES).toHaveLength(128);
    expect(MT32_TO_GM).toHaveLength(128);
    for (const p of MT32_TO_GM) expect(Number.isInteger(p) && p >= 0 && p < 128).toBe(true);
    expect(MT32_BANK).toBe(127);
    // The patches that made the reviewers wince, and a few landmarks.
    expect(gmLabel(MT32_TO_GM[MT32_NAMES.indexOf('Guitar 1')])).toBe('acoustic guitar nylon');
    expect(gmLabel(MT32_TO_GM[MT32_NAMES.indexOf('Acou Bass 1')])).toBe('acoustic bass');
    expect(gmLabel(MT32_TO_GM[MT32_NAMES.indexOf('Elec Gtr 2')])).toBe('overdriven guitar');
    expect(gmLabel(MT32_TO_GM[MT32_NAMES.indexOf('Str Sect 3')])).toBe('synth strings 1');
    expect(gmLabel(MT32_TO_GM[MT32_NAMES.indexOf('Syn Bass 3')])).toBe('synth bass 1');
    expect(gmLabel(MT32_TO_GM[MT32_NAMES.indexOf('Sax 1')])).toBe('soprano sax');
    expect(gmLabel(MT32_TO_GM[MT32_NAMES.indexOf('Fr Horn 1')])).toBe('french horn');
    expect(gmLabel(MT32_TO_GM[MT32_NAMES.indexOf('Orche Hit')])).toBe('orchestra hit');
    // Every MT-32 patch named after an instrument family lands in that family.
    const expectFamily = (re: RegExp, f: ReturnType<typeof family>) => {
      for (let i = 0; i < 128; i++) if (re.test(MT32_NAMES[i])) expect(family(MT32_TO_GM[i]), MT32_NAMES[i]).toBe(f);
    };
    expectFamily(/Piano|Honkytonk/, 'piano');
    expectFamily(/Org /, 'organ');
    expectFamily(/Guitar|Gtr/, 'guitar');
    expectFamily(/Bass\b|Fretless/, 'bass');
    expectFamily(/Str Sect|Violin|Cello|Contrabass|Harp \d|Pizzicato/, 'strings');
    expectFamily(/Trumpet|Trombone|Fr Horn|Tuba|Brs Sect|Syn Brass/, 'brass');
    expectFamily(/Sax|Clarinet|^Oboe$|Engl Horn|Bassoon/, 'reed');
    expectFamily(/Flute|Piccolo|Recorder|Pan Pipes|Whistle/, 'pipe');
  });
  it('reads instrument families from programs and track names', () => {
    expect(family(0)).toBe('piano');
    expect(family(26)).toBe('guitar');
    expect(family(33)).toBe('bass');
    expect(family(48)).toBe('strings');
    expect(family(52)).toBe('voice');
    expect(family(59)).toBe('brass');
    expect(family(64)).toBe('reed');
    expect(family(73)).toBe('pipe');
    expect(family(81)).toBe('synth');
    expect(family(98)).toBe('fx');
    expect(family(117)).toBe('percussion');
    expect(nameFamily('a guitar')).toBe('guitar');
    expect(nameFamily('#EL.GTR 2')).toBe('guitar');
    expect(nameFamily('#Syn.Bass')).toBe('bass');
    expect(nameFamily('Bass Guitar')).toBe('bass');
    expect(nameFamily('Bass Drum')).toBeUndefined();
    expect(nameFamily('Bassoon')).toBe('reed');
    expect(nameFamily('BASSOON')).toBe('reed');
    expect(nameFamily('Bass Clarinet')).toBe('reed');
    expect(nameFamily('Basse')).toBe('bass');
    expect(nameFamily('Basso')).toBe('bass');
    expect(nameFamily('Strijkers')).toBe('strings');
    expect(nameFamily('#STR SECT3')).toBe('strings');
    expect(nameFamily('Strings')).toBe('strings');
    // A guitar named by its strings is a guitar, not a string section.
    for (const guitar of ['12 String', '12-String Acoustic', '6 String', 'Steel String', 'Nylon String', 'Nyl.Str.G', 'Steel-Str']) expect(nameFamily(guitar), guitar).toBe('guitar');
    expect(nameFamily('Steel Drums')).toBeUndefined();
    expect(nameFamilies('Gtr/Strings')).toEqual(new Set(['guitar', 'strings']));
    expect(nameFamilies('Track 11')).toEqual(new Set());
    expect(nameFamily('Horns')).toBe('brass');
    expect(nameFamily('#A.Piano')).toBe('piano');
    expect(nameFamily('Picolo')).toBeUndefined(); // a misspelling is not evidence
    expect(nameFamily('Lead')).toBeUndefined();
    expect(nameFamily('Track 11')).toBeUndefined();
  });
  it('measures levels on the GM curve and knows what is inaudible', () => {
    expect(mixLevel(0.8, undefined)).toBeCloseTo(0.8, 6);
    expect(mixLevel(0.8, NOMINAL_VOLUME / 2)).toBeCloseTo(0.2, 6);
    expect(mixLevel(0.9, 0.2)).toBeLessThan(AUDIBLE_LEVEL);
    expect(AUDIBLE_LEVEL).toBe(0.08);
  });
  it('keeps a quiet part with a real number of notes, drops a stub at the same level, and tells muted from quiet', () => {
    // Let It Be's "Vocal": CC 7 = 36 and velocity 39% -> level 0.049: below AUDIBLE_LEVEL, but a 367-note part a GM player renders about -30 dB down.
    const quiet = mixLevel(0.39, 36 / 127);
    expect(quiet).toBeGreaterThan(QUIET_LEVEL);
    expect(quiet).toBeLessThan(AUDIBLE_LEVEL);
    expect(isAudible(quiet, 367)).toBe(true);
    expect(isAudible(quiet, REAL_PART_NOTES - 1)).toBe(false);
    expect(isAudible(0.02, 1000)).toBe(false);
    expect(isAudible(AUDIBLE_LEVEL, 1)).toBe(true);
    expect(isMuted(0, 0.8)).toBe(true);
    expect(isMuted(0.5, 1 / 127)).toBe(true);
    expect(isMuted(36 / 127, 0.39)).toBe(false);
    expect(isMuted(undefined, 0.5)).toBe(false);
  });
  it('names the guitar behind a guitar model or an overdrive, but not an overdriven synth', () => {
    for (const name of ['Les Paul', 'Les Paul 2', 'Overdrive Guitar', 'Strat', 'Telecaster', 'Fuzz', 'Distortion', 'overdriv']) expect(nameFamily(name), name).toBe('guitar');
    expect(nameFamily('Dist Synth')).toBeUndefined();
    expect(nameFamily('Overdrive Organ')).toBe('organ');
    expect(nameFamily('Overdrive Bass')).toBe('bass');
  });
  it('tells a name that fits its patch from one that contradicts it', () => {
    // The patch's own name, its family, a name that mentions the family among others.
    expect(nameFitsPatch('Banjo', 105)).toBe(true);
    expect(nameFitsPatch('Fiddle', 110)).toBe(true);
    expect(nameFitsPatch('Bass&Lead', 87)).toBe(true);
    expect(nameFitsPatch('Steel String', 25)).toBe(true);
    expect(nameFitsPatch('Piano/Guitar', 0)).toBe(true);
    expect(nameFitsPatch('Gtr/String', 48)).toBe(true);
    // Families that stand in for each other: horns on saxes, a mandolin on a banjo, bells on a tinkle bell.
    expect(nameFitsPatch('Horns', 66)).toBe(true);
    expect(nameFitsPatch('Sax', 61)).toBe(true);
    expect(nameFitsPatch('Mandolin', 105)).toBe(true);
    expect(nameFitsPatch('Bells', 112)).toBe(true);
    // A synth asked for on a synth patch.
    expect(nameFitsPatch('Guitar Pad', 89)).toBe(true);
    expect(nameFitsPatch('Synth Strings', 88)).toBe(true);
    expect(nameFitsPatch('Syn Bass', 87)).toBe(true);
    // Contradictions.
    expect(nameFitsPatch('ORGAN - MELODY', 0)).toBe(false);
    expect(nameFitsPatch('Guitar', 0)).toBe(false);
    expect(nameFitsPatch('Electric Guitar 4', 84)).toBe(false);
    expect(nameFitsPatch('Bass', 27)).toBe(false);
    expect(nameFitsPatch('Strings', 52)).toBe(false);
    expect(nameFitsPatch('12 String', 0)).toBe(false);
    // Names with no family say nothing either way.
    expect(nameFitsPatch('Lead', 81)).toBe(false);
    expect(nameFitsPatch('', 0)).toBe(false);
  });
  it('knows where a bass stops and what plays above it', () => {
    expect(BASS_PATCH_TOP).toBe(67); // G4, the last fret of the G string
    expect(GM_NAMES[87]).toBe(BASS_LEAD_SOUND);
  });
  it('picks the family patch a track name asks for', () => {
    expect(programForName('Overdrive Guitar', 'guitar')).toBe(29);
    expect(programForName('Les Paul 2', 'guitar')).toBe(29);
    expect(programForName('Distortion Gtr', 'guitar')).toBe(30);
    expect(programForName('Nylon Guitar', 'guitar')).toBe(24);
    expect(programForName('Guitar', 'guitar')).toBe(27);
    expect(programForName('Slap Bass', 'bass')).toBe(36);
    expect(programForName('Synth Bass 3', 'bass')).toBe(38);
    expect(programForName('Bass', 'bass')).toBe(33);
    expect(programForName('Rhodes', 'piano')).toBe(4);
    expect(programForName('Piano', 'piano')).toBe(0);
    expect(programForName('Church Organ', 'organ')).toBe(19);
    expect(programForName('Cello', 'strings')).toBe(42);
    expect(programForName('Strings', 'strings')).toBe(48);
    expect(programForName('Trumpet', 'brass')).toBe(56);
    expect(programForName('Horns', 'brass')).toBe(61);
    expect(programForName('Tenor Sax', 'reed')).toBe(66);
    expect(programForName('Flute', 'pipe')).toBe(73);
    expect(programForName('Vibes', 'mallet')).toBe(11);
    for (const f of DEFINITE_FAMILIES) expect(family(programForName('x', f)), f).toBe(f);
  });
});

describe('track names against the patch tables', () => {
  it('lists the 128 General MIDI instrument names in step with the soundfont labels', () => {
    expect(GM_INSTRUMENTS).toHaveLength(128);
    for (let p = 0; p < 128; p++) expect(nameSaysPatch(GM_INSTRUMENTS[p], GM_INSTRUMENTS[p]), GM_INSTRUMENTS[p]).toBe(true);
    // The soundfont labels are the instrument names (with the same first word) except the four pianos that share one font.
    // (23 is the tango accordion, whose soundfont is called bandoneon.)
    for (let p = 6; p < 128; p++) if (p !== 23 && !/^(lead|pad|fx)/i.test(GM_INSTRUMENTS[p])) expect(nameWords(gmLabel(p))[0], `${p}`).toBe(nameWords(GM_INSTRUMENTS[p])[0]);
    expect(nameSaysPatch('Electric Piano', GM_INSTRUMENTS[4])).toBe(true);
  });
  it('splits names into instrument words, spelling abbreviations out', () => {
    expect(nameWords('AcouPno2')).toEqual(['acoustic', 'piano']);
    expect(nameWords('AcBass2')).toEqual(['acoustic', 'bass']);
    expect(nameWords('Elec Gtr 1')).toEqual(['electric', 'guitar']);
    expect(nameWords('Str Sect 3')).toEqual(['string', 'section']);
    expect(nameWords('E.PIANO 1')).toEqual(['piano']); // a single letter says nothing
    expect(nameWords('Sq Wave')).toEqual(['square', 'wave']);
  });
  it('reads a track name as a patch name, abbreviation-tolerant, numbers ignored', () => {
    const says = (name: string, patch: string) => nameSaysPatch(name, patch);
    expect(says('Sq Wave', 'Square Wave')).toBe(true);
    expect(says('Doc Solo', 'Doctor Solo')).toBe(true);
    expect(says('El Guitar', 'Elec Gtr 2')).toBe(true);
    expect(says('Elec Guit', 'Elec Gtr 2')).toBe(true);
    expect(says('AcBass2', 'Acou Bass 2')).toBe(true);
    expect(says('Organ', 'Elec Org 1')).toBe(true);
    expect(says('Bass', 'Acou Bass 1')).toBe(true);
    expect(says('Brass', 'Brs Sect 1')).toBe(true);
    expect(says('Fr Horn', 'Fr Horn 1')).toBe(true);
    expect(says('Warm Bells', 'Warm Bell')).toBe(true);
    expect(says('Vibes', 'Vibe 1')).toBe(true);
    expect(says('Acoustic Piano 3', 'Acoustic Grand Piano')).toBe(true);
    expect(says('Snare Drum', 'Taiko Drum')).toBe(false); // nothing says snare
    expect(says('Strijkers', 'Str Sect 1')).toBe(false); // not an abbreviation of "string"
    expect(says('Synth', 'Syn Brass 1')).toBe(false); // a generic word names nothing
    expect(says('Lead 2', 'Lead 2 (sawtooth)')).toBe(false);
    expect(says('', 'Flute 1')).toBe(false);
    expect(says('Rhythm&SE', 'Acou Piano 1')).toBe(false);
  });
  it('tells which table a named channel fits, and stays neutral when both or neither do', () => {
    expect(tableForName('Doc Solo', 44)).toBe('mt32'); // GM: tremolo strings
    expect(tableForName('El Guitar', 62)).toBe('mt32'); // GM: synth brass 1
    expect(tableForName('violin1', 52)).toBe('mt32'); // GM: choir aahs
    expect(tableForName('Bass', 33)).toBe('gm'); // MT-32: Harmo Pan
    expect(tableForName('Trumpet', 56)).toBe('gm'); // MT-32: Contrabass
    expect(tableForName('Flute', 73)).toBeUndefined(); // Flute 2 and Flute: both
    expect(tableForName('E.PIANO 1', 4)).toBeUndefined(); // Elec Piano 2 and Electric Piano 1: both
    expect(tableForName('Acoustic Piano', 0)).toBeUndefined();
    expect(tableForName('Str etc.', 50)).toBeUndefined();
    expect(tableForName('Snare Drum', 116)).toBeUndefined(); // neither
    expect(tableForName('', 44)).toBeUndefined();
  });
});
