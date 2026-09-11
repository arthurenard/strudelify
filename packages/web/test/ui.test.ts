import { describe, it, expect } from 'vitest';
import { chordSummary, type IndexEntry } from '@strudelify/core';
import {
  esc, fmt, hashHue, fallbackTint, initial, queryTokens, highlight, buildArtistIndex, byPopularity,
  chordBlocks, sectionColor, dominantHsl, prettyChord, chordVariants, chordHue, fitLabel, barCapOptions, ALL_BARS, rulerStep, titleSize,
  artistMatch, queryLooksLikeTitle,
  displayArtist, tidyHits, flatName, spellTonic, prefersFlats, keyName, structureSections, albumLine, idWords, timelineWidth, followScroll,
  chordFamily, chordPhrases, structureChords, sectionAbbr, sectionAbbrs, highlightTokens,
  respellChordLine, respellKeyLine, replaceChordLine, midiKey, chartShift, shiftTonic,
  partList, deriveForm, isFormLabel, formColor, packPhrases, leadName, cycleLabels, canonicalArtists, setArtistAliases, songTint, type PhraseItem,
} from '../src/ui.js';

const entry = (id: string, title: string, artist: string, popularity = 0): IndexEntry =>
  ({ id, title, artist, sources: ['midi'], popularity, files: { midi: `songs/${id}.mid` } });

describe('formatting helpers', () => {
  it('escapes html', () => {
    expect(esc('<b>"A" & B</b>')).toBe('&lt;b&gt;&quot;A&quot; &amp; B&lt;/b&gt;');
  });
  it('formats m:ss', () => {
    expect(fmt(0)).toBe('0:00');
    expect(fmt(59.6)).toBe('1:00');
    expect(fmt(262)).toBe('4:22');
    expect(fmt(-3)).toBe('0:00');
  });
  it('hashes titles to a stable hue', () => {
    expect(hashHue('Smells Like Teen Spirit')).toBe(hashHue('Smells Like Teen Spirit'));
    expect(hashHue('a')).not.toBe(hashHue('b'));
    for (const s of ['', 'x', 'The Joker', 'ü']) { const h = hashHue(s); expect(h).toBeGreaterThanOrEqual(0); expect(h).toBeLessThan(360); }
    // The palette is twelve hues in two weights, so a tint is one of those two tones and never varies for a name.
    expect(fallbackTint('x')).toMatch(/^hsl\(\d+ (52% 40%|58% 48%)\)$/);
    expect(fallbackTint('x')).toBe(fallbackTint('x'));
  });
  it('picks an initial for the fallback tile', () => {
    expect(initial("I Don't Mind")).toBe('I');
    expect(initial('(You Make Me Feel Like) A Natural Woman')).toBe('Y');
    expect(initial('...')).toBe('♪');
  });
});

describe('search rendering', () => {
  it('tokenises queries like the search index does', () => {
    expect(queryTokens('The Joker!')).toEqual(['the', 'joker']);
    expect(queryTokens('hello,  World!')).toEqual(['hello', 'world']);
    expect(queryTokens('')).toEqual([]);
  });
  it('highlights every token case-insensitively at word starts and escapes the rest', () => {
    expect(highlight('Smells Like Teen Spirit', ['teen', 'sm'])).toBe('<mark>Sm</mark>ells Like <mark>Teen</mark> Spirit');
    expect(highlight('R&B <mix>', ['mix'])).toBe('R&amp;B &lt;<mark>mix</mark>&gt;');
    expect(highlight('plain', [])).toBe('plain');
    // Regex specials are escaped: "." only matches a literal dot, not "x".
    expect(highlight('axb', ['.'])).toBe('axb');
    expect(highlight('a.b', ['a.b'])).toBe('<mark>a.b</mark>');
    // Only word starts: "the" never lights up the middle of "Together", "love" does start "Lovely".
    expect(highlight('Come Together', ['the'])).toBe('Come Together');
    expect(highlight('Lovely Day', ['love'])).toBe('<mark>Love</mark>ly Day');
    expect(highlight("Rock'n'Roll", ['roll'])).toBe("Rock'n'<mark>Roll</mark>");
  });
  it('drops stop-words from the highlight tokens but not from the search', () => {
    expect(highlightTokens('the beatles')).toEqual(['beatles']);
    expect(highlightTokens('Let It Be')).toEqual(['let', 'be']);
    expect(queryTokens('the beatles')).toEqual(['the', 'beatles']);
  });
});

