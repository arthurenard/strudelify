# Instrumental performance audit

> **Historical record.** This review describes the code and catalogue as they were on its date. The current code format, loop selection and measured fidelity are documented in the [README](../README.md#how-the-code-is-generated).

Completed 11 September 2026 against the local database and rebuilt production site. The subsequent
[live-coding audit](live-coding-audit.md) documents the new default editable output and its timing tradeoff. This supersedes
the musical-rendering conclusions in the initial [website audit](site-audit.md).

## Library results

| Measure | Result |
| --- | ---: |
| Catalogue entries | 10,644 |
| MIDI entries | 10,176 |
| Chord-only entries | 468 |
| MIDI entries also carrying a chord chart | 271 |
| Entries loaded and evaluated, including follow-up checks | 10,644 |
| Unresolved compilation or sampled loop failures | 0 |
| Entries without separately identified instrumental parts | 2 |
| Normalized artist/title duplicate groups | 18 |
| Orphan source files | 0 |

The two unavailable instrumentals are Styx's **Crystal Ball** and Metallica's **Die, Die My Darling**.
Their only surviving source tracks are identified as vocal parts. The website explains the missing
instrumental arrangement and disables playback. The count represents catalogue entries, not distinct
compositions or verified reproductions of recordings. Chord-only entries visibly say **Generated
accompaniment**.

The full scan evaluates generated Strudel through its transpiler and pattern engine at the start,
middle, end and next loop boundary. It exposed a track named `undefined` in Rush's **Marathon**;
generated identifiers now reserve that name and other native renderer functions. Targeted reruns
verified this fix, both final curated sources and the two unavailable instrumentals. The generated
`library-report.json` records that follow-up separately; its initial pattern count is a scan metric.
This scan does not listen to every note or evaluate each recording's musical fidelity.

## Renderer changes

- Native `arrange`/`timecat`/`pure` patterns preserve separate strum and flam onsets, overlapping note
  durations and individual velocities. Source tempo changes preserve elapsed time. Integer timing
  weights keep evaluation practical without coarse rhythmic quantization.
- All detected vocal parts are excluded, including vocal tracks classified as chords or bass.
  Instrumental leads keep their own patches. The synthesized-vocal sound selector is removed.
- Onset volume, expression and pan are retained. Quiet instrumental fills remain; channel unmuting
  works even when the median controller level is zero. Within-note swells still use a mean level.
- The website requests all bars and all instrumental tracks. CLI/core defaults still cap 258 entries
  at approximately 200 bars of 4/4; those caps are configurable and disclosed in generated output.
- Every landing-page example now loads its cover automatically.

## Reviewed sources

| Song | Final source | Instrumental pitched notes | Loop length |
| --- | --- | ---: | ---: |
| Love Me Do | `The Beatles/Love Me Do.mid` | 1,389 | 152.78 s |
| Smells Like Teen Spirit | `Nirvana/Smells Like Teen Spirit.8.mid` (repaired chunk lengths) | 3,631 | 300 s |

Love Me Do replaces the embellished organ/synth-brass/synth-strings version with acoustic guitar,
bass, harmonica and drums. Smells Like Teen Spirit replaces the shorter slap-bass source with a fuller
arrangement using pick bass and guitar parts. Its synth vocal-guide channel is explicitly excluded;
its double-time notation is normalized to 116 BPM without changing elapsed note times.

Four malformed track-length headers in the Nirvana source were repaired; track payload bytes were
unchanged. Both sources are checksum-pinned, attributed and reproducible through the builder. See the
[curation record](../packages/data/curated/README.md) and manifest for provenance and limitations.
Both songs use recorded VCSL acoustic percussion instead of Strudel's default electronic drum kit.
Some cymbal/tom variants remain approximations.

Automatic source selection now scores duration, instrumental coverage and track naming with capped
note-count bonuses. This avoids treating more notes as inherently better. The current database has
the two reviewed replacements; the revised scoring applies to the remaining catalogue on rebuild.
The builder refuses to delete the existing database when its raw MIDI input is empty.

## Validation

- **431 tests pass across 14 files**, including actual Strudel event comparisons, vocal exclusion,
  source timing, note duration, dynamics, acoustic sample mappings and curated-source checksums.
- Both reviewed sources retain all instrumental pitched notes selected by the parser, with matching
  generated note onsets, durations and loop boundaries. Tempo normalization preserves elapsed time.
- Core/workspace and web type checks pass; the production build passes.
- Browser checks verify all four landing-page covers load, both reviewed songs play and advance
  without logged warnings/errors, and the vocal-only empty state disables playback. Opening a normal
  song afterward re-enables playback. Desktop and 390-pixel mobile layouts have no document-level horizontal overflow.

## Remaining fidelity limits

This is a transcription compiler, not a lossless reconstruction of recorded audio. The remaining
catalogue has not been manually compared with recordings. MIDI sources can omit or invent notes,
mislabel instruments or represent different performances; vocal detection and source cleanup remain
heuristic. Pitch bends, continuous expression, guitar/amp timbres, sample articulations and studio
production are not reproduced exactly. Chord charts cannot supply original instrumental note parts.
The two reviewed sources are substantial improvements, not certified note-for-note matches to masters.

Re-run conversion checks after building core:

```sh
npm run typecheck
npm test
node tools/library-check.mjs --workers=4
npm run build
```
