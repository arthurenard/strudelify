# art-check: cover-art coverage harness

`tools/art-check.mjs` runs the web app's cover-art resolver (`packages/web/src/art.ts`) from Node
against a sample of `packages/data/public/db/index.json` and reports how many songs get artwork and
how fast. It imports the TypeScript source directly (through `tsx`, already a root dev dependency),
so the harness and the browser always execute the same code path.

## Usage

```bash
node tools/art-check.mjs                     # 100 most popular songs + 20 random (seed 1)
node tools/art-check.mjs --n 40 --random 10  # smaller sample
node tools/art-check.mjs --ids nirvana--smells-like-teen-spirit,brown-james--cold-sweat
node tools/art-check.mjs --query "Pink Floyd|Another Brick in the Wall, Part 2" --verbose
node tools/art-check.mjs --json out.json --verify --min 97   # + HEAD-check images; exit 1 below 97 %
node tools/art-check.mjs --n 40 --random 0 --block itunes    # what users see while iTunes rate-limits them
```

| option | default | meaning |
| --- | --- | --- |
| `--n` | 120 | sample size (highest popularity first) |
| `--random` | 20 | how many of `--n` are drawn at random from the rest of the database |
| `--seed` | 1 | seed of the random draw (deterministic samples) |
| `--concurrency` | 1 | songs resolved in parallel; requests are still serialised per host. With 1 the report also gives time-to-art net of the harness's iTunes spacing |
| `--gap-itunes` | 2000 | minimum ms between two iTunes requests (≈ 30 req/min; the browser uses 350 ms because it resolves one song at a time) |
| `--budget` | 8000 | wall-time budget per song for the track sources, as in the browser (`inf` to disable) |
| `--no-year` | off | drop the database year ranking hint. The hint is on by default because `main.ts` calls `lookupArt(id, artist, title, { year })`, so the default run measures exactly what the browser chooses |
| `--block <hosts>` | – | simulate an outage: the listed hosts (aliases `itunes`, `deezer`, `musicbrainz`, `coverart`, or full host names, comma-separated) answer 403 at the fetch level, so the queue's retry, cool-down and skip logic runs as in a browser that tripped the iTunes rate limit. `--block itunes` measures the Deezer path every user hits at that moment |
| `--no-artist` | off | skip the artist-picture fallback (measures pure track-art coverage) |
| `--verify` | off | HEAD-request every chosen image and report the ones that do not return an `image/*` 2xx |
| `--verbose` | off | print every request, retry, cool-down, skip and candidate count |
| `--json <file>` | – | write per-song results and statistics |
| `--db <file>` | `packages/data/public/db/index.json` | index to sample from |
| `--min <pct>` | 0 | exit 1 when track-art coverage is below this percentage |

## What it measures

- **track art**: the resolver found the song's own release (`kind: 'track'`; sources `itunes`,
  `itunes-album`, `deezer`, `deezer-album` (the album route), `musicbrainz`).
- **track or artist art**: track art, or at least a Deezer artist portrait (`kind: 'artist'`).
- everything else is a `placeholder` (deterministic gradient generated from the title).
- **time-to-art per song**: p50 / p95 / max / average and the number of songs over the 8 s budget, so a
  regression in time-to-art is visible even when coverage is unchanged. Reported net of the harness's
  own iTunes spacing (the queue tells how long each request waited for its lane) – i.e. what a browser
  user resolving one song sees – and as raw wall time including that pacing.
- **requests / retries / cool-downs / skipped**: how the rate limiting behaved. A cool-down means a
  host exhausted its retries; "skipped" counts the sources that were passed over while a host cooled.

The summary lists the answering source per song and the songs without track art. Targets: ≥ 97 %
track art, 100 % with at least artist art on the default sample.

## Resolution chain (same in the browser)

1. iTunes Search, `entity=song`, with the cleaned title (parentheses, `feat.`, duplicate-file
   suffixes removed) and the re-ordered artist ("Brown James" → "James Brown", "Amos, Tori" → "Tori Amos");
   up to three spellings.
