import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import type { IndexEntry } from '@strudelify/core';
import { bakeLanding, exampleIds } from '../src/landing.js';
import { songPath, songIdFromPath, artistSlug, artistPath, setArtistAliases, canonicalArtists, setBase, sitePath, isHomePath } from '../src/ui.js';
import { readCovers, coverLine, COVERS_HEADER } from '../src/covers.js';
import { STATIC_CODE_LINES, songPage, homePage, notFoundPage, artists, artistPage, artistsPage, letterOf, sitemap, robots, songTitle, songDescription, compact, LANDING_POOL_SCRIPT } from '../src/prerender.js';

const entry = (id: string, title: string, artist: string, extra: Partial<IndexEntry> = {}): IndexEntry => ({ id, title, artist, sources: ['midi'], files: { midi: `songs/${id}.mid` }, ...extra });
const entries: IndexEntry[] = [
  entry('dire-straits--sultans-of-swing', 'Sultans of Swing', 'Dire Straits', { bpm: 153, key: 'C major', year: 1978, popularity: 14 }),
  entry('dire-straits--money-for-nothing', 'Money for Nothing', 'Dire Straits', { popularity: 9 }),
  entry('dire-straits--money-for-nothing-2', 'Money For Nothing', 'Dire Straits', { popularity: 2 }),
  entry('the-beatles--let-it-be', 'Let It Be', 'The Beatles', { key: 'A# major', bpm: 72 }),
  entry('pdmx--123', 'Kiki’s Theme <b>', '久石譲', { sources: ['midi'], provenance: { provider: 'pdmx', url: 'https://musescore.com/score/123', license: 'cc0' } }),
];
setArtistAliases(canonicalArtists(entries));
const shell = bakeLanding(fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8'), entries);
const site = 'https://strudelify.example';
const ldOf = (html: string) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));

describe('addresses', () => {
  it('puts songs and artists at folder addresses and reads a song back from its address', () => {
    expect(songPath('queen--bohemian-rhapsody')).toBe('/song/queen--bohemian-rhapsody/');
    for (const path of ['/song/queen--bohemian-rhapsody/', '/song/queen--bohemian-rhapsody']) expect(songIdFromPath(path)).toBe('queen--bohemian-rhapsody');
    expect(songIdFromPath('/song/%E0%A4%A/')).toBe('%E0%A4%A'); // a malformed escape is taken as typed
    for (const path of ['/', '/artist/queen/', '/song/', '/song/a/b/']) expect(songIdFromPath(path)).toBeNull();
    expect(artistSlug('The Beatles')).toBe('the-beatles');
    expect(artistSlug('Simon & Garfunkel')).toBe('simon-and-garfunkel');
    expect(artistSlug('Sigur Rós')).toBe('sigur-ros');
    expect(artistSlug('久石譲')).toMatch(/^a-[0-9a-z]+$/); // no Latin letter: named by its hash, never empty
    expect(artistPath('Dire Straits')).toBe('/artist/dire-straits/');
  });
});

