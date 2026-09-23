# Full arrangement review — 2026-09-12

> **Historical record.** This review describes the code and catalogue as they were on its date. The current code format, loop selection and measured fidelity are documented in the [README](../README.md#how-the-code-is-generated).

The reported Teen Spirit output had two independent problems: a damaged transcription and an event-heavy full-song compiler. Browser playback also reproduced a failing remote snare download. A successful pattern evaluation alone did not establish working audio.

## Source selection

The previously pinned `.8.mid` still decoded illegal MIDI velocity values (129/127) after its track headers had been repaired. Its note data was therefore unsuitable for a fidelity claim. It has been replaced with the unmodified Lakh Clean MIDI `Nirvana/Smells Like Teen Spirit.7.mid`, whose checksum and reason are recorded in the curated manifest.

The replacement contains 131 bars at 120 bpm, about 4:22 including the ending. It has named clean, distorted and overdub guitars, finger bass, vocals and a full drum kit. Vocals are automatically excluded. Variant `.2.mid` was also inspected but lacked the hats and cymbals. The app discloses that this is a shorter alternate transcription, not a verified reproduction of the released recording.

## Automatic generation

Full arrangement now calls `prepareArrangement()` before rendering patterns. It retains the complete bar range, including rests and the ending, chooses a shared rhythmic grid, steadies dynamics, merges coincident attacks and removes empty/muted events. For a mostly doubled guitar, only matching attacks are removed; its unique fills and solo remain. Percussion keys selecting the same recorded sample are combined without triggering it twice at the same instant.

The emitter uses native Strudel `pickRestart()` lookups, repeated riff patterns and compact drum dictionaries. No song-specific notes or authored riffs were added. Main loop remains an excerpt; Source detail keeps the original instrumental events. The website Full arrangement option and CLI `--full-song` both use the new path.

The final Teen Spirit full arrangement is **9,122 characters / 117 lines**, including source and simplification comments. The prior browser output was **235 lines**. The new output includes the entire alternate transcription and its guitar solo. This comparison also changes the source file; it is not a lossless compression claim.

## Actual audio and validation

The 11 selected acoustic VCSL hits (8.6 MiB, CC0) are served with the app at their original Strudel sample indices and decoded before playback. Other sample variants keep their upstream URLs. Source URLs and SHA-256 hashes are retained alongside the assets. This fixes the reproduced remote snare-fetch failure without substituting an electronic snare.

The runtime harness now matches the embedded REPL's parsing: double-quoted mini-notation is processed by the transpiler, while single quotes remain literal unless passed explicitly to `mini()`. It also treats query errors that Strudel logs and converts to empty results as failures. These checks caught two silent-output problems during development that syntax validation alone missed.

- 465 unit/regression tests pass; core and website TypeScript checks and the production build pass.
- Every cleaned pitched attack/release and every merged drum attack is compared against actual Strudel events across every bar of Teen Spirit and Love Me Do; whole-form restarts, rests, drum de-duplication and preservation of unique solo notes are covered.
- Full-catalogue audit: all 12,236 entries compiled with no bar/track cap, no runtime failures, no truncation and no unexpected empty output. Queries covered the beginning, midpoint, ending and whole-form restart. Two vocal-only sources remain explicitly unavailable for instrumental playback (`metallica--die-die-my-darling`, `styx--crystal-ball`). Reproduce with `node tools/library-check.mjs --timing=patterns --simplify --full --workers=4`.
- Browser playback was exercised at the introduction, bar 41, the solo region and the ending. The final build loads the bundled samples successfully and reports no new pattern/sample errors in those checks.

Neither runtime checks nor source inspection certify note-for-note or timbral fidelity to the master recording. Quantization, simplified dynamics, source arrangement differences, soundfonts and unsupported pitch bends remain audible limitations.
