import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIndex, tokenize, normaliseText, editDistance, leadArtist, isDuplicateTitle, sameSongTitle, transcriptions } from '../src/search.js';
import type { IndexEntry } from '../src/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_INDEX = path.resolve(HERE, '..', '..', 'data', 'public', 'db', 'index.json');

function song(id: string, title: string, artist: string, popularity = 1, sources: IndexEntry['sources'] = ['midi']): IndexEntry {
  return { id, title, artist, sources, popularity, files: {} };
}

const SONGS: IndexEntry[] = [
  song('the-beatles--yesterday', 'Yesterday', 'The Beatles', 9),
  song('boyz-ii-men--yesterday', 'Yesterday', 'Boyz II Men', 3),
  song('clayderman-richard--yesterday', 'Yesterday', 'Clayderman Richard', 1),
  song('carpenters--yesterday-once-more', 'Yesterday Once More', 'Carpenters', 4),
  song('the-beatles--hey-jude', 'Hey Jude', 'The Beatles', 11),
  song('the-beatles--help', 'Help!', 'The Beatles', 10),
  song('the-beatles--let-it-be', 'Let It Be', 'The Beatles', 12),
  song('the-beatles--back-in-the-u-s-s-r', 'Back in the U.S.S.R.', 'The Beatles', 1),
  song('the-beach-boys--help-me-rhonda', 'Help Me Rhonda', 'The Beach Boys', 4),
  song('queen--bohemian-rhapsody', 'Bohemian Rhapsody', 'Queen', 8),
  song('queen--killer-queen', 'Killer Queen', 'Queen', 7),
  song('queen--we-will-rock-you', 'We Will Rock You', 'Queen', 7),
  song('queen--radio-ga-ga', 'Radio Ga Ga', 'Queen', 9),
  song('queen--don-t-stop-me-now', "Don't Stop Me Now", 'Queen', 5),
  song('queen--save-me', 'Save Me', 'Queen', 4),
  song('abba--dancing-queen', 'Dancing Queen', 'ABBA', 13),
  song('nirvana--smells-like-teen-spirit', 'Smells Like Teen Spirit', 'Nirvana', 8),
  song('nirvana--smell-like-teen-spirit', 'Smell Like Teen Spirit', 'Nirvana', 1),
  song('amos-tori--smells-like-teen-spirit', 'Smells Like Teen Spirit', 'Amos, Tori', 1),
  song('nirvana--lithium', 'Lithium', 'Nirvana', 8),
  song('brown-james--i-got-you', 'I Got You (I Feel Good)', 'Brown James', 5),
  song('james-brown--i-don-t-mind', "I Don't Mind", 'James Brown', 4, ['mcgill']),
  song('james-brown--think', 'Think', 'James Brown', 4, ['mcgill']),
  song('louis-armstrong--wonderful-world', '(What a) Wonderful World', 'Louis Armstrong', 6),
  song('jimmy-cliff--wonderful-world-beautiful-people', 'Wonderful World, Beautiful People', 'Jimmy Cliff', 4),
  song('louis-armstrong--what-a-wonderful-world', 'What a Wonderful World', 'Louis Armstrong', 3),
  song('guns-n-roses--sweet-child-o-mine', "Sweet Child O' Mine", "Guns N' Roses", 3),
  song('the-who--baba-o-riley', "Baba O'Riley", 'The Who', 1),
  song('ac-dc--tnt', 'T.N.T.', 'AC DC', 2),
  song('ac-dc--back-in-black', 'Back in Black', 'AC DC', 2),
  song('r-e-m--losing-my-religion', 'Losing My Religion', 'R.E.M.', 4),
  song('oasis--wonderwall', 'Wonderwall', 'Oasis', 2),
  song('pink-floyd--another-brick-in-the-wall-part-2', 'Another Brick in the Wall, Part 2', 'Pink Floyd', 11),
  song('ben-e-king--stand-by-me', 'Stand By Me', 'Ben E. King', 5),
  song('seal--crazy', 'Crazy', 'Seal', 5),
  song('britney-spears--crazy', '(You Drive Me) Crazy', 'Britney Spears', 9),
  song('aerosmith--crazy', 'Crazy', 'Aerosmith', 3),
  song('celine-dion--my-heart-will-go-on', 'My Heart Will Go On', 'Celine Dion', 6),
  song('toto--99', '99', 'Toto', 1),
  song('nena--99-luftballons', '99 Luftballons', 'Nena', 12),
  song('karaoke-hits--lithium', 'Lithium', 'Karaoke Hits', 9),
  song('karaoke-hits--karaoke-party', 'Karaoke Party', 'Karaoke Hits', 1),
  // as-you-type and prefix-tier fixtures
  song('pink-floyd--hey-you', 'Hey You', 'Pink Floyd', 6),
  song('jimi-hendrix--hey-joe', 'Hey Joe', 'Jimi Hendrix', 2),
  song('ll-cool-j--hey-lover', 'Hey Lover', 'LL Cool J', 1),
  song('tool--h', 'H.', 'Tool', 1),
  song('led-zeppelin--stairway-to-heaven', 'Stairway to Heaven', 'Led Zeppelin', 12),
  song('led-zeppelin--kashmir', 'Kashmir', 'Led Zeppelin', 5),
  song('dvorak--symfonie-z-noveho-sveta', 'Symfonie c. 9 Z Noveho sveta', 'Dvorak', 1),
  song('kool-the-gang--jungle-boogie', 'Jungle Boogie', 'Kool & The Gang', 5),
  song('bruce-springsteen--jungleland', 'Jungleland', 'Bruce Springsteen', 1),
  song('mariah-carey--hero', 'Hero', 'Mariah Carey', 5),
  song('david-bowie--heroes', 'Heroes', 'David Bowie', 1),
  song('kansas--the-wall', 'The Wall', 'Kansas', 1),
  song('backstreet-boys--the-call', 'The Call', 'Backstreet Boys', 2),
  song('pink-floyd--outside-the-wall', 'Outside the Wall', 'Pink Floyd', 4),
  song('sweet--action', 'Action', 'Sweet', 1),
  song('sweet--ballroom-blitz', 'Ballroom Blitz', 'Sweet', 1),
  song('sweet--fox-on-the-run', 'Fox on the Run', 'Sweet', 1),
  song('lynyrd-skynyrd--sweet-home-alabama', 'Sweet Home Alabama', 'Lynyrd Skynyrd', 6),
  song('neil-diamond--sweet-caroline', 'Sweet Caroline', 'Neil Diamond', 7),
  song('madonna--don-t-stop', "Don't Stop", 'Madonna', 1),
  song('fleetwood-mac--don-t-stop', "Don't Stop", 'Fleetwood Mac', 1),
  song('john-lennon--imagine', 'Imagine', 'John Lennon', 5),
  // a word of an artist's name, alternative titles, typos of real words
  song('the-beatles--i-feel-fine', 'I Feel Fine', 'The Beatles', 5),
  song('nirvana--aero-zeppelin', 'Aero Zeppelin', 'Nirvana', 2),
  song('elvis-presley--jailhouse-rock', 'Jailhouse Rock', 'Elvis Presley', 9),
  song('elvis-presley--blue-suede-shoes', 'Blue Suede Shoes', 'Elvis Presley', 8),
  song('elvis-presley--in-the-ghetto', 'In the Ghetto', 'Elvis Presley', 4),
  song('elvis--in-the-ghetto', 'In the Ghetto', 'Elvis', 1),
  song('elvis--blue-hawaii', 'Blue Hawaii', 'Elvis', 1),
  song('elvis--elvis-interview', 'Elvis Interview', 'Elvis', 1),
  song('dire-straits--calling-elvis', 'Calling Elvis', 'Dire Straits', 6),
  song('soundgarden--gun', 'Gun', 'Soundgarden', 1),
  song('james-taylor--country-road', 'Country Road', 'James Taylor', 4),
  song('john-denver--take-me-home-country-roads', 'Take Me Home Country Roads', 'John Denver', 2),
  song('adamo--aline', 'Aline', 'Adamo', 1),
  song('patsy-cline--i-fall-to-pieces', 'I Fall to Pieces', 'Patsy Cline', 1),
  song('patsy-cline--she-s-got-you', "She's Got You", 'Patsy Cline', 1),
  song('alan-jackson--mercury-blues', 'Mercury Blues', 'Alan Jackson', 2),
  song('freddie-mercury--living-on-my-own', 'Living on My Own', 'Freddie Mercury', 4),
  song('bowie-david--cat-people', 'Cat People', 'BOWIE DAVID', 4),
  song('the-who--who-are-you', 'Who Are You', 'The Who', 1),
  song('the-who--pinball-wizard', 'Pinball Wizard', 'The Who', 6),
  song('the-jacksons--i-want-you-back', 'I Want You Back', 'The Jacksons', 4),
  song('jackson-michael--bad', 'Bad', 'Jackson Michael', 9),
  song('jackson-michael--billie-jean', 'Billie Jean', 'Jackson Michael', 6),
  song('steely-dan--do-it-again', 'Do It Again', 'Steely Dan', 6),
  song('steely-dan--aja', 'Aja', 'Steely Dan', 5),
  song('black-sabbath--paranoid', 'Paranoid', 'Black Sabbath', 8),
  song('black-sabbath--sabbath-bloody-sabbath', 'Sabbath Bloody Sabbath', 'Black Sabbath', 3),
  song('the-beatles--blackbird', 'Blackbird', 'The Beatles', 5),
  song('los-bravos--black-is-black', 'Black Is Black', 'Los Bravos', 4),
  song('santana--black-magic-woman', 'Black Magic Woman', 'Santana', 4),
  song('the-rolling-stones--paint-it-black', 'Paint It Black', 'The Rolling Stones', 7),
  song('led-zeppelin--black-dog', 'Black Dog', 'Led Zeppelin', 3),
  song('pearl-jam--black', 'Black', 'Pearl Jam', 2),
  song('kenny-loggins--danger-zone', 'Danger Zone', 'Kenny Loggins', 3),
  // glued words, initials, composers, unknown exact titles, absent songs
  song('the-beatles--ob-la-di-ob-la-da', 'Ob-La-Di, Ob-La-Da', 'The Beatles', 10),
  song('spirit--i-got-a-line-on-you', 'I Got a Line on You', 'Spirit', 1),
  song('the-corrs--radio', 'Radio', 'The Corrs', 1),
  song('creedence-clearwater-revival--bad-moon-rising', 'Bad Moon Rising', 'Creedence Clearwater Revival', 9),
  song('creedence-clearwater-revival--proud-mary', 'Proud Mary', 'Creedence Clearwater Revival', 9),
  song('red-hot-chili-peppers--californication', 'Californication', 'Red Hot Chili Peppers', 3),
  song('red-hot-chili-peppers--aeroplane', 'Aeroplane', 'Red Hot Chili Peppers', 3),
  song('electric-light-orchestra--mr-blue-sky', 'Mr. Blue Sky', 'Electric Light Orchestra', 3),
  song('los-del-rio--macarena', 'Macarena', 'Los Del Rio', 2), // a catalogue too small for initials
  song('wolfgang-amadeus-mozart--eine-kleine-nachtmusik', 'Eine kleine Nachtmusik', 'Wolfgang Amadeus Mozart', 2),
  song('wolfgang-amadeus-mozart--rondo-alla-turca', 'Rondo alla Turca', 'Wolfgang Amadeus Mozart', 1),
  song('wolfgang-amadeus-mozart--lacrimosa', 'Lacrimosa', 'Wolfgang Amadeus Mozart', 1),
  song('suzanne-ciani--mozart', 'Mozart', 'Suzanne Ciani', 1),
  song('ludwig-van-beethoven--fur-elise', 'Fur Elise', 'Ludwig van Beethoven', 3),
  song('ludwig-van-beethoven--5th-symphony', '5th Symphony', 'Ludwig van Beethoven', 3),
  song('ludwig-van-beethoven--menuet', 'Menuet', 'Ludwig van Beethoven', 1),
  song('the-beatles--roll-over-beethoven', 'Roll Over Beethoven', 'The Beatles', 6),
  song('duke-robillard--rule-the-world', 'Rule the World', 'Duke Robillard', 1),
  song('tears-for-fears--everybody-wants-to-rule-the-world', 'Everybody Wants To Rule The World', 'Tears for Fears', 4),
  song('robert-cray--smoking-gun', 'Smoking Gun', 'Robert Cray', 2),
  song('the-offspring--walla-walla', 'Walla Walla', 'The Offspring', 1),
  song('madonna--express-yourself', 'Express Yourself', 'Madonna', 7),
  song('beck--loser', 'Loser', 'Beck', 2),
  song('howard-carpendale--willkommen-auf-der-titanic', 'Willkommen auf der Titanic', 'Howard Carpendale', 1),
  song('queen--another-one-bites-the-dust', 'Another One Bites the Dust', 'Queen', 6),
  song('the-beatles--i-saw-her-standing-there', 'I Saw Her Standing There', 'The Beatles', 10),
  // an exact title from an artist with a catalogue, duplicate transcriptions, catalogue tie-breaks
  song('aretha-franklin--respect', 'Respect', 'Aretha Franklin', 1),
  song('aretha-franklin--think', 'Think', 'Aretha Franklin', 3),
  song('aretha-franklin--chain-of-fools', 'Chain of Fools', 'Aretha Franklin', 2),
  song('erasure--a-little-respect', 'A Little Respect', 'Erasure', 5),
  song('bon-jovi--livin-on-a-prayer', "Livin' On A Prayer", 'Bon Jovi', 4),
  song('bon-jovi--living-on-a-prayer', 'Living on a Prayer', 'Bon Jovi', 1),
  song('scott-joplin--the-entertainer', 'The Entertainer', 'Scott Joplin', 2),
  song('scott-joplin--maple-leaf-rag', 'Maple Leaf Rag', 'Scott Joplin', 6),
  song('marvin-hamlisch--the-entertainer', 'The Entertainer', 'Marvin Hamlisch', 2),
  song('allan-theo--lola', 'Lola', 'Allan Theo', 1),
  song('the-kinks--lola-live-1977', 'Lola - Live 1977', 'The Kinks', 1),
  song('the-kinks--you-really-got-me', 'You Really Got Me', 'The Kinks', 5),
];