describe('song pages', () => {
  const page = songPage(shell, entries[0], entries.slice(0, 3), { code: 'setcpm(153/4)\nconst bass = note("<d2 c2>")' }, site);
  it('names the page: title, description, canonical address, Open Graph card and icons', () => {
    expect(page).toContain('<title>Sultans of Swing — Dire Straits: Strudel code · Strudelify</title>');
    expect(page.match(/<meta name="description"/g)).toHaveLength(1);
    expect(page).toContain('<meta name="description" content="Sultans of Swing by Dire Straits as Strudel live-coding code: play it, edit it, open it in strudel.cc. From a MIDI transcription (C major, 153 bpm)." />');
    expect(page).toContain(`<link rel="canonical" href="${site}/song/dire-straits--sultans-of-swing/" />`);
    expect(page).toContain(`<meta property="og:image" content="${site}/og.png" />`);
    expect(page).toContain('<meta property="og:type" content="music.song" />');
    expect(page).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml" />');
    expect(page).not.toContain('<link rel="icon" href="data:');
  });
  it('describes the song in structured data, with its artist and the way there', () => {
    const [ld] = ldOf(page);
    const [work, trail] = ld['@graph'];
    expect(work).toMatchObject({ '@type': 'MusicComposition', name: 'Sultans of Swing', musicalKey: 'C major', dateCreated: '1978', recordedAs: { byArtist: { name: 'Dire Straits', url: `${site}/artist/dire-straits/` } } });
    expect(trail.itemListElement.map((i: { name: string }) => i.name)).toEqual(['Home', 'Artists', 'Dire Straits', 'Sultans of Swing']);
  });
  it("opens on the song: its facts, its code as text and the artist's other songs, without the landing pool", () => {
    expect(page).toContain('<section id="song" class="song" aria-label="Song">');
    expect(page).toContain('<section id="empty" class="empty" hidden aria-label="Introduction">');
    expect(page).toContain('<h1 id="title" class="title lg">Sultans of Swing</h1>');
    expect(page).toContain('<span class="chip"><span class="k">Key</span>C major</span><span class="chip"><span class="k">Tempo</span>153 bpm</span>');
    expect(page).toContain('<pre id="code-static" class="code-static">setcpm(153/4)\nconst bass = note(&quot;&lt;d2 c2&gt;&quot;)</pre>');
    expect(page).toContain('<span id="code-lines" class="code-lines">2 lines</span>');
    // One Money for Nothing: an alternate transcription of a title is not suggested twice.
    expect(page.match(/href="\/song\/dire-straits--money-for-nothing(-2)?\/"/g)).toEqual(['href="/song/dire-straits--money-for-nothing/"']);
    expect(page).toContain('More by <a id="more-artist" href="/artist/dire-straits/">Dire Straits</a>');
    // The artist is in the heading, so a card says what else a listener knows the song by, or the artist when nothing is known.
    expect(page).toContain('<span class="ex-t">Money for Nothing</span><span class="ex-a">Dire Straits</span>');
    expect(artistPage(artists(entries)[0], '/assets/index.css', site)).toContain('<span class="ex-t">Sultans of Swing</span><span class="ex-a">1978 · C major · 153 bpm</span>');
    expect(shell).toMatch(LANDING_POOL_SCRIPT);
    expect(page).not.toMatch(LANDING_POOL_SCRIPT);
  });
  it("carries the start of a long song's code as text and counts all of it", () => {
    const code = Array.from({ length: 450 }, (_, i) => `// line ${i + 1}`).join('\n');
    const page = songPage(shell, entries[0], [], { code }, site);
    expect(page).toContain('<span id="code-lines" class="code-lines">450 lines</span>');
    expect(page).toContain(`// line ${STATIC_CODE_LINES}\n// … ${450 - STATIC_CODE_LINES} more lines</pre>`);
    expect(page).not.toContain(`// line ${STATIC_CODE_LINES + 1}\n`);
  });
  it('spells keys the display way, escapes titles and says where a score comes from', () => {
    expect(songPage(shell, entries[3], [], {}, site)).toContain('<span class="k">Key</span>B♭ major');
    const score = songPage(shell, entries[4], [], {}, null);
    expect(score).toContain('Kiki’s Theme &lt;b&gt;');
    expect(score).not.toContain('Kiki’s Theme <b>');
    expect(songDescription(entries[4], '久石譲')).toContain('From a score arrangement.');
    // Without the site's address there is nothing absolute to point at.
    expect(score).not.toContain('rel="canonical"');
    expect(score).not.toContain('og:image');
    expect(ldOf(score)).toEqual([]);
  });
  it('keeps titles and descriptions short enough for a results page', () => {
    const long = entry('x', 'A Very Long Song Title That Goes On And On Forever And Ever', 'Some Band With A Long Name', { bpm: 120, key: 'C# minor' });
    expect(songTitle(long, 'Some Band With A Long Name')).not.toContain('Strudelify');
    expect(songDescription(long, 'Some Band With A Long Name').length).toBeLessThanOrEqual(160);
  });
});

