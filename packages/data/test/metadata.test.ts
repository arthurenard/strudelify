import { describe, it, expect } from 'vitest';
import { cleanArtist, cleanTitle, repairText, usableName } from '../src/metadata.js';

describe('imported score metadata', () => {
  it('keeps the composer or performer out of a credit block', () => {
    // Artist fields as PDMX has them, and who the catalogue should name.
    const cases: [string, string][] = [
      ['Composed by Joe Hisaishi Transcribed & Arranged by Andrea Tam', 'Joe Hisaishi'],
      ['Comp. by Malcolm ArnoldArr. for Concert Band by John PaynterArr. for Clarinet Choir by Ben Curry', 'Malcolm Arnold'],
      ['Black Eyed Peas ft. Ozuna J. Rey SoulArr. for marching band: Mattia de Monti', 'Black Eyed Peas ft. Ozuna J. Rey Soul'],
      ['Lyrics by Matthew BellamyMusic by Matthew Bellamy Chris Wolstenholme & Dominic Howard', 'Matthew Bellamy Chris Wolstenholme & Dominic Howard'],
      ['Antonis_GreekOriginal Composer: Franz Liszt - Niccolò Paganini', 'Franz Liszt - Niccolò Paganini'],
      ['Original Words and Music By: John Fogerty As Performed By: Elvis Presley', 'John Fogerty'],
      ['Improvised by Tom Brierfeaturing Frederick HodgesTranscribed by mlololoer', 'Tom Brier'],
      ['IMAGINE DRAGONSTranscripted by:StarWarrior7567', 'IMAGINE DRAGONS'],
      ["Guns N' Roses Arr. Reece Watson", "Guns N' Roses"],
      ['Claude Debussy (arr. Pierre Boulez 1954)', 'Claude Debussy'],
      ['Björk (1965 -)arr. Blane Zhu', 'Björk'],
      ['Antonio Vivaldi (1678-1741)', 'Antonio Vivaldi'],
      ['AARON COPLAND 1942', 'AARON COPLAND'],
      ['Musescore transcription by J. Wilson 6/21/2013Updated to Musescore 3.6 10/7/2021', 'J. Wilson'],
      ['Transcripción: Marco. A. Duarte marcoduarte80protonmail.com', 'Marco. A. Duarte'],
    ];
    for (const [raw, name] of cases) expect(cleanArtist(raw), raw).toBe(name);
  });
  it('names the arranger when the field credits nobody else', () => {
    expect(cleanArtist('Arr. by Alex Snyder')).toBe('Alex Snyder');
    expect(cleanArtist('Adp.: Tiago H.')).toBe('Tiago H.');
    expect(cleanArtist('åæä¼arr. by Lee-Daniel Tran')).toBe('Lee-Daniel Tran');
  });
  it('leaves ordinary names alone, including ones that contain a credit word', () => {
    for (const name of ['The Beatles', 'Arrested Development', 'Edith Piaf', 'Transvision Vamp', 'Grover Washington Jr.', 'Josiah Von Duhlstine', 'from the musical Chicago', 'Sergei Rachmaninoff']) expect(cleanArtist(name), name).toBe(name);
  });
  it('rejects fields that name nobody', () => {
    for (const raw of ['ª', 'Arr', 'Composer', 'band arr.', '', ' - ']) expect(cleanArtist(raw), raw).toBe('');
  });
  it('re-reads text decoded with the wrong character set, and rejects what cannot be restored', () => {
    expect(repairText('Antonín DvoÅ\u0099ák')).toBe('Antonín Dvořák');
    expect(repairText('CafÃ©')).toBe('Café');
    expect(repairText('Ångström')).toBe('Ångström');
    // Continuation bytes already lost: a Japanese title reduced to Latin-1 letters.
    expect(usableName('ãã')).toBe(false);
    expect(usableName('æåãææ')).toBe(false);
    expect(usableName('Björk')).toBe(true);
    expect(usableName('Æon')).toBe(true);
    expect(usableName('東京')).toBe(true);
    expect(cleanTitle('ª -')).toBe('');
    expect(cleanTitle('  Hey   Jude ')).toBe('Hey Jude');
  });
});
