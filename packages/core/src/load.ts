import type { IndexEntry, Song } from './types.js';
import { songFromMidi } from './midi.js';
import { parseMcgill } from './mcgill.js';

export type FileReader = (relativePath: string) => Promise<Uint8Array>;

/** Load and parse a song from its index entry. `read` resolves a db-relative path to bytes. */
export async function loadSong(entry: IndexEntry, read: FileReader): Promise<Song> {
  let song: Song | null = null;
  if (entry.files.midi) {
    const bytes = await read(entry.files.midi);
    song = songFromMidi(bytes, { id: entry.id, title: entry.title, artist: entry.artist, year: entry.year });
  }
  if (entry.files.mcgill) {
    const text = new TextDecoder().decode(await read(entry.files.mcgill));
    const mc = parseMcgill(text, entry.id);
    if (!song) song = mc;
    else {
      // Keep the note-level MIDI material and its per-bar chords; add the human-annotated structure and key.
      song.structure = mc.sections;
      song.meta.tonic = mc.meta.tonic ?? song.meta.tonic;
      song.meta.mode = mc.meta.mode ?? song.meta.mode;
      song.meta.sources = ['mcgill', 'midi'];
    }
  }
  if (!song) throw new Error(`Entry ${entry.id} has no source files`);
  song.meta.title = entry.title;
  song.meta.artist = entry.artist;
  song.meta.year = entry.year;
  return song;
}