describe('artist grouping', () => {
  const entries = [
    entry('the-beatles--help', 'Help!', 'The Beatles', 5),
    entry('the-beatles--let-it-be', 'Let It Be', 'The Beatles', 9),
    entry('the-beatles--yesterday', 'Yesterday', 'The Beatles', 9),
    entry('beatlejuice--x', 'X', 'Beatlejuice', 1),
    entry('nirvana--lithium', 'Lithium', 'Nirvana', 8),
    entry('nirvana--blew', 'Blew', 'Nirvana', 2),
    entry('solo--one', 'One', 'Solo Artist', 3),
  ];
  const artists = buildArtistIndex(entries);
  const artistFor = (q: string) => artistMatch(q, artists)?.group ?? null;
  it('groups by normalised artist', () => {
    expect(artists.get('the beatles')?.entries).toHaveLength(3);
    expect(artists.get('nirvana')?.name).toBe('Nirvana');
  });
  it('matches exact, "the "-prefixed and prefix queries', () => {
    expect(artistFor('beatles')?.name).toBe('The Beatles');
    expect(artistFor('The Beatles')?.name).toBe('The Beatles');
    expect(artistFor('beat')?.name).toBe('The Beatles'); // largest matching group wins
    expect(artistFor('nirv')?.name).toBe('Nirvana');
  });
  it('ignores short queries, titles and single-song artists', () => {
    expect(artistFor('ni')).toBeNull();
    expect(artistFor('lithium')).toBeNull();
    expect(artistFor('solo artist')).toBeNull();
  });
  it('needs a prefix to cover at least half of the name, and prefers an exact name over a bigger prefix group', () => {
    const more = buildArtistIndex([
      ...entries,
      entry('loverboy--a', 'Working for the Weekend', 'Loverboy', 4), entry('loverboy--b', 'The Kid Is Hot Tonight', 'Loverboy', 3),
      entry('loverboy--c', 'Hot Girls in Love', 'Loverboy', 2), entry('loverboy--d', 'This Could Be the Night', 'Loverboy', 1),
      entry('love--x', 'Alone Again Or', 'Love', 2), entry('love--y', 'Seven and Seven Is', 'Love', 1),
      entry('the-lovin-spoonful--x', 'Daydream', "The Lovin' Spoonful", 2), entry('the-lovin-spoonful--y', 'Summer in the City', "The Lovin' Spoonful", 2),
    ]);
    expect(artistMatch('love', more)).toEqual({ group: more.get('love'), exact: true }); // Love (2 songs) beats Loverboy (4) and Lovin' Spoonful
    expect(artistMatch('lover', more)).toEqual({ group: more.get('loverboy'), exact: false });
    expect(artistMatch('lov', more)).toBeNull();
    expect(artistMatch('beat', artists)).toEqual({ group: artists.get('the beatles'), exact: false });
    expect(artistMatch('bea', artists)).toBeNull();
    expect(artistMatch('the beatles', artists)?.exact).toBe(true);
    expect(artistMatch('beatles', artists)?.exact).toBe(true);
  });
  it('tells a title query from an artist query by the hits', () => {
    const hits = [{ title: 'Love' }, { title: 'Love Me Do' }, { title: 'L-O-V-E' }, { title: "Don't Let Go (Love)" }, { title: 'Lovely Day' }];
    expect(queryLooksLikeTitle('love', hits)).toBe(true);
    expect(queryLooksLikeTitle('lovely', hits)).toBe(false); // one hit only
    expect(queryLooksLikeTitle('nirv', [{ title: 'Lithium' }, { title: 'Blew' }])).toBe(false);
    expect(queryLooksLikeTitle('', hits)).toBe(false);
  });
  it('sorts by popularity then title', () => {
    expect(byPopularity(artists.get('the beatles')!.entries).map((e) => e.title)).toEqual(['Let It Be', 'Yesterday', 'Help!']);
  });
});

describe('timeline helpers', () => {
  it('merges consecutive equal chords into blocks', () => {
    expect(chordBlocks(['C', 'C', 'G', null, null, 'C'])).toEqual([
      { start: 0, end: 1, label: 'C' }, { start: 2, end: 2, label: 'G' }, { start: 3, end: 4, label: null }, { start: 5, end: 5, label: 'C' },
    ]);
    expect(chordBlocks([])).toEqual([]);
  });
  it('colours sections by keyword', () => {
    expect(sectionColor('Chorus')).toBe('#ff9fb4');
    expect(sectionColor('pre-chorus')).toBe('#ffd591');
    expect(sectionColor('verse 2')).toBe('#8fe3c2');
    expect(sectionColor('something else')).toBe('#b6c8d9');
  });
});

describe('dominant colour', () => {
  const px = (...rgb: number[][]) => new Uint8ClampedArray(rgb.flatMap(([r, g, b]) => [r, g, b, 255]));
  it('returns null for greyscale or empty images', () => {
    expect(dominantHsl(px([0, 0, 0], [128, 128, 128], [255, 255, 255]))).toBeNull();
    expect(dominantHsl(new Uint8ClampedArray(0))).toBeNull();
  });
  it('finds the dominant vivid hue and clamps lightness/saturation into a usable range', () => {
    const red = dominantHsl(px([220, 30, 30], [200, 40, 40], [30, 30, 220]));
    expect(red).toMatch(/^hsl\(\d+ \d+% \d+%\)$/);
    const [h, s, l] = red!.match(/\d+/g)!.map(Number);
    expect(h < 15 || h > 345).toBe(true);
    expect(s).toBeGreaterThanOrEqual(38); expect(s).toBeLessThanOrEqual(78);
    expect(l).toBeGreaterThanOrEqual(30); expect(l).toBeLessThanOrEqual(48);
    const blue = dominantHsl(px([30, 30, 220], [40, 40, 230], [220, 30, 30]));
    expect(Number(blue!.match(/\d+/)![0])).toBeGreaterThan(200);
  });
});

describe('fuzzy highlight', () => {
  it('falls back to the longest matching prefix (≥ 3 chars) for fuzzy hits', () => {
    expect(highlight('Grandpa Spells', ['smells'])).toBe('Grandpa Spells'); // no prefix ≥ 3 in common
    expect(highlight('Teenage Riot', ['teens'])).toBe('<mark>Teen</mark>age Riot');
    expect(highlight('Sanctuary', ['sancturay'])).toBe('<mark>Sanctu</mark>ary');
  });
});

describe('chord display', () => {
  it('pretty-prints Strudel chord symbols', () => {
    expect(prettyChord('A#^7/A')).toBe('A♯maj7/A');
    expect(prettyChord('G^')).toBe('Gmaj7');
    expect(prettyChord('C^9')).toBe('Cmaj9');
    expect(prettyChord('Bbm7b5')).toBe('B♭m7b5');
    expect(prettyChord('F/Bb')).toBe('F/B♭');
    expect(prettyChord('Dm')).toBe('Dm');
    expect(prettyChord('N')).toBe('N');
  });
});