const index = createIndex(SONGS);
const top = (q: string) => index.search(q, 5).map((h) => h.id);

describe('tokenize / normaliseText', () => {
  it('lower-cases, strips punctuation and diacritics', () => {
    expect(tokenize('Céline Dion')).toEqual(['celine', 'dion']);
    expect(tokenize('Mötley Crüe')).toEqual(['motley', 'crue']);
    expect(normaliseText('  Hey, Jude!! ')).toBe('hey jude');
  });
  it('removes apostrophes instead of splitting on them', () => {
    expect(tokenize("Don't Stop Me Now")).toEqual(['dont', 'stop', 'me', 'now']);
    expect(tokenize("Sweet Child O' Mine")).toEqual(['sweet', 'child', 'o', 'mine']);
    expect(tokenize("Rock 'n' Roll")).toEqual(['rock', 'and', 'roll']);
  });
  it('maps & and n to and', () => {
    expect(tokenize("Guns N' Roses")).toEqual(['guns', 'and', 'roses']);
    expect(tokenize('Twist & Shout')).toEqual(['twist', 'and', 'shout']);
  });
  it('keeps a trailing single letter as typed in typing mode', () => {
    expect(tokenize('dont stop me n')).toEqual(['dont', 'stop', 'me', 'and']);
    expect(tokenize('dont stop me n', true)).toEqual(['dont', 'stop', 'me', 'n']);
    expect(tokenize('guns n r', true)).toEqual(['guns', 'and', 'r']);
    expect(tokenize('r e m', true)).toEqual(['re', 'm']);
    expect(tokenize('r e m')).toEqual(['rem']);
    expect(tokenize('hey j', true)).toEqual(['hey', 'j']);
  });
  it('joins runs of single letters and normalises roman numerals', () => {
    expect(tokenize('R.E.M.')).toEqual(['rem']);
    expect(tokenize('Back in the U.S.S.R.')).toEqual(['back', 'in', 'the', 'ussr']);
    expect(tokenize('Boyz II Men')).toEqual(['boyz', '2', 'men']);
    expect(tokenize('Another Brick in the Wall (Part II)')).toEqual(['another', 'brick', 'in', 'the', 'wall', 'part', '2']);
    expect(tokenize('A Day in the Life')).toEqual(['a', 'day', 'in', 'the', 'life']);
  });
  it('returns nothing for empty or punctuation-only input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize(' - !! ')).toEqual([]);
    expect(index.search('   ')).toEqual([]);
  });
});

describe('editDistance', () => {
  it('counts substitutions, insertions, deletions and transpositions', () => {
    expect(editDistance('rapsody', 'rhapsody', 2)).toBe(1);
    expect(editDistance('smels', 'smells', 1)).toBe(1);
    expect(editDistance('teh', 'the', 1)).toBe(1);
    expect(editDistance('abc', 'abc', 1)).toBe(0);
  });
  it('bails out early past the bound', () => {
    expect(editDistance('abcdef', 'xyzuvw', 2)).toBe(3);
    expect(editDistance('a', 'abcd', 1)).toBe(2);
  });
});

