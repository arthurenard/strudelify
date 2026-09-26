# Strudelify

Type a song name, get its instrumental arrangement as editable [Strudel](https://strudel.cc) code: the whole song,
written as readable riffs. Choose Main loop for a phrase the song keeps coming back to, at least 12 seconds long
(usually eight bars).
No LLM involved: the music is compiled from open, machine-readable transcriptions.

The bundled library contains **13,613 catalogue entries**: 13,177 with MIDI (3,261 of them score arrangements) and 436 with chord charts only.
Of the MIDI entries, 303 also have a chord chart. A song held twice (two transcriptions under different spellings, a
chord chart the builder did not pair with its MIDI) is one entry, playing the transcription that follows the
recording best (see [One entry per song](#one-entry-per-song)); a song known under two different titles can still
appear twice, so this is an entry count, not a verified count of distinct compositions. The website uses that
wording and derives its count directly from the shipped index. Two MIDI entries currently have no separately
identified instrumental parts; the player explains this and disables playback.

- **Chords and structure** from the [McGill Billboard](https://ddmal.music.mcgill.ca/research/billboard)
  chord annotations (about 740 Billboard hits, 1958 to 1991).
- **Melody, bass, drums, tempo and key** from the
  [Lakh MIDI dataset](https://colinraffel.com/projects/lmd/) clean subset (about 10k songs, CC-BY).
- **Additional score arrangements** from [PDMX](https://zenodo.org/records/15571083), imported automatically through Zenodo’s public API with rating, metadata and runtime checks.
- Detected lead and backing vocal parts are excluded. Instrumental melodies retain their instruments.
- Lyrics are deliberately not included.

## Layout

```
packages/core   song model, McGill + MIDI parsers, chord handling, Strudel code generator, search
packages/data   dataset download and database build (index.json + source files), catalogue ids
packages/cli    `strudelify` command
packages/web    static Vite app with an embedded Strudel editor, timeline and cover art
tools           check scripts: search quality, cover-art coverage, library runtime, headless screenshots
```

## Setup

Requires Node 22 and Python 3 (for the PDMX importer and its tests); the importer also needs curl.

```bash
npm install
npm run build                         # tsc -b: core, data and cli
node packages/data/dist/download.js   # ~235 MB of MIDI, the McGill annotations and LMD's match scores -> packages/data/raw
node packages/data/dist/build.js      # -> packages/data/public/db (index.json + songs/)
npm run data:expand                   # optional: add quality-filtered PDMX arrangements (~440 MB download)
node packages/data/dist/dedupe.js     # one entry per song (--dry-run to see what it would merge)
npm run build:web                     # the website, with the library baked in -> packages/web/dist
```

The downloader checks every file against its pinned size (and SHA-256 or gzip checksum) before keeping
it, so an interrupted download or an error page is never taken for the data. The builder checks all of
its inputs before it starts and swaps the new database in only once it is complete; a failed build leaves
the working database alone. Song ids come from `packages/data/catalogue-ids.tsv`, which records every id
with the artist and title it names, so a rebuild keeps every shared link (`/song/the-beatles--hey-jude/`); the
builder and the score importer add new songs to it (commit the file). A score is named like any song
(`billie-eilish--bad-guy`) and recorded with its score number, since it may share its artist and title with a
transcription already in the catalogue. `npm run data:refresh` re-reads each song's tempo and key
from its own source files with the current analysis, without the raw datasets.

The web app imports core's compiled output, so after a change in `packages/core` run `npm run build`
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

The CLI defaults to an automatically selected **Main loop**, a phrase the song repeats (usually eight bars, sixteen for fast songs), written on a grid like the Full arrangement. Pass `--full-song` for the full arrangement, or `--source-detail` for unrounded MIDI events.

Options: `--full-song`, `--source-detail`, `--no-melody` (also removes instrumental leads), `--max-bars <n>`, `--max-tracks <n>`
(whole numbers of at least 1), `--json` (with `-o`, written to the file), `--url`, `--open` (exits 1 with the reason when no
browser can be opened or the link is too long for one), `-o <file>`, `--db <dir>` (or `STRUDELIFY_DB`).

## Web app

```bash
npm run dev:web        # http://127.0.0.1:5173/strudelify/ (the site's folder; 127.0.0.1:5173 is sent there)
npm run build:web
```

The web app is fully static. It fetches `db/index.json` (3.4 MB, 520 KB gzipped) when the browser is idle
or as soon as search or a song link needs it, searches as you type in the browser, fetches the song's
source file and compiles it client-side, then loads the result into an embedded Strudel editor. The
landing page's example cards come from a pool of 200 popular songs baked into `index.html`, so they draw
without the index. Vite copies the database and local audio into `packages/web/dist`; deploy that whole
directory as the site's folder (about 920 MB and 32,700 files in the current build, see [pages](#pages-for-search-engines)). The site is built for `www.arthurenard.me/strudelify/`: every address starts with that folder (Vite's `base`, `STRUDELIFY_BASE` to change it, `/` for a domain of its own), and `vercel.json` maps the folder onto the build. The database is gitignored, so a fresh
GitHub checkout must restore/build it before the web build (`node tools/fixture-db.mjs` makes a two-song one
for trying the build). See [launch review and deployment steps](LAUNCH.md).

The production page carries a Content Security Policy (see `packages/web/vite.config.ts`): scripts only from
the site and Deezer's JSONP, no inline scripts, no plugins. The fonts (Inter, JetBrains Mono, SIL OFL) are served
with the site.

- **Search palette**: `/` or `Ctrl/Cmd+K` focuses the box; an empty box lists the songs opened recently
  and the most transcribed ones. A query that names an artist lists that catalogue first (after the
  direct title hits when the query also reads as a title). Near-duplicate transcriptions collapse into
  one row; matched words are highlighted.
- **Hero**: title, artist, year and album, chips for key, tempo, metre, number of parts and the
  sources. Every song's cover is resolved ahead of time into a **cover catalogue**
  (`packages/data/covers.tsv`, made by `node tools/resolve-covers.mjs`) with the app's own chain of keyless
  public services (iTunes Search, Deezer, MusicBrainz with the Cover Art Archive, then a Deezer artist
  portrait; see `tools/art-check.md` for the ranking rules). The build bakes the covers into the landing
  cards, each song page's hero and the artist pages, and splits the catalogue into 256 small files by artist
  (`db/covers/<n>.json`), so a search for one artist or a song's "More by" reads one file: a cover shows
  in a fraction of a second, with no request to those services, whose rate limits (iTunes allows about 20
  lookups a minute) a page of search results used to overrun. A song the catalogue does not know yet is
  looked up in the browser through the same chain; the hero draws its cover as soon as it is found, while
  the song and the editor load. The hero is tinted with the dominant colour of the
  cover, read from its pixels once it has loaded; without a cover a letter tile in a colour derived
  from the title stands in. Hits and tints are cached in localStorage (at most 1,000 songs each, oldest first
  out); external requests also include Strudel's remote samples/soundfonts once a song opens. Hovering a search result or an
  example card warms its art, so the song opens with cover and tint in place. All landing-page cards
  also load their album artwork automatically, with four concurrent lookups, CDN-sized thumbnails and a letter fallback. Cached covers bypass
  the lookup queue. Thumbnail misses are retried after 30 seconds; hero lookups can retry immediately.
- **Player**: play/pause (`Space`), back to start (`Home`), `←`/`→` move four bars, a hard stop that
  also silences ringing notes. The sounds of the first bars are loaded before playback starts (the rest
  while it plays), so no opening note is dropped. The readout shows time, bar, the chord sounding and the section.
- **Timeline**: a bar ruler, a section lane and a chord lane over a seekable slider. Sections are the
  annotated structure when McGill has the song, otherwise a form (`A B A B C…`) read from repeating
  chord patterns when it is clear enough to be worth showing. Zoomed in, every chord run is a block with
  its own symbol; zoomed out, bars are grouped into harmonic phrases (`F · A♭` over sixteen alternating
  bars) so long songs stay legible. Long songs scroll sideways with an overview strip as the map.
  Everything is keyboard-reachable (Tab to a lane, arrows along it, Enter to jump).
- **Options**: an instrumental-lead switch and an optional excerpt length. The website opens a song on its
  **Full arrangement**, the whole transcription as reusable riffs, with the lead off: the backing to play
  along with (a song that is its lead alone, such as a solo piano score, keeps it). **Main loop** is a phrase
  the song repeats, selected automatically (see below); **Source detail** retains unrounded events.
  Switching style while it plays carries on from the same place in the song. Detected vocals are always excluded. Chord charts offer the same loop/full choice,
  but their accompaniment is generated from chord symbols.
- **Code**: the generated file in a Strudel editor with a wrap toggle, an always-visible horizontal
  scrollbar for the long note lines, copy, download and "Open in strudel.cc" (the code travels in the
  URL hash; a program too long for a browser's URL is download-only). Play, copy, download and open all
  take what the editor holds, your edits included; an option change regenerates the code and offers the
  edited version back. The `// chords:` and `// key` comments are spelled the way the readout spells them
  (flats in flat keys, `maj7` for `^7`).
- **More by the artist**: under the code, up to eight of the artist's other songs (most transcribed
  first, one per title), and a link to the artist's page.
- **Addresses**: every song has its own address, `song/<id>/` in the site's folder, that opens it directly; links in the
  app change it without reloading, and the Back button returns to the previous song. Old `/#<id>` links
  are moved to the new address. `/?q=<text>` opens the search with that text.

### Pages for search engines

`npm run build:web` also writes a static page per song, per artist and per letter (the prerender plugin
in `packages/web/vite.config.ts`, the pages themselves in `packages/web/src/prerender.ts`):

- `song/<id>/index.html` is the app opened on the song: its own title ("Song — Artist: Strudel code"),
  description, canonical address, Open Graph and Twitter cards, structured data (`MusicComposition`
  with its artist, and breadcrumbs), the song's facts, its Main loop code as plain text until the
  editor loads, and links to the artist's other songs. The loops are compiled in worker threads (about
  40 s for the catalogue).
- `song/<old id>/index.html`, for a song merged into another (`db/moved.json`, see
  [One entry per song](#one-entry-per-song)), sends its address on to the kept song (`noindex`, with the kept
  song as canonical); the app does the same for an address it is given.
- `artist/<slug>/index.html` lists an artist's songs; `artists/` and `artists/<letter>/` index them A to
  Z. These are plain pages with no script.
- `index.html` gains `WebSite` structured data with the search box; `404.html` is served for unknown
  addresses; `sitemap.xml` lists every page and `robots.txt` points to it.

Absolute addresses (canonical links, Open Graph, the sitemap) use the published origin,
`https://www.arthurenard.me`, with the folder above; for another host build with both,
`STRUDELIFY_BASE=/ SITE_URL=https://example.com npm run build:web` (`SITE_URL=` leaves them out, and the build
says so). Crawlers read `robots.txt` only at a host's root, so under a folder the portfolio's own robots.txt must
name `https://www.arthurenard.me/strudelify/sitemap.xml` (or submit the sitemap in Search Console). The icons and the
link-preview image are in `packages/web/static`, drawn by `node tools/make-icons.mjs`.

## How the code is generated

One Strudel cycle is one bar (`setcpm(120/4)`: beats per minute over beats per bar), so every layer stays aligned. The header of
every file lists the analysis decisions as `// note:` comments (tempo and metre changes, bank remaps,
dropped duplicates, the mix scaling), and every part's comment says its role, its sound and why.

### MIDI songs

The website and CLI default to **Main loop**, a phrase of the song: eight bars, or sixteen when eight
would last under 12 seconds, four when they would last over 40 (median 17.5 s). Every bar is
fingerprinted per section of the band (which pitch classes sound and where the onsets fall, drums by
sound), so near repeats count. Each window is scored on how often the song plays it again, whether it
recurs right after itself (so the loop's end leads back into its start as in the song), how much of the
band and the tune play through it, and a crash on its first downbeat; intros, outros and very dense
passages score a little lower. The loop keeps up to four pitched parts and six percussion sounds on the
coarsest grid that places 95% of the onsets within 35 ms, merges unison attacks, and keeps a part's ghost
notes as a separate `_soft` part. A note struck a hair before the loop's end belongs to the next
downbeat, which the loop's start already plays, so it is left out rather than cut to a blip. This is a
musical sketch, not an exact rendition of the whole recording. The code identifies the source passage and
simplifications. No song IDs or hand-authored riffs participate in this process.

**Full arrangement** retains the complete bar timeline. It quantizes to a shared musical grid, keeps each
part at its typical level plus, when they are common (5% of its notes or more), its ghost notes at their
own level (a drum kit per sound), removes empty/unison events, merges matching guitar doubles while keeping their
unique solos/fills, and combines percussion keys that play the same sample. These are explicit
simplifications, not recording fidelity guarantees. **Source detail** retains the unrounded instrumental
events; it is long by nature (every event keeps its exact timing and dynamics).

**Timing.** Main loop and Full arrangement round every note to the grid, and the grid starts where the band
plays ([grid.ts](packages/core/src/grid.ts)): when a whole transcription sits a few tens of milliseconds off the
beat (a file that starts late or early; The Police's Every Breath You Take plays 38 ms ahead of it), the grid moves
by that common offset, up to 60 ms and only when the notes agree on it, so parts played together land on the same
step instead of either side of one; a `// note:` says so (302 of the 13,177 MIDI songs, 15 ms at the median).
Swing, which fits triplets as played, keeps its triplet grid. Then a bar that differs from one of its part's riffs only by a performer's wobble is written as that riff,
so a riff repeats wherever the part repeats it (`settle` in patterns.ts): a note may take the neighbouring step
only when it was played within 10 ms of halfway between the two, which leaves it at most 20 ms further from where
it was played than plain rounding, and a length may differ by half a step plus 25 to 80 ms (15% of the note; the
end of a note is heard far less precisely than its start). A bar that differs by more is written out, since the
difference is in the music. The most common version of a riff wins.

Main loop and Full arrangement are written as plain mini-notation ([patterns.ts](packages/core/src/patterns.ts)),
with no number on any note:

```js
// bass · fretless bass
const bass = note(`<
  A B C D C E C F G H I@2 G H J K L M N O P Q R S T U G H V J W X V J Y Z AA AB AC AD AE AF AG AH AI AJ
  ...
>`.pickRestart({
  A: "d2@7 ~@2 d2 ~@2 d2@7 ~@5", B: "d2@7 ~@2 d2 ~@2 c2@3 a1@2 ~ c2@3 ~@3", C: "d2@6 ~@3 d2 ~@2 d2@7 ~@5",
  ...
})).s("gm_fretless_bass").gain(0.34)

// drums · kick
const kick = s("bd").struct("<x ~@2 x!2 ~@3 ...>").gain(0.3)
```

- **Notes** last their steps on the grid (`d2@7` is seven steps) and rests fill the gaps, so articulation
  is exact without per-note numbers. Notes struck together for the same length are a chord (`[a3,d4,f4]`).
- **Held notes:** a note still sounding when the next one starts goes to another voice (`a, b` plays two
  voices at once), and one held over the bar line makes a riff of several bars (`[...]/2`). Only a note that
  overlaps the next one by at most a sixteenth (and a third of its length) is trimmed instead; beyond five
  voices or eight bars a note is cut where it would need one more. Over 300 songs spread across the catalogue
  (835,009 notes, read back through Strudel) every note keeps its pitch and 99.9% keep their onset on the grid;
  the other 0.1% take the step their riff uses (see Timing), at most 20 ms further from where they were played
  than plain rounding (7 ms at the median). 94.6% keep their exact length, 4.4% move by at most a sixteenth and
  1.0% more (mostly pedalled piano and let-ring guitar); before riffs absorbed timing wobbles, 95.2%, 3.8% and 1.0%.
- **Riffs:** a short part is one sequence of bars (`note("<[c3 e3] [g3 b3]!3>")`); a longer one names each
  distinct bar once (A, B, C..., never a note name) and plays them in order with
  [`pickRestart()`](https://strudel.cc/learn/conditional-modifiers/#pickrestart), so editing a riff changes
  every repeat. In a Main loop, a part with a note held over the bar line is one pattern, a line per bar.
- **Drums** are one part per sound with a step-grid rhythm (`s("bd").struct("x ~@2 x!2 ~@3")`); samples
  ring to their natural end, so only the onsets are written. Each part has a single `.gain()` (velocity
  included) and a `.pan()` when it is off centre; ghost notes are a `_soft` part with its own gain.
- **Spelling:** notes follow the key, with flats in flat keys (`bb3` in F minor, `a#3` in E major). A riff
  on a line of its own names the chords it strikes in a comment (`// Dm C`, power chords as `F5`); a part
  written without riffs names its chords in its heading comment.

Lines wrap at 120 characters; a riff is never split, so a dense one can run longer (the editor's wrap
toggle folds it). Across the catalogue a Full arrangement has 157 lines at the median and 11.3% of songs
exceed 300 (long through-composed pieces and dense transcriptions, where every variation is written out);
a Main loop has 61 at the median, 90 at the 90th percentile and never more than 190.

The core API keeps its source-detail/full-song default for compatibility:

```js
compile(song, { form: 'loop', timing: 'patterns' }) // short automatic sketch
compile(song, { timing: 'patterns' })               // complete arrangement on a grid
compile(song, { timing: 'source' })                // unrounded instrumental events
```

- **Time:** `loadSong()` and `songFromMidi()` preserve elapsed time through tempo changes. The
  dominant tempo sets the display grid; nearby tempos are not snapped to it. Source timing is
  represented to microbeat precision. `sourceTiming: false` opts into the older grid analysis.
- **Source-detail notation:** this renderer emits native `arrange`/`timecat`/`pure` patterns with independent note durations and
  velocities. Integer time weights avoid expensive floating-point rational conversions. Strummed chord tones and drum flams remain separate events. Overlapping notes and
  notes crossing bar lines retain their releases. `compile(song, { timing: 'grid' })` opts into
  shorter, quantised notation. Both modes exclude detected vocal parts.
- **Dynamics:** the source-detail renderer preserves each note's velocity and volume/expression/pan at
  its onset. Quiet instrumental details are not discarded or boosted into lead parts. Swells that
  begin near silence use the mean level during the note until continuous envelopes are supported.
- **Instruments:** General MIDI patches and explicit instrument names guide the soundfont choice;
  legacy MT-32 bank mappings are reconciled. The two reviewed examples select recorded VCSL acoustic
  drums instead of the default electronic kit. See [source selections](packages/data/curated/README.md).
- **Analysis:** notes merge per channel/program, sustain and coarse tuning are applied, and heuristic
  cleaning removes duplicates, strays and effects. Controller and program changes are read in time order
  across tracks, as a player merges them. A minor key signature names its relative minor; a file whose tempo
  never holds for a bar gets its typical (median) tempo; an invalid zero-length tempo event is ignored, and
  SMPTE-timed files are rejected with an error. These decisions can still differ from the recording.
- **Limits:** the CLI/core default cap remains 200 bars of 4/4 and 12 pitched tracks; callers can override
  these. When a song has more pitched parts than the cap, the melody and the main bass are kept first. Main loop has its own length (above) and keeps up to four pitched parts and six percussion sounds. Full arrangement on
  the website requests the complete song. These full representations can be much longer than a sketch.

### Chord-only songs

Each section becomes an `arrange()` row of chord symbols with generated piano voicings, root/slash-bass
notes and a simple groove. The key and metre are the annotation header's; where the metre changes inside
the song, bars keep their own length on the grid of the metre that lasts longest, and a comment lists the changes. The website labels this **Generated accompaniment**. Chord charts do not
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

### Automated library expansion and API review

`npm run data:expand` downloads a pinned PDMX release through the Zenodo record API, verifies checksums,
filters metadata, extracts regular MIDI files into staging, parses and compiles each candidate, then
executes the result through the installed Strudel runtime. It admits only nonempty loops that repeat
at their timeline boundary and fit a 20,000-character ceiling. Existing entries are preserved; IDs and
normalized artist/title identities prevent duplicate additions. The index is replaced atomically after
source files are written. Re-running is safe. A base database rebuild must be followed by expansion again.

Use `npm run data:expand -- --dry-run` to review additions without changing the database.
`--limit=100` bounds candidates; `--db=/absolute/path` chooses another base database.
The ignored `packages/data/raw/pdmx/import-report.json` records candidates and rejection reasons.
A score needs a rating of at least 4.0/5 from three reviews or more, or, with fewer reviews, at least ten
favourites and no rating below 4.0; rated scores are taken first. Further filters require valid non-draft instrumental
scores, no declared licence conflict or paywall, and bounded duration, track and note counts.
Score ratings are not recording-fidelity scores. The website labels these entries **Score arrangement**.

Uploaders' credit blocks are reduced to the composer or performer and a title or artist that names nothing
usable is rejected (`packages/data/src/metadata.ts`). An import from the base catalogue admits 3,285 scores (3,597
candidates; the rest duplicate a song already in the catalogue or fail a check). All source archives and generated
database files remain ignored by Git; the importer is the reproducible deliverable. The website's production build
runs it after the base build, then the duplicate step (`npm run build:site`, which `vercel.json` names as Vercel's
build command); if the import fails the site is built with the base catalogue, and if the duplicate step fails,
with every entry. Each build writes `db/build.json` with its song, score and
cover counts and its commit, to check what a deployment carries.
[Pipeline review](tools/pipeline-review.md) explains the source comparison and checks.

[Klangio](https://api-docs.klang.io/docs/getting-started/basic-job-workflow) is a candidate for future
recording-to-MIDI transcription. It needs API access and input audio, and its accuracy must be benchmarked
before replacing sources. No paid jobs were submitted or audio uploaded. Spotify/metadata APIs do not
provide the instrumental note events needed by this compiler.

### One entry per song

`packages/data/src/dedupe.ts` finds the songs the catalogue holds more than once: the same artist (its words
in any order, without "the" and "and") and a title that core's `isDuplicateTitle` calls the same song
(`Livin' on a Prayer`, `Living on a Prayer`). Each song keeps one transcription, chosen in this order:

1. one with notes over a chord chart alone;
2. the one [LMD-matched](https://colinraffel.com/projects/lmd/) found closest to a recording: Colin Raffel
   aligned each Lakh file with the audio of the recordings it could match and scored the alignment
   (`match_scores.json`, 7 MB, keyed by the file's MD5; our files are the dataset's, byte for byte). A file with
   a score beats one without; a higher score beats a lower one;
3. then one with a McGill chord chart, a Lakh transcription over a score arrangement, the builder's structural
   ranking and popularity.

The song keeps the name and address of its most popular entry (the spelling most transcriptions use) and
plays the chosen file with its tempo and key; a chord chart and a year carry over from whichever entry has
them, and the entries' popularity is added up. Each dropped id is recorded in `db/moved.json` with the id it
moved to (earlier moves are kept, a chain is followed to its end), so a shared link still opens the song, and a
file no song plays any more moves to `packages/data/duplicates` instead of shipping unplayed.

On the local catalogue the step merged 312 songs held more than once (316 entries dropped), 188 of them
decided by a match score, and moved 40 chord charts onto the MIDI entry they belong to. Afterwards 3,827 of the
9,916 Lakh transcriptions played have a match score (median 0.72), and 118 of the 200 songs the landing page
draws from (112 before the merge). LMD kept only alignments scoring 0.5 or more, so a file without a score was
either never paired with a recording or did not line up with one well enough; a score measures how closely a file
follows a recording, not how good an arrangement it is.

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
A leading "The" in a title of three words or more is optional, like a leading parenthetical ("house of the
rising sun"), and words the title explains do not also count as naming the artist ("like a rolling stone"
is Bob Dylan's before the Rolling Stones' cover). `index.resolve()` turns a query into one song or an
"ambiguous" verdict for the CLI. The index builds in about 150 ms for the 13,613 entries and answers in
about 0.1 ms on average (a few ms for a single letter, which matches thousands of songs).

## Tools

```bash
node tools/search-check.mjs            # search battery (top-1/top-3), held-out sets, keystroke walks, resolve verdicts, timings; exits 1 on regression
node tools/search-check.mjs -q "text"  # top 10 with scores for one query
node tools/art-check.mjs --n 40 --random 10   # cover-art coverage and time-to-art on a database sample (network); see tools/art-check.md
node tools/resolve-covers.mjs          # the cover catalogue: every song not in packages/data/covers.tsv yet, most popular first (network; resumable, ~2.5 h for the catalogue)
node tools/shot.mjs nirvana--smells-like-teen-spirit out.png [--mobile] [--full] [--wait ms] [--click "<css>"]
node tools/ui-check.mjs                # headless UI check against the dev server (or STRUDELIFY_URL): errors, horizontal scroll at 390/768/1440, baked landing, canonical artists, lane labels, song addresses, old /#id links, More by, ?q=, no stale song while the next loads; exits 1 on failure
node tools/library-check.mjs --timing=patterns --loop --workers=4 # every source file, compilation, runtime and loop boundary
node tools/loop-size.mjs              # catalogue-wide code-length distribution
node tools/fixture-db.mjs             # a two-song database from the curated sources (never replaces one)
node tools/make-icons.mjs             # redraw the icons and the link-preview image in packages/web/static
node tools/vendor-acoustic-samples.mjs # re-vendor the acoustic drum hits (downloads them; needs flac or macOS)
```

`shot.mjs` screenshots the running dev server (`http://127.0.0.1:5173/strudelify/`, or `STRUDELIFY_URL`) with headless system Chrome
and prints the page's console errors. `art-check.mjs` runs the web app's exact art resolver from Node
through `tsx`, so browser and harness execute the same code.

## Tests

```bash
npm run check                         # typecheck (core, data, cli, web, tests), then npm test
npm test                              # vitest (core, cli, data, the web app's helpers), then the Python importer tests
npm run typecheck
```

The tests that need the full catalogue skip themselves without it. CI (`.github/workflows/ci.yml`) runs
`npm run check` and builds the website against the two-song fixture database.

## Licences

The project's own code is MIT (see [LICENSE](LICENSE)). Strudel is AGPL-3.0: distributing the combined web build requires
compliant licensing, notices and access to its complete corresponding source. This is not a blanket
licence for the music or artwork. See [LAUNCH.md](LAUNCH.md) before publication.
Lakh MIDI: CC-BY 4.0 (cite Colin Raffel's thesis). McGill Billboard 2.0 annotations: [CC0](https://ddmal.ca/research/The_McGill_Billboard_Project_(Chord_Analysis_Dataset)/), with scholarly citation requested.
PDMX: source score links, declared licences and ratings are preserved per entry. See the dataset’s
no-license-conflict guidance and each source score; dataset metadata does not certify the rights to
every underlying composition.
