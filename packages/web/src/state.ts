/**
 * The one mutable state object shared by the modules. Everything that changes at runtime lives here,
 * so a reader can see the whole app state in one place.
 */
import type { IndexEntry, SongIndex, Song, Timeline } from '@strudelify/core';
import { prettyChord, type ArtistGroup } from './ui.js';

/**
 * Where the chord lane's symbols come from:
 * - `chart`: the human-annotated chart (McGill), which is also what the generated code prints;
 * - `detected`: chords read from the MIDI notes bar by bar (MIDI-only songs, also what the code prints);
 * - `mismatch`: detected from the MIDI while the code prints a McGill chart of a different cut of the
 *   song, so the two cannot be laid on one grid. The transport says so.
 */
export type ChordSource = 'chart' | 'detected' | 'mismatch';

export interface Current {
  entry: IndexEntry;
  song: Song;
  tl: Timeline;
  code: string;
  /** Whether chord symbols are spelled with flats in this key. */
  flats: boolean;
  chordSource: ChordSource;
}

export const state = {
  index: null as SongIndex | null,
  indexError: null as string | null,
  artistIndex: new Map<string, ArtistGroup>(),
  current: null as Current | null,
  /** Id of the song being opened (set before the fetch, so a slower earlier load cannot win). */
  loadingId: null as string | null,
  /** The scheduler is running. */
  started: false,
  /** Bar to resume from while stopped. */
  pausedBar: 0,
  /** Bar to display right after a seek, until the scheduler has caught up. */
  pendingSeek: null as { bar: number; until: number } | null,
  /** The user is dragging the slider. */
  scrubbing: false,
};

/** Chord symbol for display in the current song's key spelling. */
export const chordLabel = (symbol: string): string => prettyChord(symbol, state.current?.flats ?? false);
