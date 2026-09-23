/**
 * Titles and artists of imported scores (PDMX) as a catalogue can show them. Score sites leave the
 * artist field to the uploader, who often writes the whole credit block there ("Composed by Joe
 * Hisaishi Transcribed & Arranged by Andrea Tam"), runs lines together ("Malcolm ArnoldArr. for
 * Concert Band"), adds life dates, an e-mail address or a web link, or the text was decoded with
 * the wrong character set ("DvoÅ\u0099ák" for "Dvořák"). `cleanArtist` keeps the composer or
 * performer; `usableName` rejects what cannot name anything.
 */

/** A UTF-8 sequence read as Latin-1: a lead byte (U+00C2-U+00F4) followed by its continuation bytes (U+0080-U+00BF). */
const UTF8_AS_LATIN1 = /[\u00c2-\u00df][\u0080-\u00bf]|[\u00e0-\u00ef][\u0080-\u00bf]{2}|[\u00f0-\u00f4][\u0080-\u00bf]{3}/g;

/** Text partly decoded with the wrong character set, each misread UTF-8 sequence re-read; the rest unchanged. */
export function repairText(s: string): string {
  return s.replace(UTF8_AS_LATIN1, (seq) => {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(seq, (c) => c.charCodeAt(0))); } catch { return seq; }
  });
}

/**
 * Whether text can name a song or an artist: at least two letters or digits, no undecodable
 * characters, and not mostly the Latin-1 letters that a misread UTF-8 text leaves behind once its
 * continuation bytes are lost ("ãã" for a Japanese title).
 */
export function usableName(s: string): boolean {
  const t = s.normalize('NFKC');
  if (/[\ufffd\u0080-\u009f]/.test(t) || new RegExp(UTF8_AS_LATIN1.source).test(t)) return false;
  const letters = t.match(/[\p{L}\p{N}]/gu) ?? [];
  if (letters.length < 2) return false;
  const latin1 = letters.filter((c) => c >= '\u00c0' && c <= '\u00ff').length;
  return !(latin1 >= 2 && latin1 * 2 > letters.length);
}

/** Credits for someone other than the composer or performer: from here on, the field names an arranger, a transcriber, an editor... */
const OTHER = String.raw`(?:musescore\s+transcri\p{L}*|arr(?:angement|anged|angé|enged|gt)?\b\.?|arrang\s?ed|anrrenged|adp\b\.?|orch\b\.?|transcri\p{L}*|transposed|edited|double-checked|updated|produzida|piano arrangement|band arrangement|full playthrough|source:|some rhythms|featuring|sung by|version by|lyrics by|words by|tabs by)`;
/** Phrases that introduce the composer or the performer. */
const MUSIC = String.raw`(?:original words and music by|words and music by|music by|original (?:composition |piece )?by|song by|tune:|composed by|composed|composer|compositeur|comp\.(?:\s*by)?|composta por|wr?itten by|as performed by|performed by|improvised by|^by|by:)`;
/** Keywords of a credit line run into the previous one: "C418Arranged by", "Foxarranged by", "BrierFeaturing". */
const GLUED = /(?<=[\p{L}\d.)])(?=(?:Arr|Arranged|Arrangement|Orch|Transcri\p{L}*|Performed|Edited|Version|Piano arrangement|Music by|Full playthrough|Some rhythms|Double-checked|Updated)\b|(?:arranged by|arr\. by|arr\.|featuring|transcribed by)\b)/gu;
/** Words that stand where a name should be: an ensemble or a role, not who wrote or played the music. */
const PLACEHOLDER = /^(?:band|piano|orchestra|choir|ensemble|guitar|violin|composer|arranger|various|n\/?a)$/i;
/** Abbreviations whose full stop is part of the name ("Grover Washington Jr.", "Tiago H."). */
const KEEPS_STOP = /(?:\b\p{L}{1,2}|\bjr|\bsr|\bst|\bmr|\bdr)\.$/iu;

/**
 * The composer or performer named by an artist field. Credit lines run together are split; e-mail
 * addresses, links, dates, life dates and parenthesised credits are dropped. A "Music by X" credit
 * (the last one naming the music, so the composer after a lyricist) wins; else what precedes the
 * first other credit ("Ludwig van Beethoven Arranged for clarinet" is Ludwig van Beethoven); else,
 * when the field only credits an arranger or a transcriber, that person. Returns '' when nothing
 * usable remains.
 */
export function cleanArtist(raw: string): string {
  const s = repairText(raw)
    // "from Koji Kondo": case matters, so not in `MUSIC` ("from the musical Chicago" keeps its words).
    .replace(/^from\s+(?=\p{Lu})/u, '')
    // Addresses, including those whose "@" the source already lost ("marcoduarte80protonmail.com").
    .replace(/\S+@\S+|\S*(?:gmail|protonmail|hotmail|yahoo|outlook|umail)\.\S+|https?:\S*|www\.\S+|\S+\.(?:com|net|org|edu)\b\S*/gi, ' ')
    .replace(/\s*\([^()]*\b(?:arr|transcri|edited|version)[^()]*\)/gi, ' ')
    .replace(GLUED, ' ')
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const other = new RegExp(String.raw`\s*(?:\bfor\s+)?(?:[-–—,;/]\s*)?\b${OTHER}.*$`, 'iu');
  const music = [...s.matchAll(new RegExp(String.raw`(?:\b|^)${MUSIC}\s*[.:;]?\s*`, 'giu'))];
  let name: string;
  if (music.length) {
    // The credit naming the music itself wins over a performer's; among equals, the last one.
    const composer = music.filter((m) => /music|compos|comp\.|original|song|tune/i.test(m[0]));
    const pick = composer.length ? composer[composer.length - 1] : music[0];
    name = s.slice(pick.index! + pick[0].length).replace(other, '').replace(new RegExp(String.raw`\s*\b${MUSIC}.*$`, 'iu'), '');
    // A name before the first credit phrase is the artist ("Black Eyed Peas ft. Ozuna ... Arr. by").
    const lead = s.slice(0, music[0].index).replace(other, '').trim();
    if (!composer.length && usableName(lead)) name = lead;
  } else {
    name = s.replace(other, '');
    // Nothing usable before the first other credit ("Arr. by Alex Snyder", "Adp.: Tiago H.", a garbled
    // name then "arr. by Lee-Daniel Tran"): the arranger or transcriber it names is who to name.
    const credit = new RegExp(String.raw`\b${OTHER}(?:\s*by)?\s*[.:;]?\s*`, 'iu').exec(s);
    if (!usableName(name) && credit) name = s.slice(credit.index + credit[0].length).replace(other, '');
  }
  name = name
    .replace(/\s*\([^()]*\d[^()]*\)?/g, ' ') // life dates, a catalogue number: "(1803-1856)", "(BWV 1080)"
    .replace(/\s+(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|janv|févr|avr|mai|juin|juil|août|déc)\p{L}*\.?\s+)?\d{4}$/iu, '') // a trailing date: "1942", "mai 2012"
    .replace(/[\s,;:/\-–—]+$/, '')
    .replace(/^[\s,;:/.\-–—]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (name.endsWith('.') && !KEEPS_STOP.test(name)) name = name.slice(0, -1);
  return usableName(name) && !PLACEHOLDER.test(name) ? name : '';
}

/** A title fit to show: repaired, whitespace collapsed; '' when it cannot name a song. */
export function cleanTitle(raw: string): string {
  const s = repairText(raw).replace(/\s+/g, ' ').trim();
  return usableName(s) ? s : '';
}