describe('timeline layout', () => {
  it('abbreviates chord labels from the bass note inwards', () => {
    expect(chordVariants('B♭maj7/A')).toEqual(['B♭maj7/A', 'B♭maj7', 'B♭']);
    expect(chordVariants('Dsus4/A')).toEqual(['Dsus4/A', 'Dsus4', 'D']);
    expect(chordVariants('F♯m7')).toEqual(['F♯m7', 'F♯m']); // minor survives: never "F♯" for a minor chord
    expect(chordVariants('Dm')).toEqual(['Dm']);
    expect(chordVariants('G')).toEqual(['G']);
    expect(chordVariants('N')).toEqual(['N']);
  });
  it('colours chords by root on the circle of fifths', () => {
    expect(chordHue('C')).toBe(200);
    expect(chordHue('G7')).toBe(230);
    expect(chordHue('Dm/F')).toBe(260);
    expect(chordHue('F')).toBe(170);
    expect(chordHue('A#^7/A')).toBe(chordHue('Bb'));
    expect(chordHue('N')).toBeNull();
    expect(chordHue('')).toBeNull();
  });
  it('fits the widest label that stays inside its own block, or none', () => {
    const measure = (t: string) => t.length * 7;
    const v = chordVariants('B♭maj7/A'); // widths 56, 42, 14 (+ 8 padding)
    expect(v).toEqual(['B♭maj7/A', 'B♭maj7', 'B♭']);
    expect(fitLabel(v, 70, measure)).toBe('B♭maj7/A');
    expect(fitLabel(v, 60, measure)).toBe('B♭maj7');
    expect(fitLabel(v, 30, measure)).toBe('B♭');
    expect(fitLabel(v, 12, measure)).toBeNull(); // a 1-bar block at 6px/bar shows nothing rather than spilling over
    expect(fitLabel(v, 64, measure, 0)).toBe('B♭maj7/A');
    expect(fitLabel([], 100, measure)).toBeNull();
  });
  it('offers only bar caps that cut the song, plus "All", defaulting to 200 or the whole song', () => {
    expect(barCapOptions(151)).toEqual({ options: [16, 32, 64, 128].map((c) => ({ value: c, label: `First ${c} bars` })).concat({ value: ALL_BARS, label: 'All 151 bars' }), value: ALL_BARS });
    const long = barCapOptions(312);
    expect(long.options.map((o) => o.value)).toEqual([16, 32, 64, 128, 200, ALL_BARS]);
    expect(long.value).toBe(200);
    expect(barCapOptions(12)).toEqual({ options: [{ value: ALL_BARS, label: 'All 12 bars' }], value: ALL_BARS });
    expect(barCapOptions(0).options).toEqual([{ value: ALL_BARS, label: 'All bars' }]);
  });
  it('labels the caps in the song\'s own bars when the metre is not 4/4', () => {
    // A cap is a length in beats (bars of 4/4): in 2/4 it keeps twice as many bars, so a 212-bar song is not cut by "200".
    const twoFour = barCapOptions(212, 2);
    expect(twoFour.options.map((o) => o.label)).toEqual(['First 32 bars', 'First 64 bars', 'First 128 bars', 'All 212 bars']);
    expect(twoFour.options.map((o) => o.value)).toEqual([16, 32, 64, ALL_BARS]);
    expect(twoFour.value).toBe(ALL_BARS);
    // 6/8 (three quarter notes per bar): 200 bars of 4/4 keep 267 bars, and the default still applies when the song is longer.
    const sixEight = barCapOptions(300, 3);
    expect(sixEight.options.find((o) => o.value === 200)?.label).toBe('First 267 bars');
    expect(sixEight.value).toBe(200);
    // 3/4 is plain: 16 bars of 4/4 are 21 bars of 3/4, all of them under a 40-bar song.
    expect(barCapOptions(40, 3).options.map((o) => o.label)).toEqual(['First 21 bars', 'All 40 bars']);
  });
  it('picks a ruler step that keeps ticks apart', () => {
    expect(rulerStep(10)).toBe(8);
    expect(rulerStep(50)).toBe(1);
    expect(rulerStep(1.8)).toBe(32);
    expect(rulerStep(0.01)).toBe(512);
  });
  it('buckets hero title sizes by length', () => {
    expect(titleSize('The Joker')).toBe('lg');
    expect(titleSize('Another Brick in the Wall, Part 2')).toBe('md');
    expect(titleSize('Cygnus X-1 Book II: Hemispheres: I. Prelude / II. Apollo Bringer of Wisdom')).toBe('sm');
  });
});

describe('artist canonicalisation', () => {
  const src = (id: string, title: string, artist: string, sources: IndexEntry['sources'] = ['midi']): IndexEntry => ({ ...entry(id, title, artist), sources });
  const aliases = canonicalArtists([
    src('abba--1', 'Fernando', 'Abba'), src('abba--2', 'Dancing Queen', 'ABBA'), src('abba--3', 'Waterloo', 'ABBA'),
    src('nat--1', 'Mona Lisa', 'Nat "King" Cole'), src('nat--2', 'Unforgettable', 'Nat King Cole'), src('nat--3', 'Smile', 'Nat King Cole'),
    // the curated chart spells it First Last; the MIDI set has more files but surname first
    src('mj--1', 'Billie Jean', 'Michael Jackson', ['mcgill']), src('mj--2', 'Thriller', 'Jackson Michael'), src('mj--3', 'Bad', 'Jackson Michael'), src('mj--4', 'Off the Wall', 'Jackson Michael'),
    // the comma form names the given name, and merges with the plain spelling
    src('amos--1', 'China', 'Amos, Tori'), src('amos--2', 'Crucify', 'Amos, Tori'), src('amos--3', 'Winter', 'Tori Amos'),
    // an all-caps spelling is the surname-first convention
    src('bowie--1', 'Heroes', 'BOWIE DAVID'), src('bowie--2', 'Fame', 'BOWIE DAVID'), src('bowie--3', 'Let\'s Dance', 'David Bowie'),
    // no evidence but a first word that is a confirmed given name elsewhere
    src('mp--1', 'Songbird', 'Michael Pesch'), src('mp--2', 'Mist', 'Pesch Michael'), src('mp--3', 'Dawn', 'Pesch Michael'),
    // nothing to go on: the larger side wins
    src('x--1', 'Aa', 'Venditti Antonello'), src('x--2', 'Bb', 'Antonello Venditti'), src('x--3', 'Cc', 'Antonello Venditti'),
    src('band--1', 'The Joker', 'Steve Miller Band'),
  ]);
  it('merges case and punctuation variants on the majority spelling', () => {
    expect(aliases.get('abba')).toBe('ABBA');
    expect(aliases.get('nat king cole')).toBe('Nat King Cole');
    expect(aliases.has('steve miller band')).toBe(false);
  });
  it('turns surname-first names round on the evidence: McGill, the comma form, all caps, a known given name, then size', () => {
    expect(aliases.get('jackson michael')).toBe('Michael Jackson');
    expect(aliases.has('michael jackson')).toBe(false);
    expect(aliases.get('bowie david')).toBe('David Bowie');
    expect(aliases.get('pesch michael')).toBe('Michael Pesch');
    expect(aliases.get('venditti antonello')).toBe('Antonello Venditti');
  });
  it('is what displayArtist answers once installed', () => {
    setArtistAliases(aliases);
    try {
      expect(displayArtist('Jackson Michael')).toBe('Michael Jackson');
      expect(displayArtist('Abba')).toBe('ABBA');
      expect(displayArtist('Amos, Tori')).toBe('Tori Amos');
      expect(displayArtist('BOWIE DAVID')).toBe('David Bowie');
      expect(displayArtist('Steve Miller Band')).toBe('Steve Miller Band');
      // and the groups and the duplicate rows follow
      expect(buildArtistIndex([src('a', 'Billie Jean', 'Michael Jackson'), src('b', 'Bad', 'Jackson Michael')]).size).toBe(1);
      expect(tidyHits([src('a', 'Off the Wall', 'Michael Jackson'), src('b', 'Off the Wall', 'Jackson Michael')], 'the wall')).toHaveLength(1);
    } finally { setArtistAliases(new Map()); }
  });
  it('gives every song one identity colour from its title and artist', () => {
    const e = entry('x', 'Smells Like Teen Spirit', 'Nirvana');
    expect(songTint(e)).toBe(fallbackTint('Smells Like Teen SpiritNirvana'));
    expect(songTint(e)).not.toBe(songTint(entry('y', 'Smells Like Teen Spirit', 'Tori Amos')));
  });
});

