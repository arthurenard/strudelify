import type { IndexEntry, Song } from './types.js';
import { songFromMidi, detectSectionsFromMidi } from './midi.js';
import { parseMcgill } from './mcgill.js';

export type FileReader = (relativePath: string) => Promise<Uint8Array>;

/** Load and parse a song from its index entry. `read` resolves a db-relative path to bytes. */
export async function loadSong(entry: IndexEntry, read: FileReader): Promise<Song> {
  let song: Song | null = null;
  if (entry.files.midi) {
    const bytes = await read(entry.files.midi);
    song = songFromMidi(bytes, { id: entry.id, title: entry.title, artist: entry.artist, year: entry.year }, { sourceTiming: true });
  }
  if (song && entry.beatScale && entry.beatScale > 0 && entry.beatScale !== 1) {
    const scale = entry.beatScale;
    song.meta.bpm *= scale;
    if (song.meta.barOffset !== undefined) song.meta.barOffset *= scale;
    for (const track of song.tracks) for (const note of track.notes) { note.start *= scale; note.duration *= scale; }
    song.sections = detectSectionsFromMidi(song);
    song.meta.remarks = [...(song.meta.remarks ?? []), `Notation rate scaled by ${scale}; elapsed note times unchanged.`];
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
  for (const track of song.tracks) if (track.channel !== undefined && entry.vocalChannels?.includes(track.channel)) track.vocal = true;
  song.meta.drumKit = entry.drumKit;
  if (entry.provenance) song.meta.remarks = [...(song.meta.remarks ?? []), `Transcription provider: ${entry.provenance.provider}. ${entry.provenance.url}; license: ${entry.provenance.license}`];
  song.meta.title = entry.title;
  song.meta.artist = entry.artist;
  song.meta.year = entry.year;
  return song;
}
