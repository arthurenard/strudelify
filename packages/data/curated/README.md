# Reviewed source selections

These source MIDI files come from Colin Raffel's [Lakh Clean MIDI subset](https://colinraffel.com/projects/lmd/), distributed under CC BY 4.0. Attribution: Colin Raffel, *Learning-Based Methods for Comparing Sequences, with Applications to Audio-to-MIDI Alignment and Matching*, PhD thesis, 2016. The original transcribers are not consistently identified in that dataset; the source files retain their metadata.

`manifest.json` records original filenames, SHA-256 checksums and selection reasons. The builder pins these files after automatic candidate scoring. This prevents a higher note count from replacing a reviewed arrangement. The `drumKit` setting selects recorded VCSL acoustic percussion already available in the Strudel REPL.

- **Love Me Do:** replaces the organ/synth-brass/synth-string arrangement with an instrumental acoustic guitar, bass and harmonica version. Its 12/8 notation at approximately 205 quarter notes per minute corresponds to about 137 dotted-quarter beats per minute. This is an alternate transcription, not an audio-verified match to a specific released take.
- **Smells Like Teen Spirit:** uses the approximately five-minute variant with electric pick bass and guitar parts. Four incorrect MIDI track-length headers were repaired; event payloads remain unchanged. All ten tracks parse through an end-of-track event. The manifest records both original and repaired hashes. The synth guide on zero-based channel 2 is explicitly excluded as vocals. Its double-time notation is displayed at 116 bpm by scaling both note beats and BPM by 0.5, preserving elapsed time. This establishes a fuller arrangement, not an audio-verified match to the master recording.

Neither selection has been certified note-for-note against a recording. Soundfonts, acoustic sample variants, unsupported continuous pitch bends and transcription differences remain audible limitations. Reviewing instrumentation is distinct from proving recording fidelity.