describe('artist display', () => {
  it('flips "Last, First" solo artists and leaves bands alone', () => {
    expect(displayArtist('Amos, Tori')).toBe('Tori Amos');
    expect(displayArtist('Brown, James')).toBe('James Brown');
    expect(displayArtist('Earth, Wind & Fire')).toBe('Earth, Wind & Fire');
    expect(displayArtist('10,000 Maniacs')).toBe('10,000 Maniacs');
    expect(displayArtist('Crosby, Stills, Nash & Young')).toBe('Crosby, Stills, Nash & Young');
    expect(displayArtist('The Beatles')).toBe('The Beatles');
  });
  it('groups a "Last, First" artist with the plain spelling', () => {
    const idx = buildArtistIndex([entry('a', 'China', 'Amos, Tori'), entry('b', 'Winter', 'Tori Amos')]);
    expect(idx.get('tori amos')?.entries).toHaveLength(2);
    expect(idx.get('tori amos')?.name).toBe('Tori Amos');
  });
});

describe('hit tidying', () => {
  it('keeps different numbered parts and short distinct titles searchable', () => {
    const titles = ['Oxygene (Part 1)', 'Oxygene (Part 2)', 'Oxygene, Part 4', 'Oxygene, Part 6', 'I Do', 'I Go'];
    const rows = titles.map((title, i) => entry(String(i), title, 'Artist'));
    expect(tidyHits(rows, '').map(e => e.title)).toEqual(titles);
  });
  const hits = [
    entry('nirvana--smells-like-teen-spirit', 'Smells Like Teen Spirit', 'Nirvana'),
    entry('amos-tori--smells-like-teen-spirit', 'Smells Like Teen Spirit', 'Amos, Tori'),
    entry('morton--grandpa-s-spells', "Grandpa's Spells", 'Morton Jelly Roll'),
    entry('nirvana--smell-like-teen-spirit', 'Smell Like Teen Spirit', 'Nirvana'),
  ];
  it('collapses near-duplicate transcriptions and drops pure typo matches next to real ones', () => {
    expect(tidyHits(hits, 'smells').map((h) => h.id)).toEqual([
      'nirvana--smells-like-teen-spirit', 'amos-tori--smells-like-teen-spirit',
    ]);
  });
  it('keeps fuzzy matches when nothing matches verbatim', () => {
    expect(tidyHits(hits, 'smels').map((h) => h.id)).toEqual([
      'nirvana--smells-like-teen-spirit', 'amos-tori--smells-like-teen-spirit', 'morton--grandpa-s-spells',
    ]);
  });
  it('keeps the order when every hit is a verbatim match', () => {
    expect(tidyHits(hits.slice(0, 2), 'teen spirit').map((h) => h.id)).toEqual(hits.slice(0, 2).map((h) => h.id));
    expect(tidyHits([], 'x')).toEqual([]);
  });
});

describe('key and chord spelling', () => {
  it('spells keys conventionally', () => {
    expect(flatName('A#')).toBe('Bb');
    expect(flatName('C')).toBe('C');
    expect(spellTonic('A#', 'major')).toBe('Bb');
    expect(spellTonic('F#', 'major')).toBe('F#');
    expect(spellTonic('C#', 'minor')).toBe('C#');
    expect(spellTonic('D#', 'minor')).toBe('Eb');
    expect(keyName('A#', 'major')).toBe('B♭ major');
    expect(keyName('G#', 'major')).toBe('A♭ major');
    expect(keyName('F#', 'minor')).toBe('F♯ minor');
    expect(keyName('D', 'minor')).toBe('D minor');
  });
  it('knows which keys want flats', () => {
    expect(prefersFlats('A#', 'major')).toBe(true);
    expect(prefersFlats('F', 'major')).toBe(true);
    expect(prefersFlats('D', 'minor')).toBe(true);
    expect(prefersFlats('G', 'major')).toBe(false);
    expect(prefersFlats('E', 'minor')).toBe(false);
    expect(prefersFlats(undefined)).toBe(false);
  });
  it('respells sharp chords in flat keys', () => {
    expect(prettyChord('A#^7/A', true)).toBe('B♭maj7/A');
    expect(prettyChord('D#m/F#', true)).toBe('E♭m/G♭');
    expect(prettyChord('G#', true)).toBe('A♭');
    expect(prettyChord('A#^7/A')).toBe('A♯maj7/A');
    expect(prettyChord('Bbm7b5', true)).toBe('B♭m7b5');
    expect(prettyChord('N', true)).toBe('N');
  });
});

