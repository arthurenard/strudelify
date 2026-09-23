# Live-coding output audit

> **Historical record.** This review describes the code and catalogue as they were on its date. The current code format, loop selection and measured fidelity are documented in the [README](../README.md#how-the-code-is-generated).

Historical full-arrangement audit. The default now uses automatic Main loop selection; see
[the pipeline review](pipeline-review.md) for the current behavior and expanded catalogue.

12 September 2026. The previous renderer optimized individual MIDI-event fidelity at the expense of
readable Strudel. Smells Like Teen Spirit produced 235,953 characters in 500 lines, with repeated
`timecat`/`pure` event arrays and large timing weights. Tiny differences between otherwise identical
bars prevented phrase reuse.

## Result

The website and CLI now default to reusable live-coding patterns. Core callers can select
`compile(song, { timing: 'patterns' })`; the API's source-detail default remains compatible.

- Repeated 1–4-bar phrases become named riffs, followed by explicit `arrange()` sequences.
- Pitched parts use `note()` mini-notation; percussion uses `n()` with a shared sound per part.
- Repeated chord voicings become a root pattern plus `transpose("0,7,12")`, for example.
- Individual durations and varying controls use compact colon mappings when ordinary note lengths
  cannot represent them. Common velocity, gain, pan and sound are applied once per instrument.
- Drum parts are separate so the kick, snare, hats and cymbals can be edited or muted independently.
- The final `stack()` lists the editable mix. Repeated phrases are defined once, not serialized again.

Smells Like Teen Spirit now produces **19,649 characters in 239 lines**, approximately **92% smaller**.
Its 145-bar arrangement and 5,458 instrumental events remain, including all 3,631 pitched notes.
The bass is expressed using three reusable riffs. One of them is:

```js
const bass_riff2 = note("<[f1!4 a#1!4] [g#1!4 c#2!3 c2]>").legato(1)
```

## Deliberate timing tradeoff

Live-coding output rounds note onsets and durations to nearby musical fractions, each within 15 ms
of the source. It retains note pitches, event multiplicity and source dynamics to six decimal places.
It can align very close onsets; it does not retain the original microtiming exactly. **Source detail**
in the website or `--source-detail` in the CLI returns the unrounded event representation.
The generated header and code-style tooltip disclose the adjustment.

Both styles retain detected-vocal exclusion, the selected instrumental patches, full-song options and
reviewed acoustic percussion. Chord-only sources continue to generate accompaniment.

## Validation

- **439 tests pass across 15 files.** New tests execute both renderers with the installed Strudel
  transpiler and pattern engine and compare every instrumental event in the two curated songs.
- Comparisons verify pitches, counts, per-note dynamics, onsets and durations within the disclosed
  tolerance, plus loop-boundary equivalence. Tests cover weighted repetition, multi-bar riffs,
  chord transposition, reserved names, vocal exclusion and excerpt limits.
- All **10,644 library entries** pass the full-arrangement runtime scan: zero compilation or
  sampled loop-boundary failures, zero truncated entries and zero orphan source files. The two known
  vocal-only transcriptions remain explicitly unavailable. This scan samples each pattern at its
  beginning, middle, end and next loop boundary; it is not a recording-fidelity evaluation.
- Type checking and the production build pass. CLI smoke checks verify both default riffs and
  `--source-detail` output.
- Browser playback of the new Nirvana output advances without logged warnings or errors. Switching
  between Live coding and Source detail changes the editor from 239 to 500 lines and back.
- The new selector remains visible at 390-pixel width, with no document-level horizontal overflow.

The full-library runtime audit uses all bars and all instrumental tracks:

```sh
npm run typecheck
npm test
node tools/library-check.mjs --timing=patterns --full --workers=4 --output=/tmp/strudelify-pattern-library.json
npm run build
```

These are conversion and playback checks. The underlying MIDI sources and soundfonts have the
[fidelity limits already documented](music-quality-audit.md#remaining-fidelity-limits); a more readable
representation does not establish equivalence to the original recording.