describe('home, 404 and artist pages', () => {
  it('gives the home page a search box search engines can use', () => {
    const [ld] = ldOf(homePage(shell, site));
    expect(ld['@graph'][0]).toMatchObject({ '@type': 'WebSite', potentialAction: { target: `${site}/?q={search_term_string}` } });
    expect(notFoundPage(shell)).toContain('<meta name="robots" content="noindex" />');
  });
  it('groups the catalogue by artist, most popular song first, and files each under a letter', () => {
    const all = artists(entries);
    expect(all.map((g) => g.name)).toEqual(['Dire Straits', 'The Beatles', '久石譲']);
    expect(all[0].entries.map((e) => e.id)).toEqual(['dire-straits--sultans-of-swing', 'dire-straits--money-for-nothing', 'dire-straits--money-for-nothing-2']);
    expect([letterOf('The Beatles'), letterOf('10cc'), letterOf('Émilie Simon'), letterOf('久石譲'), letterOf('A-ha')]).toEqual(['b', '0-9', 'e', 'other', 'a']);
  });
  it('writes plain artist pages that link every song and run no script', () => {
    const [straits] = artists(entries);
    const page = artistPage(straits, '/assets/index.css', site);
    expect(page).toContain('<title>Dire Straits: 3 songs as Strudel code · Strudelify</title>');
    for (const e of straits.entries) expect(page).toContain(`href="${songPath(e.id)}"`);
    expect(page).toContain("script-src 'none'");
    expect(page).not.toMatch(/<script(?! type="application\/ld\+json")/);
    const index = artistsPage(artists(entries), '/assets/index.css', site, 'd');
    expect(index).toContain('<a href="/artist/dire-straits/">Dire Straits</a> <span class="n">3</span>');
    expect(index).not.toContain('The Beatles');
    expect(artistsPage(artists(entries), '/assets/index.css', site)).toContain('<a href="/artists/b/">B</a>');
  });
  it('drops indentation but not the code', () => {
    expect(compact('<div>\n    <p>a</p>\n  <pre>x\n    y</pre>\n  </div>')).toBe('<div>\n<p>a</p>\n<pre>x\n    y</pre>\n</div>');
  });
  it('lists every page in the sitemap and points robots at it', () => {
    const xml = sitemap(site, ['/', '/song/a&b/']);
    expect(xml).toContain(`<url><loc>${site}/</loc></url>`);
    expect(xml).toContain(`<loc>${site}/song/a&amp;b/</loc>`);
    expect(robots(site)).toBe(`User-agent: *\nAllow: /\nSitemap: ${site}/sitemap.xml\n`);
    expect(robots(null)).not.toContain('Sitemap');
  });
});