describe('structure lane for combined songs', () => {
  const sec = (label: string, bars: number) => ({ label, bars, chords: [] });
  it('lays the McGill structure on the MIDI bar grid and clips it', () => {
    expect(structureSections([sec('intro', 8), sec('verse', 9), sec('outro', 5)], 20)).toEqual([
      { label: 'intro', startBar: 0, bars: 8 }, { label: 'verse', startBar: 8, bars: 9 }, { label: 'outro', startBar: 17, bars: 3 },
    ]);
  });
  it('refuses a structure whose length disagrees with the MIDI', () => {
    expect(structureSections([sec('intro', 8)], 89)).toEqual([]);
    expect(structureSections([sec('intro', 200)], 89)).toEqual([]);
    expect(structureSections(undefined, 89)).toEqual([]);
    expect(structureSections([sec('intro', 8)], 0)).toEqual([]);
  });
  it('clips a capped rendering but checks the length against the whole song', () => {
    expect(structureSections([sec('intro', 8), sec('verse', 80)], 16, 89)).toEqual([{ label: 'intro', startBar: 0, bars: 8 }, { label: 'verse', startBar: 8, bars: 8 }]);
    expect(structureSections([sec('intro', 8), sec('verse', 80)], 16)).toEqual([]);
  });
});

describe('hero eyebrow', () => {
  it('shows the year first and only a studio album that matches it', () => {
    expect(albumLine({ album: 'The Wall', year: 1979, kind: 'track' }, { year: 1979 })).toBe('1979 · The Wall');
    expect(albumLine({ album: 'The Wall (2011 Remastered)', year: 2011, kind: 'track' }, { year: 1979 })).toBe('1979 · The Wall');
    expect(albumLine({ album: 'A Foot in the Door: The Best of Pink Floyd', year: 2011, kind: 'track' }, { year: 1979 })).toBe('1979');
    expect(albumLine({ album: 'Delicate Sound of Thunder (Live)', year: 2019, kind: 'track' }, { year: 1979 })).toBe('1979');
    expect(albumLine({ album: 'Nevermind', year: 1991, kind: 'artist' }, { year: 1991 })).toBe('1991');
    expect(albumLine({ album: 'Nevermind', year: 1991, kind: 'track' }, {})).toBe('1991 · Nevermind');
    expect(albumLine({}, {})).toBe('');
  });
});

describe('routing + timeline zoom helpers', () => {
  it('turns ids into search words', () => {
    expect(idWords('nirvana--smells-like-teen-spirit')).toBe('nirvana smells like teen spirit');
    expect(idWords('james-brown--i-don-t-mind')).toBe('james brown i don t mind');
  });
  it('zooms the timeline only when bars would be too narrow', () => {
    expect(timelineWidth(151, 358, 12)).toBe(1812);
    expect(timelineWidth(16, 358, 12)).toBe(358);
    expect(timelineWidth(200, 1072, 4.5)).toBe(1072);
    expect(timelineWidth(400, 1072, 4.5)).toBe(1800);
    expect(timelineWidth(0, 358, 12)).toBe(358);
  });
  it('page-flips the scroll window when the playhead leaves it', () => {
    expect(followScroll(100, 0, 358, 1812)).toBe(0);
    expect(followScroll(360, 0, 358, 1812)).toBe(271);
    expect(followScroll(1800, 0, 358, 1812)).toBe(1454);
    expect(followScroll(5, 200, 358, 1812)).toBe(0);
    expect(followScroll(500, 0, 358, 300)).toBe(0);
  });
});

describe('chord phrases', () => {
  it('reduces a symbol to its root and triad quality', () => {
    expect(chordFamily('Fsus4/C')).toBe('F');
    expect(chordFamily('A#m7/G#')).toBe('A#m');
    expect(chordFamily('C#^7')).toBe('C#');
    expect(chordFamily('Dmaj7')).toBe('D');
    expect(chordFamily('Bbm')).toBe('Bbm');
    expect(chordFamily('N')).toBeNull();
    expect(chordFamily(null)).toBeNull();
    expect(chordFamily('')).toBeNull();
  });
  it('turns an alternating riff into one phrase with a two-bar cycle', () => {
    const chords = ['Fm/C', 'G#sus4', 'Fm', 'G#sus4', 'Fm', 'G#sus4', 'Fm', 'G#sus4'];
    expect(chordPhrases(chords)).toEqual([{ start: 0, end: 7, period: 2, cycle: ['Fm', 'G#'] }]);
    // Bars are matched by root, so a first bar detected as sus still joins the riff; the slot keeps the
    // quality most of its bars agree on.
    expect(chordPhrases(['Fsus4', ...chords.slice(1)])).toEqual([{ start: 0, end: 7, period: 2, cycle: ['Fm', 'G#'] }]);
    // A blues riff whose detected quality flickers labels the slot with the bare root.
    expect(chordPhrases(['C#7', 'F#7', 'C#m', 'F#7', 'C#7', 'F#7', 'C#m', 'F#7/C#'])).toEqual([{ start: 0, end: 7, period: 2, cycle: ['C#', 'F#'] }]);
  });
  it('keeps plain runs, passing chords and no-chord bars as their own phrases', () => {
    expect(chordPhrases(['Dm', 'Dm7', 'Dsus2', 'G', 'G', null, null, 'C'])).toEqual([
      { start: 0, end: 2, period: 1, cycle: ['Dm'] },
      { start: 3, end: 4, period: 1, cycle: ['G'] },
      { start: 5, end: 6, period: 1, cycle: [null] },
      { start: 7, end: 7, period: 1, cycle: ['C'] },
    ]);
    expect(chordPhrases([])).toEqual([]);
  });
  it('prefers the segmentation with the fewest phrases and the shortest period', () => {
    // F C# F A#m repeated twice: a four-bar cycle, not "F C# F C#" plus leftovers.
    const chords = ['F', 'C#', 'F', 'A#m', 'F', 'C#', 'F', 'A#m'];
    expect(chordPhrases(chords)).toEqual([{ start: 0, end: 7, period: 4, cycle: ['F', 'C#', 'F', 'A#m'] }]);
    // "F G F G" is period 2, never reported as a period-4 cycle; a partial last repetition is kept.
    expect(chordPhrases(['F', 'G', 'F', 'G', 'F'])).toEqual([{ start: 0, end: 4, period: 2, cycle: ['F', 'G'] }]);
    // A cycle needs two full repetitions.
    expect(chordPhrases(['F', 'G', 'F'])).toEqual([
      { start: 0, end: 0, period: 1, cycle: ['F'] }, { start: 1, end: 1, period: 1, cycle: ['G'] }, { start: 2, end: 2, period: 1, cycle: ['F'] },
    ]);
    // No-chord bars never join a cycle.
    expect(chordPhrases(['F', null, 'F', null]).map((p) => p.period)).toEqual([1, 1, 1, 1]);
  });
  it('covers every bar exactly once', () => {
    const chords = Array.from({ length: 200 }, (_, i) => ['Dm', 'Dsus2', 'G', 'C', 'Dm7', null][(i * 7 + (i % 5)) % 6]);
    const phrases = chordPhrases(chords);
    expect(phrases[0].start).toBe(0);
    expect(phrases[phrases.length - 1].end).toBe(199);
    for (let i = 1; i < phrases.length; i++) expect(phrases[i].start).toBe(phrases[i - 1].end + 1);
  });
});