describe('ranking: exact title dominance', () => {
  it('an exact title beats a more popular partial match', () => {
    expect(top('gun')[0]).toBe('soundgarden--gun');
    expect(top('gun')[1]).toBe('robert-cray--smoking-gun');
    expect(top('yesterday')[0]).toBe('the-beatles--yesterday');
    expect(top('help')[0]).toBe('the-beatles--help');
    expect(top('what a wonderful world').slice(0, 2)).toEqual(['louis-armstrong--wonderful-world', 'louis-armstrong--what-a-wonderful-world']);
  });
  it('uses popularity only to order equally good matches', () => {
    expect(top('yesterday').slice(0, 3)).toEqual(['the-beatles--yesterday', 'boyz-ii-men--yesterday', 'clayderman-richard--yesterday']);
    expect(top('yesterday')[3]).toBe('carpenters--yesterday-once-more');
    expect(top('teen spirit')[0]).toBe('nirvana--smells-like-teen-spirit');
  });
  it('treats a leading parenthetical as an optional part of the title', () => {
    // "(You Drive Me) Crazy" is a full match for "crazy", but below the songs titled exactly "Crazy"
    expect(top('crazy').slice(0, 3)).toEqual(['seal--crazy', 'aerosmith--crazy', 'britney-spears--crazy']);
    expect(index.search('crazy')[2].match.title).toBe('exact');
    expect(top('you drive me crazy')[0]).toBe('britney-spears--crazy');
    expect(index.search('you drive me crazy')[0].match.title).toBe('exact');
    expect(top('wonderful world')[0]).toBe('louis-armstrong--wonderful-world');
    expect(top('i feel good')[0]).toBe('brown-james--i-got-you');
  });
  it('marks how the title and artist matched', () => {
    const [h] = index.search('yesterday beatles');
    expect(h.match).toEqual({ title: 'exact', artist: 'exact', coverage: 1, titleShare: 1 });
    expect(index.search('yesterday')[0].match).toEqual({ title: 'exact', artist: 'none', coverage: 1, titleShare: 1 });
    expect(index.search('bohem')[0].match.title).toBe('prefix');
    expect(index.search('teen spirit')[0].match).toEqual({ title: 'phrase', artist: 'none', coverage: 1, titleShare: 0.5 });
    expect(index.search('spirit teen')[0].match.title).toBe('partial'); // the words, but not in the title's order
    expect(index.search('the wall pink floyd')[0].match).toEqual({ title: 'phrase', artist: 'exact', coverage: 1, titleShare: 2 / 7 });
  });
  it('reports exact only for letter-perfect titles, fuzzy for typos, prefix for half-typed last words', () => {
    expect(index.search('smells like teen spirit')[0].match.title).toBe('exact');
    expect(index.search('smels like teen spirit')[0].match.title).toBe('fuzzy');
    expect(index.search('wonder wall')[0].match.title).not.toBe('exact'); // glued words are not letter-perfect
    expect(index.search('heros')[0].match.title).toBe('fuzzy');
    expect(index.search('bohemian rhapsod')[0].match.title).toBe('prefix');
    expect(index.search('jungle')[0].match.title).toBe('prefix');
    expect(index.search('stairway to h')[0].match.title).toBe('prefix');
    expect(index.search('wonderwal')[0].match.title).toBe('prefix');
  });
  it('ranks a half-typed title as a prefix, so popularity decides between completions', () => {
    // "jungle" is a prefix of both Jungleland and Jungle Boogie: not an exact match of either
    expect(top('jungle').slice(0, 2)).toEqual(['kool-the-gang--jungle-boogie', 'bruce-springsteen--jungleland']);
    expect(top('hey').slice(0, 2)).toEqual(['the-beatles--hey-jude', 'pink-floyd--hey-you']);
    expect(top('sweet').slice(0, 2)).toEqual(['neil-diamond--sweet-caroline', 'lynyrd-skynyrd--sweet-home-alabama']);
  });
  it('weights popularity enough to order partial matches of the same artist', () => {
    expect(top('the wall pink floyd')[0]).toBe('pink-floyd--another-brick-in-the-wall-part-2');
    expect(top('pink floyd the wall')[0]).toBe('pink-floyd--another-brick-in-the-wall-part-2');
  });
});

describe('ranking: as you type', () => {
  const stable = (query: string, want: string, from = 3) => {
    let prev = '';
    for (let len = from; len <= query.length; len++) {
      const prefix = query.slice(0, len);
      if (prefix.trim() === prev) continue;
      prev = prefix.trim();
      expect(top(prefix).slice(0, 3), `"${prefix}"`).toContain(want);
    }
  };
  it('keeps the song in the top 3 at every keystroke, including one-letter words', () => {
    stable('hey jude', 'the-beatles--hey-jude');
    stable('stairway to heaven', 'led-zeppelin--stairway-to-heaven');
    stable('smells like teen spirit', 'nirvana--smells-like-teen-spirit');
    stable('sweet home alabama', 'lynyrd-skynyrd--sweet-home-alabama');
    stable('another brick in the wall part 2', 'pink-floyd--another-brick-in-the-wall-part-2');
    stable('beatles hey jude', 'the-beatles--hey-jude', 9);
    stable('led zeppelin kashmir', 'led-zeppelin--kashmir', 14);
  });
  it('lets a single letter refine the previous words instead of replacing them', () => {
    expect(top('hey j').slice(0, 2)).toEqual(['the-beatles--hey-jude', 'jimi-hendrix--hey-joe']);
    expect(top('hey j')).toContain('pink-floyd--hey-you'); // the "hey" results stay, narrowed
    expect(top('hey j')).toContain('ll-cool-j--hey-lover'); // still found, ranked as the partial match it is
    expect(top('stairway to h')[0]).toBe('led-zeppelin--stairway-to-heaven');
    expect(top('stairway to h')).not.toContain('tool--h');
    expect(top('beatles h')[0]).toBe('the-beatles--help');
    expect(top('beatles h')).not.toContain('tool--h');
    expect(top('led z')[0]).toBe('led-zeppelin--stairway-to-heaven');
    expect(index.search('led z')[0].match.artist).toBe('exact');
    expect(top('led z')).not.toContain('dvorak--symfonie-z-noveho-sveta');
    expect(top('sweet h')[0]).toBe('lynyrd-skynyrd--sweet-home-alabama');
  });
  it('a letter that matches nothing keeps the previous list', () => {
    expect(top('hey q')).toEqual(top('hey'));
  });
  it('a two-letter last word narrows the previous list too', () => {
    expect(top('hey ju')[0]).toBe('the-beatles--hey-jude');
    expect(top('hey ju')).toContain('pink-floyd--hey-you');
    expect(top('hey ju')).not.toContain('boyz-ii-men--yesterday');
  });
  it('reads a trailing n as the start of a word, not as "and"', () => {
    expect(top('dont stop me n')[0]).toBe('queen--don-t-stop-me-now');
    expect(top('guns n r')[0]).toBe('guns-n-roses--sweet-child-o-mine');
  });
  it('does not turn an artist initial after a complete title into a title-and-artist match', () => {
    // at "dont stop m" the songs starting with "Don't Stop M..." come first, and neither
    // "Don't Stop" is promoted because its artist starts with m
    expect(top('dont stop m')[0]).toBe('queen--don-t-stop-me-now');
    const dontStop = index.search('dont stop m', 10).filter((h) => h.title === "Don't Stop");
    expect(dontStop.map((h) => h.match.artist)).toEqual(['none', 'none']);
  });
  it('treats a query ending in a space as complete words', () => {
    expect(top('hey jude ')[0]).toBe('the-beatles--hey-jude');
    expect(tokenize('guns n ', false)).toEqual(['guns', 'and']);
  });
});

