# Strudelify

Type a song name, get [Strudel](https://strudel.cc) live-coding code that plays it.
No LLM involved: the music is compiled from open, machine-readable transcriptions.

The bundled library contains **10,644 catalogue entries**: 10,176 with MIDI and 468 with chord charts only.
Of the MIDI entries, 271 also have a chord chart. Alternate transcriptions and artist/title spellings remain
in the catalogue, so this is an entry count, not a verified count of distinct compositions. The website
uses that wording and derives its count directly from the shipped index. Two MIDI entries currently have
no separately identified instrumental parts; the player explains this and disables playback.

- **Chords and structure** from the [McGill Billboard](https://ddmal.music.mcgill.ca/research/billboard)
  chord annotations (about 740 Billboard hits, 1958 to 1991).
- **Melody, bass, drums, tempo and key** from the
  [Lakh MIDI dataset](https://colinraffel.com/projects/lmd/) clean subset (about 10k songs, CC-BY).
- Detected lead and backing vocal parts are excluded. Instrumental melodies retain their instruments.
- Lyrics are deliberately not included.

## Layout

```
packages/core   song model, McGill + MIDI parsers, chord handling, Strudel code generator, search
packages/data   dataset download and database build (index.json + source files)
packages/cli    `strudelify` command
packages/web    static Vite app with an embedded Strudel editor, timeline and cover art
tools           check scripts: search quality, cover-art coverage, headless screenshots
```

## Setup

Requires Node 22.

```bash
npm install
npm run build                         # tsc -b for core, cli and data
node packages/data/dist/download.js   # ~235 MB of MIDI plus the McGill annotations -> packages/data/raw
node packages/data/dist/build.js      # -> packages/data/public/db (index.json + songs/)
```

The web app imports core's compiled output, so after a change in `packages/core` run `npx tsc -b`
before the dev server picks it up.

## CLI

```bash
node packages/cli/dist/main.js search "teen spirit"
node packages/cli/dist/main.js "smells like teen spirit nirvana"        # prints Strudel code
node packages/cli/dist/main.js nirvana--smells-like-teen-spirit --url   # strudel.cc share link
node packages/cli/dist/main.js "the joker steve miller" --open          # opens strudel.cc
node packages/cli/dist/main.js "love me do" --no-melody -o love.js
node packages/cli/dist/main.js "money pink floyd" --json                # the analysed song model
```

A query is resolved by the same index the web app uses (see [Search](#search)). An exact title shared
by several artists is ambiguous unless one of them is clearly the original; an artist name alone is a
catalogue, not a song; words inside a title only resolve when they explain nearly all of the query.
Ambiguous queries print the candidates and exit 1; pass the artist or the exact id. Songs not in the
database also exit 1 with the nearest matches, never a silent substitute.

Options: `--no-melody` (also removes instrumental leads), `--max-bars <n>`, `--max-tracks <n>`, `--json`,
`--db <dir>` (or `STRUDELIFY_DB`).

## Web app

```bash
npm run dev:web        # http://localhost:5173
npm run build -w @strudelify/web
```

The web app is fully static. It fetches `db/index.json`, searches as you type in the browser, fetches
the song's source file and compiles it client-side, then loads the result into an embedded Strudel
editor. Deploy `packages/web/dist` together with `packages/data/public/db` (about 580 MB).

- **Search palette**: `/` or `Ctrl/Cmd+K` focuses the box; an empty box lists the songs opened recently
  and the most transcribed ones. A query that names an artist lists that catalogue first (after the
  direct title hits when the query also reads as a title). Near-duplicate transcriptions collapse into
  one row; matched words are highlighted.
- **Hero**: title, artist, year and album, chips for key, tempo, metre, number of parts and the
  sources. Cover art is looked up through a chain of keyless public services (iTunes Search, Deezer as
  JSONP, MusicBrainz with the Cover Art Archive, then a Deezer artist portrait; see
  `tools/art-check.md` for the ranking rules). The hero is tinted with the dominant colour of the
  cover, read from its pixels once it has loaded; without a cover a letter tile in a colour derived
  from the title stands in. Hits and tints are cached in localStorage; these lookups are the only
  network calls that leave your machine besides the app's own files. Hovering a search result or an
  example card warms its art, so the song opens with cover and tint in place. All landing-page cards
  also load their album artwork automatically, with two concurrent lookups and a letter fallback.
- **Player**: play/pause (`Space`), back to start (`Home`), `←`/`→` move four bars, a hard stop that
  also silences ringing notes. The readout shows time, bar, the chord sounding and the section.
- **Timeline**: a bar ruler, a section lane and a chord lane over a seekable slider. Sections are the
  annotated structure when McGill has the song, otherwise a form (`A B A B C…`) read from repeating
  chord patterns when it is clear enough to be worth showing. Zoomed in, every chord run is a block with
  its own symbol; zoomed out, bars are grouped into harmonic phrases (`F · A♭` over sixteen alternating
  bars) so long songs stay legible. Long songs scroll sideways with an overview strip as the map.
  Everything is keyboard-reachable (Tab to a lane, arrows along it, Enter to jump).
- **Options**: an instrumental-lead switch and an optional excerpt length. The website renders all
  instrumental tracks and the full song by default. Detected vocals are always excluded.
  A chord chart is always rendered whole and has no options.
- **Code**: the generated file in a Strudel editor with a wrap toggle, an always-visible horizontal
  scrollbar for the long note lines, copy, download and "Open in strudel.cc" (the code travels in the
  URL hash). The `// chords:` and `// key` comments are spelled the way the readout spells them (flats
  in flat keys, `maj7` for `^7`).

## How the code is generated

One Strudel cycle is one bar (`setcpm(bars per minute)`), so every layer stays aligned. The header of
every file lists the analysis decisions as `// note:` comments (tempo and metre changes, bank remaps,
dropped duplicates, the mix scaling), and every part's comment says its role, its sound and why.

### MIDI songs

- **Time:** `loadSong()` and `songFromMidi()` preserve elapsed time through tempo changes. The
  dominant tempo sets the display grid; nearby tempos are not snapped to it. Source timing is
  represented to microbeat precision. `sourceTiming: false` opts into the older grid analysis.
- **Notation:** the default renderer emits native `arrange`/`timecat`/`pure` patterns with independent note durations and
  velocities. Integer time weights avoid expensive floating-point rational conversions. Strummed chord tones and drum flams remain separate events. Overlapping notes and
  notes crossing bar lines retain their releases. `compile(song, { timing: 'grid' })` opts into
  shorter, quantised notation. Both modes exclude detected vocal parts.
- **Dynamics:** the default renderer preserves each note's velocity and volume/expression/pan at
  its onset. Quiet instrumental details are not discarded or boosted into lead parts. Swells that
  begin near silence use the mean level during the note until continuous envelopes are supported.
- **Instruments:** General MIDI patches and explicit instrument names guide the soundfont choice;
  legacy MT-32 bank mappings are reconciled. The two reviewed examples select recorded VCSL acoustic
  drums instead of the default electronic kit. See [source selections](packages/data/curated/README.md).
- **Analysis:** notes merge per channel/program, sustain and coarse tuning are applied, and heuristic
  cleaning removes duplicates, strays and effects. These decisions can still differ from the recording.
- **Limits:** the CLI/core default cap remains 200 bars of 4/4 and 12 pitched tracks; callers can override
  these. The website requests the complete arrangement. Generated code is longer than compact notation.

### Chord-only songs

Each section becomes an `arrange()` row of chord symbols with generated piano voicings, root/slash-bass
notes and a simple groove. The website labels this **Generated accompaniment**. Chord charts do not
contain the original instrumental notes, rhythm or instrumentation and cannot reproduce the recording.

### Source selection and fidelity

The builder scores duration, instrumental coverage and usable track names with capped note-count
bonuses. More notes alone no longer determine the chosen variant. Reviewed sources and their checksums
are pinned in `packages/data/curated/manifest.json`; the rest of the catalogue has not been manually
verified against recordings. The existing generated database has the two reviewed replacements;
the revised automatic scoring applies on subsequent rebuilds.

This is a transcription compiler, not lossless reconstruction of recorded audio. MIDI arrangements may
omit sections, add parts or mislabel instruments. Vocal identification is heuristic. Continuous pitch
bends and within-note expression changes, some percussion variants, original guitar/amp timbres and
studio production are not reproduced exactly. Runtime validation establishes playable code and event
consistency, not perceptual equivalence to the original music.

### Both sources

When both exist the MIDI provides the notes and McGill the structure and key. The web app lays the
annotated sections and chords on the rendered bars when the two cuts agree in length (within a
quarter); otherwise it shows the chords read from the notes bar by bar, marks the readout "MIDI
chords", estimates the key from the notes and rewrites the `// chords:` line to match what plays.

## Search

`packages/core/src/search.ts` is a dependency-free inverted index over title and artist with prefix and
typo matching, built for the way people look for songs: "title", "artist", "title artist", "artist -
title", "title by artist", partial words while typing, misspellings, words typed without their spaces
("teenspirit", "obladi oblada"), glued and initialled band names ("acdc", "ccr", "rhcp"), alternative
titles in parentheses ("i feel good"). A letter-perfect whole title beats a typo'd one, which beats an
artist's name (a catalogue, listed by popularity), which is level with a title prefix, which beats a
phrase inside a title, which beats a bag of words. Popularity only decides between equally good matches.
`index.resolve()` turns a query into one song or an "ambiguous" verdict for the CLI. The index builds in
about 100 ms for 10,644 songs and answers in well under a millisecond.

## Tools

```bash
node tools/search-check.mjs            # search battery (top-1/top-3), held-out sets, keystroke walks, resolve verdicts, timings; exits 1 on regression
node tools/search-check.mjs -q "text"  # top 10 with scores for one query
node tools/art-check.mjs --n 40 --random 10   # cover-art coverage and time-to-art on a database sample (network); see tools/art-check.md
node tools/shot.mjs "#nirvana--smells-like-teen-spirit" out.png [--mobile] [--full] [--wait ms] [--click "<css>"]
node tools/ui-check.mjs                # headless UI check against the dev server: errors, horizontal scroll at 390/768/1440, baked landing, canonical artists, lane labels, no stale song while the next loads; exits 1 on failure
node tools/library-check.mjs --workers=4 # every source file, compilation, Strudel runtime, and loop boundary; writes tools/library-report.json
```

`shot.mjs` screenshots the running dev server (`http://127.0.0.1:5173`) with headless system Chrome
and prints the page's console errors. `art-check.mjs` runs the web app's exact art resolver from Node
through `tsx`, so browser and harness execute the same code.

## Tests

```bash
npm test                              # vitest: core, cli and the web app's pure helpers (art resolver included)
npx tsc --noEmit -p packages/web      # web typecheck
```

## Licences

Code: MIT. Strudel is AGPL-3.0, so a distributed build of the web app must comply with the AGPL.
Lakh MIDI: CC-BY 4.0 (cite Colin Raffel's thesis). McGill Billboard annotations: research use, see their site.
# strudelify