describe('structure chords', () => {
  const sec = (label: string, chords: [string | null, number][]) => ({ label, bars: chords.reduce((n, c) => n + c[1], 0) / 4, chords: chords.map(([symbol, beats]) => ({ symbol, beats })) });
  it('lays the annotated chords on the bar grid', () => {
    const structure = [sec('intro', [['G', 8], ['C', 4], ['G', 4]]), sec('verse', [['D', 2], ['C', 2], ['G', 8]])];
    expect(structureChords(structure, 7, 4)).toEqual(['G', 'G', 'C', 'G', 'D', 'G', 'G']);
    expect(structureChords(structure, 3, 4, 7)).toEqual(['G', 'G', 'C']);
    expect(structureChords(structure, 9, 4)).toEqual(['G', 'G', 'C', 'G', 'D', 'G', 'G', null, null]);
  });
  it('refuses a structure that disagrees with the rendered length', () => {
    const structure = [sec('intro', [['G', 32]])];
    expect(structureChords(structure, 89, 4)).toBeNull();
    expect(structureChords(structure, 8, 4, 89)).toBeNull();
    expect(structureChords(structure, 8, 4)).toEqual(Array(8).fill('G'));
    expect(structureChords(undefined, 8, 4)).toBeNull();
    expect(structureChords(structure, 0, 4)).toBeNull();
  });
});

describe('section abbreviations', () => {
  it('uses chord-chart abbreviations, never a lone capital', () => {
    expect(sectionAbbr('interlude')).toBe('inter');
    expect(sectionAbbr('transition')).toBe('trans');
    expect(sectionAbbr('trans')).toBe('trans');
    expect(sectionAbbr('outro')).toBe('out');
    expect(sectionAbbr('fadeout')).toBe('fade');
    expect(sectionAbbr('pre-chorus')).toBe('pre');
    expect(sectionAbbr('instrumental')).toBe('inst');
    expect(sectionAbbr('verse')).toBe('vs');
    expect(sectionAbbr('chorus')).toBe('ch');
    expect(sectionAbbr('Bridge')).toBe('br');
    expect(sectionAbbr('main theme')).toBe('th');
    expect(sectionAbbr('vocal')).toBe('vox');
    expect(sectionAbbr('refrain')).toBe('ref');
    expect(sectionAbbr('')).toBe('');
  });
  it('never abbreviates to the start of another section name in the same song', () => {
    // Love Me Do: "in" and "int" next to a full "intro" would read as more intros.
    const m = sectionAbbrs(['intro', 'verse', 'interlude', 'trans', 'fade', 'verse', 'intro']);
    expect(m.get('intro')).toBe('intro');
    expect(m.get('interlude')).toBe('inter');
    expect(m.get('verse')).toBe('vs');
    expect(m.get('trans')).toBe('trans');
    expect(m.get('fade')).toBe('fade');
    // Alone, the chart abbreviation stands.
    expect(sectionAbbrs(['intro', 'verse', 'chorus']).get('intro')).toBe('in');
    // Two labels that share an abbreviation are not a clash.
    expect(sectionAbbrs(['trans', 'transition']).get('trans')).toBe('trans');
    expect(sectionAbbrs(['instrumental', 'intro']).get('instrumental')).toBe('inst');
    expect(sectionAbbrs([]).size).toBe(0);
  });
});