describe('ranking: artist handling', () => {
  it('title plus artist in any order, with separators or "by"', () => {
    for (const q of ['yesterday beatles', 'beatles yesterday', 'the beatles - yesterday', 'yesterday by the beatles', 'beatles / yesterday']) {
      expect(top(q)[0], q).toBe('the-beatles--yesterday');
    }
    expect(top('hey jude by the beatles')[0]).toBe('the-beatles--hey-jude');
    expect(top('crazy aerosmith')[0]).toBe('aerosmith--crazy');
    expect(top('crazy seal')[0]).toBe('seal--crazy');
  });
  it('keeps "by" when it is part of the title', () => {
    expect(top('stand by me')[0]).toBe('ben-e-king--stand-by-me');
    expect(index.search('stand by me')[0].match.title).toBe('exact');
  });
  it('scales the artist-only tier by how well known the catalogue is', () => {
    // three one-transcription songs by a band called Sweet do not bury the famous Sweet titles
    expect(top('sweet').slice(0, 2)).toEqual(['neil-diamond--sweet-caroline', 'lynyrd-skynyrd--sweet-home-alabama']);
    expect(index.search('sweet', 10).filter((h) => h.artist === 'Sweet').length).toBe(3);
    // a big catalogue still comes first
    expect(index.search('queen', 3).every((h) => h.artist === 'Queen')).toBe(true);
  });
  it('needs most of an artist name before browsing the catalogue beats a title prefix', () => {
    // "led" alone is Led Zeppelin's songs only because nothing is titled "Led ..."; "beatl" is the Beatles
    expect(index.search('beatl', 5).every((h) => h.artist === 'The Beatles')).toBe(true);
    expect(index.search('beatl', 5)[0].match.artist).toBe('exact');
  });
  it('artist-only queries list that artist sorted by popularity, above title matches', () => {
    const hits = index.search('queen', 10);
    const queen = SONGS.filter((s) => s.artist === 'Queen').sort((a, b) => b.popularity! - a.popularity!);
    expect(hits.slice(0, queen.length).map((h) => h.id)).toEqual(queen.map((s) => s.id));
    expect(hits[queen.length].id).toBe('abba--dancing-queen');
    expect(hits[0].match.artist).toBe('exact');
  });
  it('ignores a leading "the" in artist names', () => {
    expect(index.search('beatles', 10).every((h) => h.artist === 'The Beatles')).toBe(true);
    expect(index.search('the beatles', 10).every((h) => h.artist === 'The Beatles')).toBe(true);
    expect(top('beatles')[0]).toBe('the-beatles--let-it-be');
  });
  it('matches "Last First" artists in the data from "First Last" queries', () => {
    expect(index.search('james brown', 10).map((h) => h.artist)).toEqual(['Brown James', 'James Brown', 'James Brown']);
    expect(top('james brown i feel good')[0]).toBe('brown-james--i-got-you');
    expect(top('i got you james brown')[0]).toBe('brown-james--i-got-you');
  });
  it('finds dotted and glued acronym artists', () => {
    expect(top('rem')[0]).toBe('r-e-m--losing-my-religion');
    expect(top('r.e.m. losing my religion')[0]).toBe('r-e-m--losing-my-religion');
    expect(index.search('acdc', 5).map((h) => h.artist)).toEqual(['AC DC', 'AC DC']);
    expect(top('ac/dc back in black')[0]).toBe('ac-dc--back-in-black');
    expect(top('tnt')[0]).toBe('ac-dc--tnt');
    expect(top('back in the ussr')[0]).toBe('the-beatles--back-in-the-u-s-s-r');
  });
  it('strips diacritics from the query', () => {
    expect(top('céline dion')[0]).toBe('celine-dion--my-heart-will-go-on');
  });
});

describe('ranking: a word of an artist name', () => {
  it('lists the artist above titles that contain the word', () => {
    expect(index.search('zeppelin', 3).every((h) => h.artist === 'Led Zeppelin')).toBe(true);
    expect(index.search('zeppelin')[0].match).toEqual({ title: 'none', artist: 'partial', coverage: 1, titleShare: 0 });
    expect(top('zeppelin')).toContain('nirvana--aero-zeppelin');
    expect(top('sabbath').slice(0, 2)).toEqual(['black-sabbath--paranoid', 'black-sabbath--sabbath-bloody-sabbath']);
    expect(index.search('cline', 2).every((h) => h.artist === 'Patsy Cline')).toBe(true); // not "Aline", a typo away
  });
  it('lets a title starting with the word win when the catalogue is small, and never resolves either', () => {
    expect(top('mercury').slice(0, 2)).toEqual(['alan-jackson--mercury-blues', 'freddie-mercury--living-on-my-own']);
    expect(index.resolve('mercury').kind).toBe('ambiguous');
    expect(index.resolve('zeppelin').kind).toBe('ambiguous');
  });
  it('keeps a common title word a title word', () => {
    expect(top('black')[0]).toBe('pearl-jam--black');
    expect(index.search('black', 10).slice(1, 5).every((h) => h.match.title === 'prefix')).toBe(true);
    expect(top('black')).not.toContain('black-sabbath--paranoid');
    expect(top('black sabbath')[0]).toBe('black-sabbath--paranoid');
  });
  it('prefers the biggest catalogue among the artists sharing the word', () => {
    expect(index.search('elvis', 3).map((h) => h.artist)).toEqual(['Elvis Presley', 'Elvis Presley', 'Elvis Presley']);
    expect(top('jackson')[0]).toBe('jackson-michael--bad');
    expect(top('in the ghetto elvis')[0]).toBe('elvis-presley--in-the-ghetto');
    const r = index.resolve('in the ghetto elvis');
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.entry.id).toBe('elvis-presley--in-the-ghetto');
  });
  it('treats a short last word as a word being typed', () => {
    expect(top('dan')[0]).toBe('abba--dancing-queen');
    // a trailing space says the word is complete, and "dan" is only ever an artist's word here:
    // Steely Dan's catalogue moves above the "Dan..." titles
    expect(top('dan ').slice(0, 3)).toEqual(['steely-dan--do-it-again', 'steely-dan--aja', 'abba--dancing-queen']);
  });
  it('matches the first word of a name without the glued alias deciding', () => {
    const hits = index.search('bowie', 5);
    expect(hits.map((h) => h.artist).sort()).toEqual(['BOWIE DAVID', 'David Bowie']);
    expect(hits.every((h) => h.match.artist === 'partial')).toBe(true);
    expect(index.search('acd')[0].artist).toBe('AC DC'); // "acd" crosses the first word of "acdc"
    expect(index.search('acd')[0].match.artist).toBe('exact');
  });
  it('ignores "the" and "and" in artist names', () => {
    expect(index.search('the who', 3).every((h) => h.artist === 'The Who')).toBe(true);
    expect(top('the who')[0]).toBe('the-who--pinball-wizard');
    expect(top('who are you')[0]).toBe('the-who--who-are-you');
    expect(top('guns roses')[0]).toBe('guns-n-roses--sweet-child-o-mine');
  });
  it('reads a complete short word as a word that lost its last letter', () => {
    expect(top('gun n roses')[0]).toBe('guns-n-roses--sweet-child-o-mine');
    expect(index.search('gun n roses')[0].match.artist).toBe('exact');
    expect(top('gun')[0]).toBe('soundgarden--gun');
  });
  it('names the artist a result list is about', () => {
    expect(leadArtist(index.search('zeppelin'))).toBe('Led Zeppelin');
    expect(leadArtist(index.search('queen'))).toBe('Queen');
    expect(leadArtist(index.search('yesterday'))).toBeNull();
    expect(leadArtist(index.search('killer queen'))).toBeNull();
    expect(leadArtist([])).toBeNull();
  });
});

describe('ranking: alternative titles', () => {
  it('a trailing parenthetical is a full title', () => {
    expect(top('i feel good')[0]).toBe('brown-james--i-got-you');
    expect(index.search('i feel good')[0].match.title).toBe('exact');
    expect(top('i feel fine')[0]).toBe('the-beatles--i-feel-fine');
    expect(top('i feel goo')[0]).toBe('brown-james--i-got-you');
    expect(index.search('i feel goo')[0].match.title).toBe('prefix');
    const r = index.resolve('i feel good');
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.entry.id).toBe('brown-james--i-got-you');
  });
  it('so is the apostrophe-split form', () => {
    expect(index.search('baba o riley')[0].match.title).toBe('exact');
  });
});