2. Deezer search (JSONP in the browser, plain JSON in Node): `artist:"…" track:"…"`, the same with Deezer's
   own `Pt. 2` spelling when the title has a part number (its strict search finds only a live remix for
   "Part 2"), then free text, then the other artist spellings. Deezer search rows carry no year, size or
   type, so the album details (`/album/<id>`: `record_type`, `nb_tracks`, `release_date`, album artist,
   `fans`) of the best three accepted releases are fetched and merged before ranking – the same signals
   iTunes gives, at ≈ 250 ms each. Deezer's track search shows one row per distinct title, the most-streamed
   one, which on old catalogue is the compilation ("Dancing Queen" is only ever listed on *ABBA Gold*). So
   when the best row is a compilation, a single, an alternate take or a release of unknown type, the
   **album route** asks Deezer's album search with a `track:` filter (`artist:"ABBA" track:"Dancing Queen"`),
   which lists every release of the artist carrying the song (*Arrival* next to *ABBA Gold*), ranks them
   by how album-like they are (`rankAlbumRows`: live / demo / remix / tribute releases and other artists'
   albums dropped, compilations, singles, box sets and reissues sunk, a real album with the song as title
   track lifted), looks up the best three in detail (type, size, followers, date and the first 25 tracks –
   the song must be on the release as a plain take) and lets the usual ranking choose between the
   compilation row and the album's own row (source `deezer-album`). Once per lookup, ≈ 1 s.
3. iTunes `entity=album` (title tracks, singles, EPs) and remaining spellings.
4. MusicBrainz recording search, then Cover Art Archive `release-group`/`release` front covers.
5. Deezer artist picture.
6. Placeholder.

Candidates are scored by fuzzy similarity of artist and title (bigram Dice + token overlap, with
`Pt.`/`Part`, `&`/`and`, diacritics and apostrophes unified). A candidate whose title starts with the
whole query title and adds at most four words ("Killing Me Softly" → "Killing Me Softly With His Song")
is accepted when the artist matches strongly. Karaoke, tribute and "in the style of" results are
rejected, and so is an artist that wraps ours in extra words ("Celtic Pink Floyd", "The Australian
Pink Floyd Show") unless it is a collaboration ("Ike & Tina Turner") or a suffix ("The Jimi Hendrix
Experience"). Live, demo/outtake, remix, megamix/medley and compilation releases, singles, deluxe
reissues, box sets (iTunes `discCount` ≥ 3 or `trackCount` ≥ 20), bootleg/"Month YYYY" concert
albums, orchestral / philharmonic re-recordings, stadium and festival recordings ("Rock in Rio",
"Wembley", "Live Aid"...), non-Latin regional editions and later years are penalised so the original
studio release wins. The "title track" bonus only goes to a release known to be an album (a track count
of five or more, or Deezer's `album` type): an album named like the track with no size is a single.
Deezer's popularity `rank` is weighted so that the most-streamed accepted studio candidate wins (a track
below 10 % of the top rank is an obscure release; a compilation earns only half of the bonus, so the
original album found by the album route can overtake the compilation row that Deezer's search shows for
the same song), a release with under 5 % of the followers of the most
followed one is a grey-market re-upload, and a digital-edition date is used only as a match with the
database year or as a marker of a streaming-era upload of a song more than 20 years older – never to
order releases (Deezer dates "A Night at the Opera" 2005). A weak artist match (title identical, artist
only similar) is accepted only for a related name – one whose words are a subset of the other's, such
as "Zero" / "Renato Zero" or "Paul Simon" / "Simon & Garfunkel" – never for a shared word ("Taylor
James" / "Taylor Swift"). A hit scoring below `GOOD_SCORE` (1.7: a live take, a remix...) is kept as a
fallback while the remaining queries look for a confident one; a plain studio take is returned before
the MusicBrainz round trip, a live / remix / demo take only after MusicBrainz found nothing. A confident
hit on a compilation buys one extra query of the same source (the original album is often one spelling
away: "Bangles" finds *Everything* where "The Bangles" finds a compilation) and is then returned. A
Deezer digital-edition date is reported as the year only when it matches the database year or, when the
database has none, predates the streaming era (The Wall 1979 yes, "A Night at the Opera" 2005 no).

## Rate limiting and time-to-art

Requests go through one queue with a lane per host (spacing 350 ms on iTunes in the browser, 200 ms
Deezer, 1.1 s MusicBrainz). A failed request (403/429/5xx/network) is retried with exponential
back-off, but only once on iTunes (its 403s persist for tens of seconds); when the retries are
exhausted the lane goes on a cool-down (20 s iTunes, doubling on consecutive failures, reset by any
success) and the chain **skips** that host instead of waiting, so a rate-limited iTunes costs about
one second before Deezer is asked. The track sources share an 8 s wall-time budget; when it runs out
the artist picture (granted 3 s more) or the placeholder is returned. Cool-downs are shared across
lookups, so the next song goes straight to Deezer while iTunes is cooling.

## Cache

Hits are cached in `localStorage` under `art:v3:<id>`; misses and placeholders never are. Artist
portraits and track hits with a low match score (< 1.7: fuzzy title or a penalised release) are
re-validated after a week; confident matches are permanent.
