# Strudelify website audit

Initial audit completed 11 September 2026. The subsequent [instrumental performance audit](music-quality-audit.md) supersedes the renderer, test totals, source choices and fidelity limitations below.

## Library

| Measure | Verified count |
| --- | ---: |
| Catalogue entries | 10,644 |
| Entries with MIDI | 10,176 |
| Chord-chart-only entries | 468 |
| MIDI entries also carrying a chord chart | 271 |
| Referenced source files | 10,915 |
| Missing files in the source or production build | 0 |
| Empty compiled outputs | 0 |

The index contains alternate transcriptions and artist/title spelling variants. Eighteen groups already
duplicate the same normalized artist/title; this does not identify every possible duplicate. **10,644 is
an entry count, not a verified count of distinct songs.** The landing page, search placeholder and search
footer now say “library entries,” with the count derived from the actual index. The landing page explains
that alternate transcriptions are included. The production index matches the source index.

## Fixes

- Six songs generated invalid JavaScript from track names such as `New` and `This`. Part identifiers now
  avoid JavaScript keywords, Strudel functions and the player's generated `m` helper.
- A full-bar MIDI note could emit a top-level weight such as `<c2@16 …>`, stretching that part's pattern
  and losing synchronization. Full-bar notes now occupy one cycle.
- Overlapping notes and notes crossing a bar line lost their original releases. Affected parts now carry
  individual durations using Strudel's note/duration mapping. Sustained bars also count toward mix activity.
- “Cathedral” generated an empty `stack()`: expression was nearly silent at every note-on and rose during
  the held guitar notes. Those swells are now measured during the notes, preserving both guitar parts.
- Partial final bars caused loop-boundary failures in 13 chord-only charts. Partial bars now include the
  remaining rest, keeping the generated arrangement aligned with the timeline.
- Search no longer collapses different numbered parts or short distinct titles merely because they are
  within two character edits. Numbered parenthetical parts remain distinct. Artist result groups also
  collapse alternate transcriptions before displaying their song counts.
- Rewind now brings the beginning of a zoomed timeline into view even immediately after a pan or seek.
- Corrected the instrumental-lead tooltip wording.

## Validation

- **424 tests pass** across 11 test files, including new regressions evaluated through the installed
  Strudel transpiler and pattern engine.
- All **10,644 entries** load and compile. MIDI patterns were evaluated at their beginning, middle, end
  and next loop boundary; no unresolved conversion or loop failures remain.
- After the partial-bar correction, all **468 chord-only charts** were evaluated across their complete
  arrangements: **687,230 events**, with zero failures and matching loop boundaries.
- Search regression checks pass, including 318 typing-prefix checks, 69 resolution verdicts and 10 CLI
  compilation verdicts.
- Type checking and the production build pass. All 10,915 referenced assets are included in the build.
- Browser checks cover the revised count, distinct Oxygene parts, playback of “Cathedral,” “When I Come
  Around” and “Shadow Dancing,” seeking and immediate rewind. No runtime warnings or errors were observed
  in these playback checks. Layouts at 390, 768 and 1440 pixels have no document-level horizontal overflow.

Detailed results: [library-report.json](library-report.json).

Re-run after compiling the core package:

```sh
npm run typecheck
npm test
node tools/library-check.mjs --workers=4
npm run build
```

## Musical-fidelity limits

These checks validate the conversion and website; they do not certify every transcription against its
original recording. Source arrangements vary in quality. MIDI rhythm is quantized, pitch bends are
ignored, most changing controller levels are summarized, and instrument/lead roles can be inferred.
Chord-only entries generate accompaniment rather than a full note-for-note arrangement.

The default compiler cap truncates **256 entries** to approximately 200 bars of 4/4. The generated header
and the website's length selector disclose this; the website can render the whole song. The default
pitched-track limit is 12. These remain intentional, documented limits.

The finished artifact is the local production build in `packages/web/dist`.