describe('ranking: typos, prefixes and glued words', () => {
  it('tolerates one typo in long words and two in very long ones', () => {
    expect(top('bohemian rapsody')[0]).toBe('queen--bohemian-rhapsody');
    expect(top('smels like teen spirit')[0]).toBe('nirvana--smells-like-teen-spirit');
    expect(top('bohemian rhapsodie')[0]).toBe('queen--bohemian-rhapsody');
  });
  it('does not let a typo match beat an exact match', () => {
    expect(top('think')[0]).toBe('james-brown--think');
    expect(index.search('think', 5).map((h) => h.id)).not.toContain('nirvana--lithium');
  });
  it('discounts a typo reading of a word that exists as typed', () => {
    // "roads" is a word of Take Me Home Country Roads: the phrase beats "Country Road" a letter away
    expect(top('country roads')[0]).toBe('john-denver--take-me-home-country-roads');
    expect(index.search('country roads')[1].match.title).toBe('fuzzy');
    expect(index.resolve('country roads').kind).toBe('ambiguous');
  });
  it('only accepts a swapped pair as a typo in four-letter words', () => {
    const wall = index.search('the wall', 10).map((h) => h.id);
    expect(wall).toContain('kansas--the-wall');
    expect(wall).not.toContain('backstreet-boys--the-call');
    expect(top('jhon lennon')[0]).toBe('john-lennon--imagine');
  });
  it('matches prefixes while typing', () => {
    expect(top('bohem')[0]).toBe('queen--bohemian-rhapsody');
    expect(top('smells li')[0]).toBe('nirvana--smells-like-teen-spirit');
    expect(top('wonderwal')[0]).toBe('oasis--wonderwall');
  });
  it('handles words glued together or split apart', () => {
    expect(top('wonder wall')[0]).toBe('oasis--wonderwall');
    expect(top('radio gaga')[0]).toBe('queen--radio-ga-ga');
    expect(top('teenspirit')[0]).toBe('nirvana--smells-like-teen-spirit');
  });
  it('handles punctuation variants', () => {
    expect(top("don't stop me now")[0]).toBe('queen--don-t-stop-me-now');
    expect(top('dont stop me now')[0]).toBe('queen--don-t-stop-me-now');
    expect(top("sweet child o' mine")[0]).toBe('guns-n-roses--sweet-child-o-mine');
    expect(top('sweet child of mine')[0]).toBe('guns-n-roses--sweet-child-o-mine');
    expect(top('baba o riley')[0]).toBe('the-who--baba-o-riley');
    expect(top("baba o'riley")[0]).toBe('the-who--baba-o-riley');
    expect(top('another brick in the wall part ii')[0]).toBe('pink-floyd--another-brick-in-the-wall-part-2');
  });
});

describe('ranking: glued words', () => {
  it('finds titles typed without their spaces, in either direction', () => {
    expect(top('obladi oblada')[0]).toBe('the-beatles--ob-la-di-ob-la-da');
    expect(index.search('obladi oblada')[0].match.title).toBe('fuzzy');
    expect(top('obladioblada')[0]).toBe('the-beatles--ob-la-di-ob-la-da');
    // the whole title without its spaces has every letter: a full match, not a fuzzy one
    expect(index.search('obladioblada')[0].match.title).toBe('exact');
    expect(index.resolve('obladi oblada').kind).toBe('ok');
    expect(index.resolve('obladioblada').kind).toBe('ok');
  });
  it('does not let a glued token match a field that has only one of its words', () => {
    // "teenspirit" is not the band Spirit, "radioga" is not the title "Radio"
    expect(top('teenspirit')[0]).toBe('nirvana--smells-like-teen-spirit');
    const spirit = index.search('teenspirit', 10).find((h) => h.id === 'spirit--i-got-a-line-on-you');
    expect(spirit?.match.artist ?? 'none').toBe('none');
    expect(top('radioga')[0]).toBe('queen--radio-ga-ga');
    const radio = index.search('radioga', 10).find((h) => h.id === 'the-corrs--radio');
    expect(radio?.match.title ?? 'none').not.toBe('fuzzy');
  });
  it('keeps a prefix reading when the glued reading also exists', () => {
    // "ima" is "Imagine" before it is "I'm a ..."
    expect(top('ima')[0]).toBe('john-lennon--imagine');
  });
});

describe('ranking: artist initials', () => {
  it('finds multi-word artists by their initials, as a catalogue', () => {
    expect(index.search('ccr', 5).map((h) => h.id)).toEqual(['creedence-clearwater-revival--bad-moon-rising', 'creedence-clearwater-revival--proud-mary']);
    expect(index.search('ccr')[0].match.artist).toBe('exact');
    expect(index.search('rhcp', 5).every((h) => h.artist === 'Red Hot Chili Peppers')).toBe(true);
    expect(top('elo')[0]).toBe('electric-light-orchestra--mr-blue-sky');
    expect(top('gnr')[0]).toBe('guns-n-roses--sweet-child-o-mine'); // the "n" counts
    expect(leadArtist(index.search('ccr'))).toBe('Creedence Clearwater Revival');
    expect(index.resolve('ccr').kind).toBe('ambiguous');
  });
  it('never reaches initials through a prefix or a typo, and skips tiny catalogues', () => {
    expect(index.search('rhc', 10).map((h) => h.artist)).not.toContain('Red Hot Chili Peppers');
    expect(index.search('rhpc', 10).map((h) => h.artist)).not.toContain('Red Hot Chili Peppers');
    expect(index.search('ldr', 10)).toEqual([]);
  });
});

describe('ranking: an unknown exact title against a famous song or a catalogue', () => {
  it('lists a one-transcription exact title from an artist with nothing else after a much more popular song containing the words', () => {
    // Duke Robillard, Kansas and Toto have a single song each in this fixture
    expect(top('rule the world').slice(0, 2)).toEqual(['tears-for-fears--everybody-wants-to-rule-the-world', 'duke-robillard--rule-the-world']);
    expect(top('the wall')[0]).toBe('pink-floyd--another-brick-in-the-wall-part-2');
    expect(top('99').slice(0, 2)).toEqual(['nena--99-luftballons', 'toto--99']);
    expect(index.resolve('rule the world').kind).toBe('ambiguous');
  });
  it('keeps an exact title first when its artist has other songs, however popular the song containing the words', () => {
    expect(top('respect').slice(0, 2)).toEqual(['aretha-franklin--respect', 'erasure--a-little-respect']);
    // ...and the same song with nothing else to the artist's name is demoted
    const lone = createIndex(SONGS.filter((e) => !e.id.startsWith('aretha-franklin--') || e.id === 'aretha-franklin--respect'));
    expect(lone.search('respect', 2).map((h) => h.id)).toEqual(['erasure--a-little-respect', 'aretha-franklin--respect']);
  });
  it('does not treat a cover of a well-known title as unknown', () => {
    // Clayderman's one-transcription "Yesterday" stays with the other Yesterdays, above Yesterday Once More
    expect(top('yesterday').slice(0, 3)).toEqual(['the-beatles--yesterday', 'boyz-ii-men--yesterday', 'clayderman-richard--yesterday']);
  });
  it('keeps the exact title first when the rival is at most twice as popular', () => {
    expect(top('gun')[0]).toBe('soundgarden--gun'); // Smoking Gun has 2 transcriptions
    expect(top('hero')[0]).toBe('mariah-carey--hero');
  });
  it('lists a composer before a song titled with his name', () => {
    expect(index.search('mozart', 3).every((h) => h.artist === 'Wolfgang Amadeus Mozart')).toBe(true);
    expect(top('mozart')).toContain('suzanne-ciani--mozart');
    expect(index.resolve('mozart').kind).toBe('ambiguous');
    expect(top('beethoven').slice(0, 2)).toEqual(['ludwig-van-beethoven--5th-symphony', 'ludwig-van-beethoven--fur-elise']);
    expect(top('beethoven')).toContain('the-beatles--roll-over-beethoven');
  });
  it('does not read a bare "the" as the artist\'s', () => {
    // "the wall" is not "The" Offspring plus a prefix of "Walla Walla"
    const offspring = index.search('the wall', 20).find((h) => h.id === 'the-offspring--walla-walla');
    expect(offspring?.match.title ?? 'none').toBe('partial');
    expect(top('the wall').indexOf('the-offspring--walla-walla')).toBeGreaterThan(top('the wall').indexOf('kansas--the-wall'));
  });
});

describe('ranking: duplicate transcriptions and ties', () => {
  it('lets the most transcribed duplicate of a song lead, whichever spelling was typed', () => {
    expect(top('living on a prayer').slice(0, 2)).toEqual(['bon-jovi--livin-on-a-prayer', 'bon-jovi--living-on-a-prayer']);
    expect(top('livin on a prayer').slice(0, 2)).toEqual(['bon-jovi--livin-on-a-prayer', 'bon-jovi--living-on-a-prayer']);
    expect(top('smell like teen spirit').slice(0, 3)).toEqual(['nirvana--smells-like-teen-spirit', 'nirvana--smell-like-teen-spirit', 'amos-tori--smells-like-teen-spirit']);
    // the pair shares one score, so they stay adjacent
    const [a, b] = index.search('living on a prayer', 2);
    expect(a.score).toBe(b.score);
  });
  it('does not merge the same title by different artists', () => {
    expect(top('yesterday').slice(0, 3)).toEqual(['the-beatles--yesterday', 'boyz-ii-men--yesterday', 'clayderman-richard--yesterday']);
    expect(index.search('yesterday', 2).map((h) => h.score)).not.toEqual([index.search('yesterday', 1)[0].score, index.search('yesterday', 1)[0].score]);
  });
  it('breaks a tie on score and popularity by the size of the artist\'s catalogue', () => {
    expect(top('the entertainer').slice(0, 2)).toEqual(['scott-joplin--the-entertainer', 'marvin-hamlisch--the-entertainer']);
    expect(index.resolve('the entertainer').kind).toBe('ambiguous');
  });
});