describe('a site in a folder of another site', () => {
  afterEach(() => setBase('/'));
  it('puts every address under the folder and reads songs back only from inside it', () => {
    setBase('/strudelify/');
    expect([songPath('queen--bohemian-rhapsody'), artistPath('Queen'), sitePath(), sitePath('artists/b/')])
      .toEqual(['/strudelify/song/queen--bohemian-rhapsody/', '/strudelify/artist/queen/', '/strudelify/', '/strudelify/artists/b/']);
    expect(songIdFromPath('/strudelify/song/queen--bohemian-rhapsody')).toBe('queen--bohemian-rhapsody');
    expect(songIdFromPath('/song/queen--bohemian-rhapsody/')).toBeNull();
    expect([isHomePath('/strudelify/'), isHomePath('/strudelify'), isHomePath('/')]).toEqual([true, true, false]);
    setBase('strudelify'); // however it is written
    expect(sitePath()).toBe('/strudelify/');
  });
  it('links pages, icons, the search and the sitemap inside the folder', () => {
    setBase('/strudelify/');
    const page = songPage(shell, entries[0], entries.slice(0, 3), {}, 'https://www.arthurenard.me');
    expect(page).toContain('<link rel="canonical" href="https://www.arthurenard.me/strudelify/song/dire-straits--sultans-of-swing/" />');
    expect(page).toContain('<meta property="og:image" content="https://www.arthurenard.me/strudelify/og.png" />');
    expect(page).toContain('<link rel="icon" href="/strudelify/favicon.svg" type="image/svg+xml" />');
    expect(page).toContain('href="/strudelify/artist/dire-straits/"');
    expect(page).toContain('href="/strudelify/song/dire-straits--money-for-nothing/"');
    const [straits] = artists(entries);
    const plain = artistPage(straits, '/strudelify/assets/index.css', 'https://www.arthurenard.me');
    expect(plain).toContain('<form class="plain-search" action="/strudelify/"');
    expect(plain).toContain('<a href="/strudelify/artists/">Artists</a>');
    expect(plain).not.toMatch(/href="\/(?!strudelify\/)/); // no link leaves the folder
    const [ld] = ldOf(homePage(shell, 'https://www.arthurenard.me'));
    expect(ld['@graph'][0].potentialAction.target).toBe('https://www.arthurenard.me/strudelify/?q={search_term_string}');
    expect(robots('https://www.arthurenard.me')).toContain('Sitemap: https://www.arthurenard.me/strudelify/sitemap.xml');
  });
  it('finds the example cards however their address is written', () => {
    const cards = ['%BASE_URL%song/a/', '/strudelify/song/b/', '/song/c/'].map((href) => `<a class="ex" href="${href}">x</a>`).join('');
    expect(exampleIds(cards)).toEqual(['a', 'b', 'c']);
  });
});

describe('covers in the pages', () => {
  const art = 'https://is1-ssl.mzstatic.com/image/thumb/Music/v4/aa/600x600cc.jpg';
  const covers = readCovers(COVERS_HEADER
    + coverLine('dire-straits--sultans-of-swing', { art, kind: 'track', source: 'itunes', album: 'Dire Straits', year: 1978 })
    + coverLine('dire-straits--money-for-nothing', { art: art.replace('aa', 'bb'), kind: 'track', source: 'itunes', album: 'Brothers in Arms' }));
  it("draws a song's cover and its album before any script runs, as the app would", () => {
    const page = songPage(shell, entries[0], entries.slice(0, 3), {}, site, covers);
    expect(page).toContain(`<img id="art" alt="Sultans of Swing cover art" src="${art}" data-song="dire-straits--sultans-of-swing" decoding="async" />`);
    expect(page).toContain('<div id="art-fallback" class="art-fallback" aria-hidden="true" hidden></div>');
    expect(page).toContain('<p class="eyebrow" id="album">1978 · Dire Straits</p>');
    expect(page).toContain('<span class="ex-tile" aria-hidden="true"><img src="https://is1-ssl.mzstatic.com/image/thumb/Music/v4/bb/160x160cc.jpg"');
    // Without a cover the page keeps the tile and shows the year alone, as the app does while it looks.
    const plain = songPage(shell, entries[3], [], {}, site, covers);
    expect(plain).toContain('<img id="art" alt="" hidden decoding="async" />');
  });
  it('puts covers on artist pages, which may load them', () => {
    const page = artistPage(artists(entries)[0], '/assets/index.css', site, covers);
    expect(page).toContain('<img src="https://is1-ssl.mzstatic.com/image/thumb/Music/v4/aa/160x160cc.jpg"');
    expect(page).toContain("img-src 'self' data: https:");
  });
  it('bakes the landing cards with their covers', () => {
    const baked = bakeLanding(fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8'), entries, covers);
    const pool = JSON.parse(/<script type="application\/json" id="landing-pool">([\s\S]*?)<\/script>/.exec(baked)![1]);
    expect(pool.find((e: { id: string }) => e.id === 'dire-straits--sultans-of-swing').cover).toBe(art);
  });
});
