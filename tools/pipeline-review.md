# Automatic Strudel pipeline review

12 September 2026. This supersedes the default-output recommendation in
[the earlier full-arrangement audit](live-coding-audit.md).

## What changed

The previous default serialized a whole MIDI performance. Naming repeated phrases reduced duplication,
but could not make a complete arrangement into a small live-coding sketch. The website and CLI now
default to **Main loop**; **Full arrangement** and **Source detail** remain explicit choices.

The pipeline has no song-specific branches or authored note sequences:

1. Load the source transcription and analyze instruments, timing and vocal tracks.
2. Fingerprint bars by pitch and onset across all instrumental parts.
3. Score coherent 2–4-bar windows for recurrence, bass/drum coverage, pitched material and density.
4. Select one passage shared by the band, with at most four pitched parts and six percussion voices.
5. Quantize to an 8/12/16/24/32-step bar grid; merge unison attacks and simplify dynamics and controls.
6. Generate one `note()`, `n()` or mapped mini-notation pattern per part. Factor common chord shapes,
   repeat identical bars naturally, and combine named parts in `stack()`.
7. Render the timeline from the same selected material, retaining the chosen period through rests.

The grid is chosen to fit at least 95% of onsets within 25 ms when possible; the fallback is 32 steps.
This is not a per-event timing guarantee. Durations are quantized too, and drum samples use their natural decay instead of MIDI key-release lengths.
Source metres longer than 16 quarter notes per bar or with numerators above 32 use an explicitly
disclosed 4/4 editing grid in Main loop. Full-song modes retain the original metre.

This is an editable excerpt, not an exact instrumental reconstruction of the original recording.
Its comments identify the source passage and simplifications. Full arrangement preserves source
instrumental pitches, counts and dynamics with up to 15 ms timing cleanup; Source detail retains
unrounded timing. Existing reviewed MIDI sources remain inputs, not hand-coded Strudel exceptions.

Teen Spirit's default changed from 239 lines / 19,649 characters to **36 lines / 1,530 characters**.
It selects source bars 7–8 automatically, with bass, overdriven guitar, kick, snare, open hat and crash.
That size comparison includes the deliberate change from a full song to an excerpt.

## Source/API decision

| Provider | Available data | Decision |
| --- | --- | --- |
| [PDMX via Zenodo](https://zenodo.org/records/15571083) | Downloadable MIDI scores, quality metadata and source links through a public record API | Implemented automatic filtered expansion. Score arrangements may differ from recordings. |
| [Klangio](https://api-docs.klang.io/docs/getting-started/basic-job-workflow) | Audio transcription jobs returning MIDI and other score formats | Candidate to benchmark for missing songs when API access and source audio are available. Not integrated or accuracy-verified. |
| [Spotify Web API](https://developer.spotify.com/documentation/web-api) | Music metadata and playback-related services | Does not supply the instrumental note events this compiler needs. |
| [Hooktheory Trends](https://www.hooktheory.com/api/trends/docs) | Chord-progression statistics and matching songs | Useful harmonic data, insufficient for complete instrumental transcriptions. |
| [Soundslice Data API](https://www.soundslice.com/help/data-api/) | Managing/exporting an account's notation content | Not an unrestricted catalogue of song transcriptions. |

The [PDMX authors](https://github.com/pnlong/PDMX) recommend the no-license-conflict subset. The importer
also requires a rating of at least 4.5/5 from five reviewers, valid non-draft material, no paywall or
lyrics, 2–16 tracks, 30–600 seconds and 100–12,000 notes. Metadata ratings are a selection signal,
not an independent verification of musical accuracy or underlying composition rights.

The importer downloads the pinned release through `https://zenodo.org/api/records/15571083`, verifies
both published checksums, extracts only selected regular files into staging, rejects insufficient
instrumental content, compiles each candidate, and executes its loop through the actual Strudel runtime.
Empty output, invalid runtime controls, wrong loop periods and code over 12,000 characters are rejected.
Normalized artist/title duplicates and existing IDs are skipped. Files are written before an atomic
index replacement, and an interrupted import can resume if existing bytes match.

The first run selected 1,639 candidates, skipped 35 existing identities, rejected 12, and added **1,592**.
The resulting local catalogue has **12,236 entries: 11,768 MIDI and 468 chord-only**; 271 MIDI entries
also have charts. Alternate titles and arrangements mean these are not 12,236 verified unique works.
Provider, score URL, declared licence, rating and review count are preserved. The UI labels imported
material **Score arrangement**. Review votes do not inflate search popularity.

`npm run data:expand` reproduces the expansion after building the base library. Raw archives and the
generated database are ignored by Git. `--dry-run`, `--limit=...` and `--db=...` support review and testing.
No paid transcription jobs, account creation or audio uploads were performed. An authenticated
Klangio benchmark would be needed before claiming its transcription quality is better for this library.

## Validation

Final catalogue measurement (all 12,236 entries, including comments):

| Metric | Median | 95th percentile | Maximum |
| --- | ---: | ---: | ---: |
| Generated characters | 2,234 | 3,762 | 6,203 |
| Generated lines | 41 | 54 | 55 |

All 12,236 entries passed the runtime audit, with no failures, unexpected empty outputs, truncated
loops or orphaned files. There are 18 pre-existing normalized artist/title duplicate groups and two
explicitly unavailable instrumental transcriptions. All 453 JavaScript regression tests and two
Python importer tests pass; TypeScript checks and the production build pass. Re-running the importer
added zero entries and preserved the 12,236-entry index.

- All-library audit: load every source, compile, execute through Strudel, inspect runtime controls,
  compare the first and repeated loop boundaries, and check empty sources, duplicate IDs and orphans.
- Regression tests cover repeated-passage discovery, coherent parts, source immutability, trailing
  rests, vocal exclusion, chart loops, percussion limits, unusual metres, metadata escaping and
  direct patterns across varying gates and voicings. Earlier full-performance fidelity tests still pass.
- Importer tests cover quality filters, duplicate metadata, malformed numeric fields, traversal paths
  and symbolic links. A dry run against a temporary base index admits the same 1,592 entries.
- Browser checks: Main loop / Full arrangement / Source detail, Teen Spirit playback controls,
  a PDMX score, chord-chart switching, mobile layout and four loaded homepage covers.

Runtime checks establish executable code and correct repetition, not listening-test equivalence.
Two existing entries have no separately identified instrumental parts and correctly disable playback.

Reproduce with:

```sh
npm test
python3 -m unittest discover -s packages/data/scripts -p 'test_*.py'
npx tsc -b
npx tsc --noEmit -p packages/web
npm run build -w @strudelify/web
node tools/library-check.mjs --timing=patterns --loop --workers=4
node tools/loop-size.mjs
```