describe('ranking: covers', () => {
  it('demotes karaoke/tribute artists unless the query names them', () => {
    expect(top('lithium')[0]).toBe('nirvana--lithium');
    expect(top('lithium karaoke hits')[0]).toBe('karaoke-hits--lithium');
    expect(top('karaoke party')[0]).toBe('karaoke-hits--karaoke-party');
  });
});

describe('determinism', () => {
  it('returns identical results for repeated and interleaved queries', () => {
    const a = index.search('yesterday', 10);
    index.search('queen', 10);
    index.search('zzz nothing', 10);
    const b = index.search('yesterday', 10);
    expect(b).toEqual(a);
  });
  it('does not depend on the order of the entries', () => {
    const reversed = createIndex([...SONGS].reverse());
    for (const q of ['yesterday', 'queen', 'crazy', 'teen spirit', 'james brown', 'help']) {
      expect(reversed.search(q, 10).map((h) => h.id), q).toEqual(index.search(q, 10).map((h) => h.id));
    }
  });
  it('respects the limit, and tolerates a bad one', () => {
    expect(index.search('the', 3)).toHaveLength(3);
    expect(index.search('yesterday', 1)).toHaveLength(1);
    expect(index.search('yesterday', 0)).toEqual([]);
    expect(index.search('yesterday', -1)).toEqual([]);
    expect(index.search('yesterday', 2.7)).toHaveLength(2);
    expect(index.search('yesterday', NaN).length).toBeGreaterThan(0);
  });
});

describe('resolve', () => {
  it('reports no match', () => {
    expect(index.resolve('xqzv').kind).toBe('none');
  });
  it('does not guess when most of the query is unexplained', () => {
    expect(index.resolve('xqzv wonderwall').kind).toBe('ambiguous');
    expect(index.search('xqzv wonderwall')[0].match.coverage).toBeLessThanOrEqual(0.5);
    expect(index.resolve('wonderwall oasis').kind).toBe('ok');
  });
  it('accepts an exact title with a single artist', () => {
    const r = index.resolve('bohemian rhapsody');
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.entry.id).toBe('queen--bohemian-rhapsody');
  });
  it('accepts an exact title shared by several artists when one is clearly the original', () => {
    const r = index.resolve('yesterday');
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.entry.id).toBe('the-beatles--yesterday');
  });
  it('flags an exact title shared by several artists of similar popularity', () => {
    const r = index.resolve('crazy');
    expect(r.kind).toBe('ambiguous');
    expect(r.hits.map((h) => h.id).slice(0, 2)).toEqual(['seal--crazy', 'aerosmith--crazy']);
  });
  it('accepts title plus artist, and partial titles with a clear winner', () => {
    expect(index.resolve('crazy seal').kind).toBe('ok');
    expect(index.resolve('teen spirit').kind).toBe('ok');
    expect(index.resolve('smels like teen spirit').kind).toBe('ok');
  });
  it('treats duplicate transcriptions of the same song as one candidate', () => {
    const dup = createIndex([...SONGS, song('beatles--yesterday', 'Yesterday', 'Beatles', 8)]);
    const r = dup.resolve('yesterday');
    expect(r.kind).toBe('ok');
  });
  it('never accepts a query ending in a single letter', () => {
    for (const q of ['led z', 'hey j', 'beatles h', 'stairway to h']) expect(index.resolve(q).kind, q).toBe('ambiguous');
  });
  it('flags a typo that is as close to another full title', () => {
    const r = index.resolve('heros');
    expect(r.kind).toBe('ambiguous');
    expect(r.hits.slice(0, 2).map((h) => h.id)).toEqual(['mariah-carey--hero', 'david-bowie--heroes']);
  });
  it('flags a half-typed title with several completions, accepts one with a single completion', () => {
    expect(index.resolve('jungle').kind).toBe('ambiguous');
    expect(index.resolve('bohemian rhapsod').kind).toBe('ok');
    // a lone fragment of a word is not the one title starting with it: "kash" is not Kashmir yet
    expect(index.resolve('kash').kind).toBe('ambiguous');
    expect(index.resolve('kashmi').kind).toBe('ok');
    const r = index.resolve('wonderwal'); // "Wonderful" is a typo away but scores far below
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.entry.id).toBe('oasis--wonderwall');
  });
  it('does not accept an artist name as a song', () => {
    expect(index.resolve('queen').kind).toBe('ambiguous');
    expect(index.resolve('led zeppelin').kind).toBe('ambiguous');
  });
  it('accepts a phrase that covers half the title, or comes with the artist', () => {
    for (const [q, id] of [
      ['teen spirit', 'nirvana--smells-like-teen-spirit'],
      ['bites the dust', 'queen--another-one-bites-the-dust'],
      ['the wall pink floyd', 'pink-floyd--another-brick-in-the-wall-part-2'],
    ]) {
      const r = index.resolve(q);
      expect(r.kind, q).toBe('ok');
      if (r.kind === 'ok') expect(r.entry.id).toBe(id);
    }
  });
  it('does not replace a song that is not in the database by one sharing a word', () => {
    // half of "lose yourself" is unexplained by Express Yourself, however popular
    const lose = index.resolve('lose yourself');
    expect(lose.kind).toBe('ambiguous');
    expect(lose.hits[0].match.coverage).toBeLessThan(0.8);
    // "titanic" is one word of four
    const titanic = index.resolve('titanic');
    expect(titanic.kind).toBe('ambiguous');
    expect(titanic.hits[0].match).toMatchObject({ title: 'phrase', titleShare: 0.25 });
    // two words of five, without the artist
    expect(index.resolve('standing there').kind).toBe('ambiguous');
    // the words in the wrong order never resolve
    expect(index.resolve('spirit teen').kind).toBe('ambiguous');
  });
  it('flags an exact title that is also an artist\'s name', () => {
    expect(index.resolve('mozart').kind).toBe('ambiguous');
  });
  it('flags an exact title against a clearly more popular song that starts with or contains it', () => {
    expect(index.resolve('respect').kind).toBe('ambiguous'); // A Little Respect has five transcriptions
    expect(index.resolve('the wall').kind).toBe('ambiguous');
    expect(index.resolve('gun').kind).toBe('ambiguous'); // Smoking Gun has two: not clearly more popular, but Gun is a lone song
    // Hero (5) against Heroes (1): clear
    const hero = index.resolve('hero');
    expect(hero.kind).toBe('ok');
    if (hero.kind === 'ok') expect(hero.entry.id).toBe('mariah-carey--hero');
  });
  it('flags an exact title nobody else transcribed, from an artist with nothing else, against an equally popular longer title', () => {
    expect(index.search('lola', 2).map((h) => h.id)).toEqual(['allan-theo--lola', 'the-kinks--lola-live-1977']);
    expect(index.resolve('lola').kind).toBe('ambiguous');
    // the same with a catalogue behind the exact title is clear
    const known = createIndex([...SONGS, song('allan-theo--emmene-moi', 'Emmene-moi', 'Allan Theo', 3)]);
    expect(known.resolve('lola').kind).toBe('ok');
  });
  it('hands back the most transcribed duplicate of the song', () => {
    for (const [q, id] of [
      ['living on a prayer', 'bon-jovi--livin-on-a-prayer'],
      ['livin on a prayer', 'bon-jovi--livin-on-a-prayer'],
      ['smell like teen spirit', 'nirvana--smells-like-teen-spirit'],
    ]) {
      const r = index.resolve(q);
      expect(r.kind, q).toBe('ok');
      if (r.kind === 'ok') expect(r.entry.id, q).toBe(id);
    }
  });
});