describe('generated code respelled the way the UI reads it', () => {
  const code = '// Song — Artist\n// 106 bpm, 4/4, key A# major. Source: midi.\nsetcpm(26.50)\n\n// chords: N A#^7/A G G^7 Dsus4/A | F A# F C#m7\n\nconst x = note("a")';
  it('respells only the chords comment, in the display spelling', () => {
    const out = respellChordLine(code, true);
    expect(out.split('\n')[4]).toBe('// chords: N B♭maj7/A G Gmaj7 Dsus4/A | F B♭ F D♭m7');
    expect(out.split('\n').slice(0, 4)).toEqual(code.split('\n').slice(0, 4)); // header untouched
    expect(out).toContain('const x = note("a")');
    expect(respellChordLine(code, false)).toContain('// chords: N A♯maj7/A G Gmaj7 Dsus4/A | F A♯ F C♯m7');
    expect(respellChordLine('no chords here', true)).toBe('no chords here');
  });
  it('respells the header key like the key chip', () => {
    expect(respellKeyLine(code, 'A#', 'major').split('\n')[1]).toBe('// 106 bpm, 4/4, key B♭ major. Source: midi.');
    expect(respellKeyLine(code, 'C#', 'minor').split('\n')[1]).toBe('// 106 bpm, 4/4, key C♯ minor. Source: midi.');
    expect(respellKeyLine(code.replace('key A# major', 'key unknown'), 'F', 'major')).toContain('key F major.');
    expect(respellKeyLine(code, undefined, undefined)).toBe(code);
  });
  it('summarises sections like the compiler and swaps the chords line', () => {
    const sections = [
      { label: 'a', bars: 2, chords: [{ symbol: 'C', beats: 4 }, { symbol: 'C', beats: 4 }, { symbol: 'G', beats: 4 }] },
      { label: 'b', bars: 1, chords: [{ symbol: null, beats: 4 }, { symbol: 'F', beats: 4 }] },
    ];
    expect(chordSummary(sections)).toBe('C G | N F');
    const out = replaceChordLine(code, 'C G | N F', ['read from the MIDI notes']);
    expect(out.split('\n')[4]).toBe('// chords: C G | N F');
    expect(out.split('\n')[5]).toBe('// note: read from the MIDI notes');
    expect(out.split('\n')[6]).toBe('');
    // Without a chords line the block goes right after setcpm.
    const bare = 'setcpm(30.00)\n\nconst x = 1';
    expect(replaceChordLine(bare, 'C')).toBe('setcpm(30.00)\n\n// chords: C\n\nconst x = 1');
  });
  it('finds the interval between the chart and the detected chords', () => {
    const sec = (chords: [string | null, number][]) => ({ label: 'x', bars: 1, chords: chords.map(([symbol, beats]) => ({ symbol, beats })) });
    const chart = [sec([['Dm', 8], ['Dm7', 4], ['G9sus4', 4], ['E', 2]])];
    const low = [sec([['C#7', 8], ['C#m', 4], ['F#7', 4], ['D#', 2]])];
    expect(chartShift(chart, low)).toBe(-1);
    expect(chartShift(chart, chart)).toBe(0);
    expect(chartShift(chart, [sec([['E', 8], ['Em', 4], ['A', 4]])])).toBe(2);
    expect(chartShift([], low)).toBe(0);
    expect(chartShift(chart, [sec([[null, 4]])])).toBe(0);
    expect(shiftTonic('D', -1)).toBe('C#');
    expect(shiftTonic('Bb', 2)).toBe('C');
    expect(shiftTonic(undefined, 3)).toBeUndefined();
  });
  it('estimates the key of the notes', () => {
    const notes = (pitches: number[]) => pitches.map((pitch) => ({ pitch, duration: 1 }));
    // C major scale, tonic weighted.
    const cMajor = [{ role: 'melody', notes: notes([60, 60, 60, 64, 67, 67, 62, 65, 69, 71, 72, 72]) }, { role: 'drums', notes: notes([36, 38]) }];
    expect(midiKey(cMajor)).toEqual({ tonic: 'C', mode: 'major' });
    expect(midiKey([{ role: 'melody', notes: notes([61, 61, 61, 64, 68, 68, 63, 66, 70, 71, 73, 73]) }])).toEqual({ tonic: 'C#', mode: 'minor' });
    expect(midiKey([{ role: 'drums', notes: notes([36]) }])).toBeUndefined();
    expect(midiKey([])).toBeUndefined();
  });
});

describe('part list', () => {
  it('reads role and instrument from the comment above each part', () => {
    const code = ['// melody · gm_electric_guitar_jazz · instrumental lead · gain 1', 'const melody = note("<a>")', '',
      '// bass · gm_electric_bass_finger · gain 0.83', 'const bass = note("<a>")', '// drums · main hits · gain 1', 'const drums = s("<bd>")',
      'const chords = chord("<C>").voicing()', 'const x = 1'].join('\n');
    expect(partList(code)).toEqual(['melody · electric guitar jazz', 'bass · electric bass finger', 'drums · main hits', 'part']);
  });
});

describe('derived form', () => {
  const rep = (seq: string[], times: number) => Array.from({ length: times }, () => seq).flat();
  const A = ['C', 'C', 'F', 'F', 'G', 'G', 'C', 'C'];
  const B = ['Am', 'Am', 'F', 'F', 'G', 'G', 'E', 'E'];
  it('labels repeated 8-bar chord windows with letters in order of appearance', () => {
    const chords = [...rep(A, 2), ...B, ...A, ...B, ...B];
    expect(deriveForm(chords)).toEqual([
      { label: 'A', startBar: 0, bars: 16 }, { label: 'B', startBar: 16, bars: 8 }, { label: 'A', startBar: 24, bars: 8 }, { label: 'B', startBar: 32, bars: 16 },
    ]);
  });
  it('tolerates a flickering chord quality and a 4-bar intro', () => {
    const A2 = ['C7', 'C', 'F', 'Fmaj7', 'G', 'G', 'C', 'C'];
    const chords = ['N', 'N', 'N', 'N', ...A, ...A2, ...B, ...A, ...B, ...B];
    const form = deriveForm(chords);
    expect(form[0]).toEqual({ label: 'A', startBar: 0, bars: 20 }); // the silent lead-in joins the first part
    expect(form.map((s) => s.label).join('')).toBe('ABAB');
    expect(form.reduce((n, s) => n + s.bars, 0)).toBe(chords.length);
  });
  it('gives up on short, sparse, uniform or chaotic songs', () => {
    expect(deriveForm(A)).toEqual([]);
    expect(deriveForm(rep(['C', null, null, null], 12))).toEqual([]);
    expect(deriveForm(rep(A, 6))).toEqual([]);
    const chaos = Array.from({ length: 96 }, (_, i) => ['C', 'D', 'E', 'F', 'G', 'A', 'B', 'Db', 'Eb', 'Gb', 'Ab', 'Bb'][(i * 7 + Math.floor(i / 8) * 3) % 12]);
    expect(deriveForm(chaos)).toEqual([]);
  });
  it('names and colours form letters', () => {
    expect(isFormLabel('A')).toBe(true);
    expect(isFormLabel('verse')).toBe(false);
    expect(formColor('A')).not.toBe(formColor('B'));
    expect(formColor('zzz')).toBe('#b6c8d9');
  });
});

