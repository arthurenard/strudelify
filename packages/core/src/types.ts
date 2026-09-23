/**
 * Canonical song model. Everything the compiler needs, independent of the
 * dataset it came from. Times are expressed in beats (quarter notes unless
 * the metre says otherwise) so the Strudel code can be generated in cycles.
 */

export type Source = 'mcgill' | 'midi';

export interface SongMeta {
  /** Preserved full-song period after instrumental cleanup, including rests. */
  arrangementBars?: number;
  /** Explicit period of an automatically selected excerpt, including its trailing rest. */
  loopBars?: number;
  /** Steps per bar that a Main loop or Full arrangement quantised its notes to (onsets and lengths). */
  grid?: number;
  /** Explicit reviewed drum sound profile; otherwise use the default bank. */
  drumKit?: 'acoustic';
  id: string;
  title: string;
  artist: string;
  /** Beats per minute of the dominant tempo. */
  bpm: number;
  /** Beats per bar (numerator of the metre). */
  beatsPerBar: number;
  /** Beat unit (denominator of the metre). */
  beatUnit: number;
  /** Tonic pitch class, e.g. "C", "Bb", "F#". */
  tonic?: string;
  mode?: 'major' | 'minor';
  year?: number;
  sources: Source[];
  /**
   * Beat position of bar 0's downbeat. Usually 0; negative when the file opens with a pickup
   * bar in another metre, so that the following bars still start on cycle boundaries.
   */
  barOffset?: number;
  /** Human-readable analysis notes (tempo/metre changes, sustain, ignored pitch bends) emitted as code comments. */
  remarks?: string[];
}

/** One chord held for `beats` beats. `symbol` is a Strudel-friendly chord symbol, or null for no chord. */
export interface ChordEvent {
  symbol: string | null;
  beats: number;
}

export interface Section {
  /** Normalised label: intro, verse, chorus, bridge, solo, outro ... */
  label: string;
  /** Raw label from the source, kept for display. */
  raw?: string;
  bars: number;
  chords: ChordEvent[];
}

export interface NoteEvent {
  /** MIDI pitch number. */
  pitch: number;
  /**
   * Start in beats from the song start. For MIDI songs these are beats of the dominant tempo
   * measured in real time, so sections at another tempo are stretched or compressed accordingly.
   */
  start: number;
  /** Duration in beats (same unit). */
  duration: number;
  velocity: number;
  /** CC 7 × CC 11 at the note onset (0–1), when present. */
  volume?: number;
  /** CC 10 at the note onset (0–1), when present. */
  pan?: number;
}

export type TrackRole = 'melody' | 'bass' | 'chords' | 'drums' | 'other';

export interface Track {
  name: string;
  /** General MIDI program number 0-127, or -1 for percussion. */
  program: number;
  role: TrackRole;
  notes: NoteEvent[];
  /** MIDI channel 0-15 when the track came from a MIDI file. */
  channel?: number;
  /** Channel volume (CC 7) times expression (CC 11), each 0-1. Undefined when the file sets neither. */
  volume?: number;
  /** Stereo position from CC 10: 0 = left, 0.5 = centre, 1 = right. Undefined when the file never pans the channel. */
  pan?: number;
  /**
   * True when the part stands in for a singer: a vocal-like patch (choir, voice, synth voice, breath)
   * or a track name that says vocal/vox/lead vocal. Such parts are excluded from the instrumental output; other melodies keep their own instrument.
   */
  vocal?: boolean;
  /**
   * True when the melody is carried by several parts that take turns (a singer's channel that
   * changes patch per section, or stand-in patches spread over channels: a sax for the verse, a
   * horn for the chorus). With `vocal` set too, each is a section of the sung line and is excluded from output; without it the parts are an instrumental lead in sections and keep their
   * own patches.
   */
  sungLine?: boolean;
  /** Analysis notes about this part (a pan or volume that moves mid-song), emitted in its code comment. */
  remarks?: string[];
}

export interface Song {
  meta: SongMeta;
  /** Song structure with chords. Human-annotated for McGill songs, detected per bar for MIDI songs. */
  sections: Section[];
  /** Human-annotated structure when the notes come from MIDI but McGill also has the song. */
  structure?: Section[];
  /** Note-level material from MIDI. Empty for McGill-only songs. */
  tracks: Track[];
}

/** A compact row in the searchable index shipped to CLI and web. */
export interface IndexEntry {
  /** Selection notes for alternate or reviewed transcriptions. */
  sourceNote?: string;
  /** Attribution and quality metadata from an external transcription provider. */
  provenance?: { provider: 'pdmx' | 'klangio'; url: string; license: string; rating?: number; ratings?: number };
  /** Reviewed notation-rate correction; scales both beats and BPM, preserving elapsed time. */
  beatScale?: number;
  /** Reviewed zero-based MIDI channels carrying a vocal guide. */
  vocalChannels?: number[];
  /** Explicit reviewed drum sound profile. */
  drumKit?: 'acoustic';
  id: string;
  title: string;
  artist: string;
  year?: number;
  sources: Source[];
  bpm?: number;
  key?: string;
  /** Rough popularity: number of MIDI transcriptions found plus a bonus for charting hits. */
  popularity?: number;
  /** Files relative to the database root, e.g. `songs/queen-bohemian-rhapsody.mid`. */
  files: { midi?: string; mcgill?: string };
}