describe.skipIf(!fs.existsSync(DB_INDEX))('real database', () => {
  const entries: IndexEntry[] = JSON.parse(fs.readFileSync(DB_INDEX, 'utf8'));
  it('builds quickly and answers quickly', () => {
    const t0 = performance.now();
    const real = createIndex(entries);
    const build = performance.now() - t0;
    expect(build).toBeLessThan(300);
    const queries = ['the beatles', 'bohemian rapsody', 'yesterday', 'a', 's', 'the h', 'smells like teen spirit nirvana', 'love', 'stairway to heaven led zeppelin'];
    for (const q of queries) real.search(q);
    const t1 = performance.now();
    for (let i = 0; i < 20; i++) for (const q of queries) real.search(q);
    const perQuery = (performance.now() - t1) / (20 * queries.length);
    expect(perQuery).toBeLessThan(5);
  });
  it('gets the classics right', () => {
    const real = createIndex(entries);
    expect(real.search('bohemian rapsody')[0].id).toBe('queen--bohemian-rhapsody');
    expect(real.search('smels like teen spirit')[0].id).toBe('nirvana--smells-like-teen-spirit');
    expect(real.search('hey jude by the beatles')[0].id).toBe('the-beatles--hey-jude');
    expect(real.search('beatles - yesterday')[0].id).toBe('the-beatles--yesterday');
    expect(real.search('queen', 10).every((h) => h.artist === 'Queen')).toBe(true);
    expect(real.search('hey j')[0].id).toBe('the-beatles--hey-jude');
    expect(real.search('hey ju', 3).every((h) => /^Hey/.test(h.title))).toBe(true);
    expect(real.search('led z', 5).every((h) => h.artist === 'Led Zeppelin')).toBe(true);
    expect(real.resolve('heros').kind).toBe('ambiguous');
    expect(real.search('respect')[0].id).toBe('aretha-franklin--respect');
    expect(real.search('the entertainer')[0].id).toBe('scott-joplin--the-entertainer');
    expect(real.search('living on a prayer')[0].id).toBe('bon-jovi--livin-on-a-prayer');
    expect(real.resolve('lola').kind).toBe('ambiguous');
  });
});

// ---------------------------------------------------------------------------
// Round 3: duplicates are strict, numbered parts are different songs, digits and
// one-letter words are words, "clearly the original" counts transcriptions.

const PARTS: IndexEntry[] = [
  ...SONGS,
  song('pink-floyd--another-brick-in-the-wall', 'Another Brick In The Wall (Part II)', 'Pink Floyd', 4, ['mcgill']),
  song('pink-floyd--another-brick-in-the-wall-part-1', 'Another Brick in the Wall, Part 1', 'Pink Floyd', 1),
  song('pink-floyd--another-brick-in-the-wall-part-3', 'Another Brick in the Wall, Part 3', 'Pink Floyd', 1),
  song('pink-floyd--another-brick-in-the-wall-part-i', 'Another Brick in the Wall, Part I', 'Pink Floyd', 1),
  song('jean-michel-jarre--oxygene-part-1', 'Oxygene, Part 1', 'Jean Michel Jarre', 1),
  song('jean-michel-jarre--oxygene-part-4', 'Oxygene, Part 4', 'Jean Michel Jarre', 5),
  song('jean-michel-jarre--oxygene-part-6', 'Oxygene, Part 6', 'Jean Michel Jarre', 3),
  song('jean-michel-jarre--equinox-part-4', 'Equinox Part 4', 'Jean Michel Jarre', 1),
  song('jean-michel-jarre--equinoxe-part-4', 'Equinoxe, Part 4', 'Jean Michel Jarre', 1),
  song('amy-grant--stay-for-a-while', 'Stay for a While', 'Amy Grant', 1),
  song('amy-grant--stay-for-awhile', 'Stay for Awhile', 'Amy Grant', 2),
  song('meat-loaf--i-ll-do-anything-for-love', "I'll Do Anything for Love (But I Won't Do That)", 'Meat Loaf', 1),
  song('meat-loaf--i-d-do-anything-for-love', "I'd Do Anything for Love (But I Won't Do That)", 'Meat Loaf', 3),
  song('nomadi--dio-morto', 'Dio Morto', 'Nomadi', 1),
  song('nomadi--dio-e-morto', 'Dio e Morto', 'Nomadi', 2),
  song('commodores--brick-house', 'Brick House', 'Commodores', 4),
  song('commodores--brickhouse', 'Brickhouse', 'Commodores', 1),
  song('lynyrd-skynyrd--free-bird', 'Free Bird', 'Lynyrd Skynyrd', 1),
  song('lynyrd-skynyrd--simple-man', 'Simple Man', 'Lynyrd Skynyrd', 3),
  song('will-to-power--baby-i-love-your-way', 'Baby I Love Your Way (Freebird)', 'Will to Power', 2),
  song('lou-bega--mambo-no-5', 'Mambo No. 5 (A Little Bit Of...)', 'Lou Bega', 1),
  song('prince--nothing-compares-2-u', 'Nothing Compares 2 U', 'Prince', 2),
  song('blur--song-2', 'Song 2', 'Blur', 3),
  song('bobby-womack--sweet-caroline', 'Sweet Caroline (Good Times Never Seemed So Good)', 'Bobby Womack', 4, ['mcgill']),
  song('michael-george--careless-whisper', 'Careless Whisper', 'Michael George', 4),
  song('michael-george--faith', 'Faith', 'Michael George', 5),
  song('michael-george--fastlove', 'Fastlove', 'Michael George', 3),
  song('wham--careless-whisper', 'Careless Whisper', 'Wham!', 3),
  song('wham--wake-me-up-before-you-go-go', 'Wake Me Up Before You Go-Go', 'Wham!', 2),
  song('toy-boy--careless-whisper', 'Careless Whisper', 'Toy Boy', 1),
];
const parts = createIndex(PARTS);
const resolved = (idx: ReturnType<typeof createIndex>, q: string) => {
  const r = idx.resolve(q);
  return r.kind === 'ok' ? r.entry.id : r.kind;
};

describe('duplicate titles', () => {
  it('counts MIDI transcriptions without the chart bonus', () => {
    expect(transcriptions(song('x', 'X', 'Y', 7))).toBe(7);
    expect(transcriptions(song('x', 'X', 'Y', 4, ['mcgill']))).toBe(0);
    expect(transcriptions(song('x', 'X', 'Y', 6, ['mcgill', 'midi']))).toBe(2);
    expect(transcriptions({ popularity: undefined, sources: ['midi'] })).toBe(0);
  });
  it('accepts one misspelt word, or the same letters spaced differently', () => {
    expect(isDuplicateTitle("Livin' On A Prayer", 'Living on a Prayer')).toBe(true);
    expect(isDuplicateTitle('Smell Like Teen Spirit', 'Smells Like Teen Spirit')).toBe(true);
    expect(isDuplicateTitle('Elenor Rigby', 'Eleanor Rigby')).toBe(true);
    expect(isDuplicateTitle('Equinox Part 4', 'Equinoxe, Part 4')).toBe(true);
    expect(isDuplicateTitle('Brick House', 'Brickhouse')).toBe(true);
    expect(isDuplicateTitle('Fu-Gee-La', 'Fugeela')).toBe(true);
    expect(isDuplicateTitle('Stay for a While', 'Stay for Awhile')).toBe(true);
    expect(isDuplicateTitle('Another Brick In The Wall (Part II)', 'Another Brick in the Wall, Part 2')).toBe(true);
    expect(isDuplicateTitle('I Got You (I Feel Good)', 'I Got You')).toBe(true);
  });
  it('never merges a different number, numeral, short word or extra word', () => {
    expect(isDuplicateTitle('Another Brick in the Wall, Part 1', 'Another Brick in the Wall, Part 2')).toBe(false);
    expect(isDuplicateTitle('Another Brick in the Wall, Part I', 'Another Brick in the Wall, Part 2')).toBe(false);
    expect(isDuplicateTitle('Another Brick In The Wall (Part II)', 'Another Brick in the Wall, Part 1')).toBe(false);
    expect(isDuplicateTitle('Oxygene, Part 4', 'Oxygene, Part 6')).toBe(false);
    expect(isDuplicateTitle('Chronologie, Part 2', 'Chronologie, Part 3')).toBe(false);
    expect(isDuplicateTitle('Symphony No. 5', 'Symphony No. 9')).toBe(false);
    expect(isDuplicateTitle("I'll Do Anything for Love", "I'd Do Anything for Love")).toBe(false);
    expect(isDuplicateTitle('Dio Morto', 'Dio e Morto')).toBe(false);
    expect(isDuplicateTitle('Hero', 'Heroes')).toBe(false); // four letters: only a swap is a typo
    expect(isDuplicateTitle('The Wall', 'The Call')).toBe(false);
    expect(isDuplicateTitle('Calypso (Part 1)', 'Calypso, Part 2')).toBe(false);
    expect(isDuplicateTitle('', 'Anything')).toBe(false);
  });
  it('works on word lists too', () => {
    expect(sameSongTitle(['part', '1'], ['part', '2'])).toBe(false);
    expect(sameSongTitle(['brick', 'house'], ['brickhouse'])).toBe(true);
    expect(sameSongTitle([], [])).toBe(true);
    expect(sameSongTitle([], ['x'])).toBe(false);
  });
});