describe('chord lane packing', () => {
  const it_ = (start: number, end: number, o: Partial<PhraseItem> = {}): PhraseItem => ({ start, end, none: false, fits: true, period: 1, pretty: ['C'], ...o });
  it('keeps labelled, long and empty phrases as their own blocks', () => {
    const blocks = packPhrases([it_(0, 3), it_(4, 7, { none: true, pretty: [''] }), it_(8, 11, { fits: false, pretty: ['G'] }), it_(12, 15, { period: 2, pretty: ['F', 'G'] })]);
    expect(blocks.map((b) => [b.start, b.end, b.kind])).toEqual([[0, 3, ''], [4, 7, 'none'], [8, 11, ''], [12, 15, 'cycle']]);
  });
  it('folds a lone passing chord into the block before it', () => {
    const blocks = packPhrases([it_(0, 7), it_(8, 8, { fits: false, pretty: ['G'] }), it_(9, 15, { pretty: ['F'] })]);
    expect(blocks.map((b) => [b.start, b.end, b.kind])).toEqual([[0, 8, ''], [9, 15, '']]);
    expect(blocks[0].extra.map((e) => e.pretty[0])).toEqual(['G']);
  });
  it('turns a run of quick changes into one mixed block and never folds into a mixed one', () => {
    const blocks = packPhrases([it_(0, 0, { fits: false, pretty: ['C'] }), it_(1, 2, { fits: false, pretty: ['G'] }), it_(3, 3, { fits: false, pretty: ['Am'] }), it_(4, 4, { fits: false, pretty: ['F'] })]);
    expect(blocks.map((b) => [b.start, b.end, b.kind])).toEqual([[0, 4, 'mixed']]);
    expect(blocks[0].extra).toHaveLength(4);
    const lone = packPhrases([it_(0, 0, { fits: false, pretty: ['C'] })]);
    expect(lone.map((b) => [b.start, b.end, b.kind, b.main?.pretty[0]])).toEqual([[0, 0, '', 'C']]);
  });
  it('gives a pickup chord at the start (or after a silence) a sliver of its own, never a neighbour\'s label', () => {
    const blocks = packPhrases([it_(0, 0, { fits: false, pretty: ['N7'] }), it_(1, 8, { pretty: ['G'] }), it_(9, 9, { fits: false, pretty: ['D'] })]);
    expect(blocks.map((b) => [b.start, b.end, b.kind, b.main?.pretty[0], b.extra.map((e) => e.pretty[0])])).toEqual([[0, 0, '', 'N7', []], [1, 9, '', 'G', ['D']]]);
    const mixedNext = packPhrases([it_(0, 0, { fits: false, pretty: ['C'] }), it_(1, 4, { none: true, pretty: [''] }), it_(5, 5, { fits: false, pretty: ['D'] }), it_(6, 6, { fits: false, pretty: ['E'] })]);
    expect(mixedNext.map((b) => [b.start, b.end, b.kind])).toEqual([[0, 0, ''], [1, 4, 'none'], [5, 6, 'mixed']]);
    const afterSilence = packPhrases([it_(0, 3, { none: true, pretty: [''] }), it_(4, 4, { fits: false, pretty: ['E'] }), it_(5, 12, { pretty: ['A'] })]);
    expect(afterSilence.map((b) => [b.start, b.end, b.kind, b.main?.pretty[0]])).toEqual([[0, 3, 'none', undefined], [4, 4, '', 'E'], [5, 12, '', 'A']]);
  });
  it('labels a cycle with its repeats collapsed and, narrower, its head plus a count', () => {
    expect(cycleLabels(['Am', 'Am', 'C', 'C'])).toEqual(['Am · C', 'Am +1']);
    expect(cycleLabels(['F', 'B♭', 'C', 'Dm'])).toEqual(['F · B♭ · C · Dm', 'F · B♭ · C +1', 'F · B♭ +2', 'F +3']);
    expect(cycleLabels(['C', 'Am', 'C'])).toEqual(['C · Am', 'C +1']);
    expect(cycleLabels(['G'])).toEqual(['G']);
    expect(cycleLabels([])).toEqual([]);
    for (const v of cycleLabels(['F', 'B♭', 'C', 'Dm'])) expect(v).not.toContain('…');
  });
  it('cuts a long run of quick changes into even chunks of at most eight bars', () => {
    const run = Array.from({ length: 20 }, (_, i) => it_(i, i, { fits: false, pretty: [['Bm', 'F♯7', 'A', 'E7'][i % 4]] }));
    const blocks = packPhrases(run);
    expect(blocks.map((b) => [b.start, b.end, b.kind, b.extra[0].pretty[0]])).toEqual([[0, 6, 'mixed', 'Bm'], [7, 13, 'mixed', 'E7'], [14, 19, 'mixed', 'A']]);
    expect(packPhrases(run, 20)).toHaveLength(1);
  });
});

describe('lead name', () => {
  it('reduces a General MIDI label to the word a listener uses', () => {
    expect(leadName('electric guitar jazz')).toBe('guitar');
    expect(leadName('alto sax')).toBe('sax');
    expect(leadName('lead 2 sawtooth')).toBe('synth');
    expect(leadName('pad 2 warm')).toBe('synth');
    expect(leadName('acoustic grand piano')).toBe('piano');
    expect(leadName('tinkle bell')).toBe('tinkle bell');
  });
});


describe('live-coding part counts', () => {
  it('counts instrument arrangements, not riff definitions, including source tracks named like riffs', () => {
    expect(partList([
      '// bass: reusable phrases',
      'const bass_riff1 = note("c2 e2")',
      'const bass_riff2 = note("d2 f2")',
      '// bass · bass',
      'const bass = arrange([4, bass_riff1], [4, bass_riff2])',
      '// chords · guitar',
      'const guitar_riff1 = note("c3")',
    ].join('\n'))).toEqual(['bass · bass', 'chords · guitar']);
  });
});