describe('ranking: numbered parts are different songs', () => {
  const ids = (q: string, n = 5) => parts.search(q, n).map((h) => h.id);
  it('ranks the part asked for first, with or without the artist', () => {
    expect(ids('another brick in the wall part 1')[0]).toMatch(/part-(1|i)$/);
    expect(ids('another brick in the wall part 3')[0]).toBe('pink-floyd--another-brick-in-the-wall-part-3');
    expect(ids('another brick in the wall part 1 pink floyd')[0]).toMatch(/part-(1|i)$/);
    expect(ids('pink floyd another brick in the wall part 2')[0]).toBe('pink-floyd--another-brick-in-the-wall-part-2');
    expect(ids('oxygene part 1 jean michel jarre')[0]).toBe('jean-michel-jarre--oxygene-part-1');
    expect(ids('oxygene part 6')[0]).toBe('jean-michel-jarre--oxygene-part-6');
  });
  it('does not let a more transcribed part share its score with the others', () => {
    const hits = parts.search('another brick in the wall part 1', 5);
    const p1 = hits.find((h) => h.id.endsWith('part-1'))!;
    const p2 = hits.find((h) => h.id.endsWith('part-2'))!;
    expect(p1.score).toBeGreaterThan(p2.score);
    const ox = parts.search('oxygene part', 10).map((h) => h.id);
    for (const p of [1, 4, 6]) expect(ox).toContain(`jean-michel-jarre--oxygene-part-${p}`);
  });
  it('still shares the score of true duplicates, letter-perfect spelling first', () => {
    const [a, b] = parts.search('equinoxe part 4', 2);
    expect([a.id, b.id]).toEqual(['jean-michel-jarre--equinoxe-part-4', 'jean-michel-jarre--equinox-part-4']);
    expect(a.score).toBe(b.score);
    expect(parts.search('brickhouse', 2).map((h) => h.id)).toEqual(['commodores--brick-house', 'commodores--brickhouse']);
    // the McGill "(Part II)" and the MIDI "Part 2" are one song
    const [x, y] = parts.search('another brick in the wall part 2', 2);
    expect([x.id, y.id]).toEqual(['pink-floyd--another-brick-in-the-wall-part-2', 'pink-floyd--another-brick-in-the-wall']);
    expect(x.score).toBe(y.score);
  });
});

describe('ranking: a title typed without its spaces', () => {
  it('is a full, letter-perfect match of the title, above the medley whose parenthetical is that word', () => {
    const hits = parts.search('freebird', 3);
    expect(hits.map((h) => h.id)).toEqual(['lynyrd-skynyrd--free-bird', 'will-to-power--baby-i-love-your-way', 'the-beatles--i-feel-fine'].slice(0, hits.length));
    expect(hits[0].match.title).toBe('exact');
    expect(hits[1].match.title).toBe('exact');
    expect(parts.search('obladioblada', 1)[0].match.title).toBe('exact');
    expect(parts.search('free bird', 1)[0].id).toBe('lynyrd-skynyrd--free-bird');
  });
  it('does not match a title that has only one word of the run', () => {
    expect(parts.search('freebird', 10).some((h) => h.id === 'the-beatles--i-feel-fine')).toBe(false);
  });
});

describe('resolve: never a silent substitute', () => {
  it('hands back the part asked for, never a more transcribed sibling', () => {
    expect(resolved(parts, 'another brick in the wall part 1 pink floyd')).toBe('pink-floyd--another-brick-in-the-wall-part-1');
    expect(resolved(parts, 'another brick in the wall part 3')).toBe('pink-floyd--another-brick-in-the-wall-part-3');
    expect(resolved(parts, 'oxygene part 1 jean michel jarre')).toBe('jean-michel-jarre--oxygene-part-1');
    expect(resolved(parts, 'oxygene part 6')).toBe('jean-michel-jarre--oxygene-part-6');
    expect(resolved(parts, 'oxygene part 4')).toBe('jean-michel-jarre--oxygene-part-4');
    expect(resolved(parts, "i'll do anything for love meat loaf")).toBe('meat-loaf--i-ll-do-anything-for-love');
    expect(resolved(parts, 'dio morto nomadi')).toBe('nomadi--dio-morto');
  });
  it('still hands back the most transcribed strict duplicate', () => {
    expect(resolved(parts, 'brickhouse')).toBe('commodores--brick-house');
    expect(resolved(parts, 'stay for a while amy grant')).toBe('amy-grant--stay-for-awhile');
    expect(resolved(parts, 'equinox part 4')).toMatch(/equinoxe?-part-4$/);
    expect(resolved(parts, 'another brick in the wall part ii')).toBe('pink-floyd--another-brick-in-the-wall-part-2');
  });
  it('lists the glued title and its rival instead of compiling the medley', () => {
    const r = parts.resolve('freebird');
    expect(r.kind).toBe('ambiguous');
    expect(r.hits[0].id).toBe('lynyrd-skynyrd--free-bird');
    expect(resolved(parts, 'free bird lynyrd skynyrd')).toBe('lynyrd-skynyrd--free-bird');
  });
});

describe('resolve: a single character at the end', () => {
  it('is still typing only when it is a letter, not followed by a space, and not a word of the exact title', () => {
    for (const q of ['led z', 'hey j', 'beatles h', 'stairway to h', 'hey j ']) expect(resolved(parts, q), q).toBe('ambiguous');
    expect(resolved(parts, 'nothing compares 2 u')).toBe('prince--nothing-compares-2-u');
    expect(resolved(parts, 'mambo no 5')).toBe('lou-bega--mambo-no-5');
    expect(resolved(parts, 'song 2')).toBe('blur--song-2');
    expect(resolved(parts, 'pink floyd another brick in the wall part 2')).toBe('pink-floyd--another-brick-in-the-wall-part-2');
    expect(resolved(parts, 'tool h')).toBe('tool--h');
  });
});

describe('resolve: clearly the original among artists sharing a title', () => {
  it('counts transcriptions, not the chart bonus', () => {
    expect(resolved(parts, 'sweet caroline')).toBe('neil-diamond--sweet-caroline');
  });
  it('accepts more transcriptions from a catalogue at least twice as big', () => {
    expect(resolved(parts, 'careless whisper')).toBe('michael-george--careless-whisper');
    expect(resolved(parts, 'crazy')).toBe('ambiguous'); // Seal 5 vs Aerosmith 3, catalogues 5 vs 3
    // counter-fixture: give Wham! a catalogue as big as George Michael's and the margin is gone
    const even = createIndex([...PARTS, song('wham--club-tropicana', 'Club Tropicana', 'Wham!', 7)]);
    expect(resolved(even, 'careless whisper')).toBe('ambiguous');
    // ...and with fewer than three transcriptions nothing is clear
    const few = createIndex(PARTS.map((e) => (e.id === 'michael-george--careless-whisper' ? { ...e, popularity: 2 } : e.id === 'wham--careless-whisper' ? { ...e, popularity: 1 } : e)));
    expect(resolved(few, 'careless whisper')).toBe('ambiguous');
  });
});

describe.skipIf(!fs.existsSync(DB_INDEX))('real database: round 3', () => {
  const entries: IndexEntry[] = JSON.parse(fs.readFileSync(DB_INDEX, 'utf8'));
  const real = createIndex(entries);
  it('never substitutes another part of a suite', () => {
    expect(resolved(real, 'another brick in the wall part 1 pink floyd')).toBe('pink-floyd--another-brick-in-the-wall-part-1');
    expect(resolved(real, 'oxygene part 1 jean michel jarre')).toBe('jean-michel-jarre--oxygene-part-1');
    expect(resolved(real, 'chronologie part 2 jarre')).toBe('jean-michel-jarre--chronologie-part-2');
    expect(resolved(real, 'pink floyd another brick in the wall part 2')).toBe('pink-floyd--another-brick-in-the-wall-part-2');
    expect(resolved(real, "i'll do anything for love meat loaf")).toBe('meat-loaf--ill-do-anything-for-love-but-i-wont-do-that');
  });
  it('reads digits and one-letter words as words', () => {
    expect(resolved(real, 'mambo no 5')).toBe('lou-bega--mambo-no-5-a-little-bit-of');
    expect(resolved(real, 'nothing compares 2 u')).toBe('prince--nothing-compares-2-u');
    expect(resolved(real, 'hey j')).toBe('ambiguous');
  });
  it('finds a title typed without its spaces and does not compile the medley', () => {
    expect(real.search('freebird', 1)[0].id).toBe('lynyrd-skynyrd--free-bird');
    expect(resolved(real, 'freebird')).not.toBe('will-to-power--baby-i-love-your-way');
  });
  it('resolves a shared title when the original clearly has the transcriptions', () => {
    expect(resolved(real, 'sweet caroline')).toBe('neil-diamond--sweet-caroline');
    expect(resolved(real, 'careless whisper')).toBe('michael-george--careless-whisper');
    expect(resolved(real, 'crazy')).toBe('ambiguous');
    expect(resolved(real, 'the entertainer')).toBe('ambiguous');
  });
});
