/**
 * Opening a song: skeleton, fetch + parse, compile, hero (art, tint, chips), options, recompile on change.
 */
import { loadSong, compile, timeline, barRange, gmLabel, chordSummary, type IndexEntry, type Song, type CompileOptions } from '@strudelify/core';
import { lookupArt } from './art.js';
import { el, setStatus, showBanner, hideBanner, toast, prefersReducedMotion } from './dom.js';
import { state } from './state.js';
import { loadRepl } from './repl.js';
import { play, stop } from './player.js';
import { renderTimeline, updatePosition, clearTimeline } from './timeline.js';
import { showCode, clearCode } from './code.js';
import { closeSearch, rememberRecent } from './search.js';
import {
  esc, fmt, songTint, initial, displayArtist, keyName, prefersFlats, structureSections, structureChords,
  albumLine, titleSize, barCapOptions, dominantHsl, respellChordLine, respellKeyLine, replaceChordLine, midiKey, chartShift, shiftTonic,
  partList, deriveForm, leadName,
} from './ui.js';

export function showSection(which: 'song' | 'empty' | 'notfound') {
  el.song.hidden = which !== 'song';
  el.empty.hidden = which !== 'empty';
  el.notFound.hidden = which !== 'notfound';
}

function setTitle(text: string) {
  el.title.textContent = text;
  el.title.title = text;
  el.title.className = `title ${titleSize(text)}`;
}

const readFile = async (p: string) => {
  const res = await fetch(`/db/${p}`);
  if (!res.ok) throw new Error(`${p}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
};

// ---------- options ----------
/** Bar-cap choices for this song: only caps shorter than the song, plus "All N bars"; the default is the whole song. */
function fillBarCaps(totalBars: number, meta: Song['meta']) {
  const { options: opts, value } = barCapOptions(totalBars, meta.beatsPerBar * (4 / meta.beatUnit));
  el.maxBars.innerHTML = opts.map((o) => `<option value="${o.value}">${esc(o.label)}</option>`).join('');
  el.maxBars.value = String(opts[opts.length - 1]?.value ?? value);
}
function options(): CompileOptions {
  return { timing: el.codeStyle.value === 'source' ? 'source' : 'patterns', melody: el.melody.checked, maxTracks: Number.MAX_SAFE_INTEGER, maxBars: Number(el.maxBars.value) || 200 };
}

/** Instrumental leads can be toggled; detected vocals are always omitted. Charts have no MIDI options. */
function applyOptionVisibility(song: Song) {
  const melodyTracks = song.tracks.filter((t) => t.role === 'melody' && !t.vocal);
  const hasMelody = melodyTracks.length > 0;
  const hasTracks = song.tracks.length > 0;
  el.optMelody.hidden = !hasMelody;
  el.optBars.hidden = !hasTracks;
  el.optMelody.closest<HTMLElement>('.opts')!.hidden = !hasTracks;
  if (hasMelody) {
    const lead = leadName(gmLabel(melodyTracks[0].program));
    el.melodyLabel.textContent = `Lead ${lead}`;
    el.optMelody.title = `The instrumental lead line uses ${gmLabel(melodyTracks[0].program)}. It keeps its own instrument; off for the backing alone.`;
  }
  if (hasTracks) fillBarCaps(barRange(song)?.totalBars ?? 0, song.meta);
  // Explain when vocal parts have been excluded.
  el.optNote.hidden = !song.tracks.some(t => t.vocal);
  el.optNoteText.textContent = 'Vocals removed';
  el.optNote.title = 'Detected lead and backing vocal parts are excluded. Instrumental melodies keep their own instruments.';
}

const SOURCE_CHIPS: Record<string, { label: string; title: string; chartOnly?: string }> = {
  midi: { label: 'MIDI notes', title: 'Notes, tempo and instruments come from a MIDI transcription in the Lakh MIDI dataset (clean subset, CC-BY).' },
  mcgill: {
    label: 'Chord chart', title: 'Chords and song structure come from the McGill Billboard annotations, transcribed by musicians.',
    chartOnly: 'Chord accompaniment only: generated piano, bass and drums. This source has no instrumental note transcription and does not reproduce the original arrangement.',
  },
};

// ---------- hero ----------
function renderChips(entry: IndexEntry, song: Song, code: string, key: { tonic?: string; mode?: 'major' | 'minor' }, keyTitle: string) {
  const m = song.meta;
  const chips: string[] = [];
  if (key.tonic) chips.push(`<span class="chip"${keyTitle ? ` title="${esc(keyTitle)}"` : ''}><span class="k">Key</span>${esc(keyName(key.tonic, key.mode ?? 'major'))}</span>`);
  chips.push(`<span class="chip"><span class="k">Tempo</span>${Math.round(m.bpm)} bpm</span>`);
  chips.push(`<span class="chip"><span class="k">Metre</span>${m.beatsPerBar}/${m.beatUnit}</span>`);
  const parts = partList(code);
  const n = parts.length;
  if (n) chips.push(`<span class="chip" title="${esc(`${n} instrument part${n === 1 ? '' : 's'} in the generated code:\n${parts.join('\n')}`)}"><span class="k">Parts</span>${n}</span>`);
  for (const s of entry.sources) {
    const c = SOURCE_CHIPS[s];
    if (c && !song.tracks.length) chips.push('<span class="chip">Generated accompaniment</span>');
    if (c) chips.push(`<span class="chip src ${s}" title="${esc(!song.tracks.length && c.chartOnly ? c.chartOnly : c.title)}"><i aria-hidden="true"></i>${c.label}</span>`);
  }
  el.chips.innerHTML = chips.join('');
}

// ---------- art + tint ----------
/**
 * The hero is tinted with the dominant colour of the cover once it is known, never with a guess first: a colour
 * that changes a second later reads as a glitch. The resolved tint is remembered per song (next to the art cache),
 * so a song opened again is tinted from the first paint; otherwise the art slot holds a neutral shimmer while the
 * lookup runs, and only after `TILE_AFTER_MS` gives way to a letter tile whose colour is its own, not the hero's.
 */
const TILE_AFTER_MS = 800;
/** A lookup still running after this long tints the hero with the tile's colour; a cover found later cross-fades over it. */
const TINT_AFTER_MS = 2500;
const tintKey = (id: string) => `tint:${id}`;
function cachedTint(id: string): string | null { try { return localStorage.getItem(tintKey(id)); } catch { return null; } }
function rememberTint(id: string, tint: string) { try { localStorage.setItem(tintKey(id), tint); } catch { /* quota, private mode */ } }
let tileTimer: number | undefined;
let tintTimer: number | undefined;

function applyTint(tint: string) {
  el.song.style.setProperty('--tint', tint);
  el.song.classList.add('tinted');
}
function showTile() {
  clearTimeout(tileTimer);
  el.song.classList.remove('art-pending');
  el.artFallback.hidden = false;
}

function showSkeleton(entry: IndexEntry) {
  showSection('song');
  hideBanner();
  el.song.classList.add('loading');
  const tint = cachedTint(entry.id);
  if (tint) applyTint(tint); else el.song.classList.remove('tinted');
  setTitle(entry.title);
  el.artist.textContent = displayArtist(entry.artist);
  el.album.textContent = entry.year ? String(entry.year) : '';
  el.optNote.hidden = true;
  // Only MIDI songs get options, so only they get the placeholder row (a chord chart has no row to wait for).
  el.optsSkel.hidden = !entry.sources.includes('midi');
  el.chips.innerHTML = '<span class="chip skel">·</span>'.repeat(4);
  clearTimeline();
  clearCode();
  el.art.hidden = true;
  el.art.removeAttribute('src');
  el.artFallback.hidden = true;
  el.artFallback.textContent = initial(entry.title);
  el.artFallback.style.setProperty('--tile', songTint(entry));
  el.song.classList.add('art-pending');
  clearTimeout(tileTimer);
  clearTimeout(tintTimer);
  tileTimer = window.setTimeout(showTile, TILE_AFTER_MS);
  if (!tint) tintTimer = window.setTimeout(() => applyTint(songTint(entry)), TINT_AFTER_MS);
}

/** Dominant vivid colour of an image, or null when it cannot be read (CORS, decode error, greyscale). */
function dominantColor(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onerror = () => resolve(null);
    im.onload = () => {
      try {
        const N = 32;
        const c = document.createElement('canvas');
        c.width = N; c.height = N;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        if (!ctx) return resolve(null);
        ctx.drawImage(im, 0, 0, N, N);
        resolve(dominantHsl(ctx.getImageData(0, 0, N, N).data));
      } catch { resolve(null); }
    };
    im.src = url;
  });
}

/** The tint for a song: the cover's dominant colour, or (no cover, unreadable cover) the tile colour of its title. */
async function tintFor(entry: IndexEntry, art: string | undefined): Promise<string> {
  return (art && (await dominantColor(art))) || songTint(entry);
}
const hasCover = (info: { art?: string; kind?: string }) => !!info.art && info.kind !== 'placeholder';

async function renderArt(entry: IndexEntry) {
  const info = await lookupArt(entry.id, displayArtist(entry.artist), entry.title, { year: entry.year });
  if (state.current?.entry.id !== entry.id) return;
  clearTimeout(tintTimer);
  el.album.textContent = albumLine(info, entry);
  if (!hasCover(info)) {
    showTile();
    const tint = songTint(entry);
    applyTint(tint);
    rememberTint(entry.id, tint);
    return;
  }
  el.art.alt = `${entry.title} cover art`;
  el.art.onload = () => {
    if (state.current?.entry.id !== entry.id) return;
    clearTimeout(tileTimer);
    el.song.classList.remove('art-pending');
    el.art.hidden = false;
    el.artFallback.hidden = true;
  };
  el.art.onerror = () => { if (state.current?.entry.id === entry.id) showTile(); };
  el.art.src = info.art!;
  const tint = await tintFor(entry, info.art);
  if (state.current?.entry.id !== entry.id) return;
  applyTint(tint);
  rememberTint(entry.id, tint);
}

/**
 * Warm the art and tint caches for a song the user is about to open (a hovered result or example card), so
 * the hero paints finished on the first frame. Never cancels the current song's own lookup.
 */
const prefetched = new Set<string>();
export async function prefetchArt(entry: IndexEntry) {
  if (prefetched.has(entry.id) || cachedTint(entry.id)) return;
  prefetched.add(entry.id);
  const info = await lookupArt(entry.id, displayArtist(entry.artist), entry.title, { year: entry.year, supersede: false, budget: 4000 });
  if (!info.art) { prefetched.delete(entry.id); return; } // superseded or aborted: try again next time
  if (state.current?.entry.id === entry.id || cachedTint(entry.id)) return;
  rememberTint(entry.id, await tintFor(entry, hasCover(info) ? info.art : undefined));
}

// ---------- open ----------
/**
 * Open a song. Picking one from search or a link pushes a history entry, so Back returns to the previous
 * song or the landing page; opening from the hash (boot, Back/Forward) leaves history alone.
 */
export async function choose(entry: IndexEntry) {
  if (state.loadingId === entry.id) return;
  state.loadingId = entry.id;
  // The previous song is gone from the state before anything is repainted: every renderer (timeline, readout,
  // resize observer, animation tick) reads `state.current`, so nothing can draw the old lanes under the new title.
  state.current = null;
  closeSearch(); // whichever way a song is opened (result, example card, link), a stale query does not linger in the box
  setStatus('Analysing…');
  // Include instrumental leads by default for each newly opened song.
  el.melody.checked = true;
  showSkeleton(entry); // synchronously, before the (async) hard stop: the page shows the new song at once
  const artist = displayArtist(entry.artist);
  document.title = `${entry.title} — ${artist} · Strudelify`;
  const hash = `#${encodeURIComponent(entry.id)}`;
  if (location.hash !== hash) history.pushState(null, '', hash);
  rememberRecent(entry.id);
  window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  await stop(true);
  state.pausedBar = 0;
  try {
    const [song] = await Promise.all([loadSong(entry, readFile), loadRepl()]);
    if (state.loadingId !== entry.id) return;
    state.current = { entry, song, tl: timeline(song, options()), code: '', flats: false, chordSource: 'detected' };
    el.song.classList.remove('loading');
    el.optsSkel.hidden = true;
    applyOptionVisibility(song);
    recompile();
    setStatus('');
    // Chosen from the search box: focus moves on to Play (Space then plays) instead of being dropped on <body>.
    if (document.activeElement === el.q) el.play.focus({ preventScroll: true });
    renderArt(entry);
  } catch (e) {
    if (state.loadingId !== entry.id) return;
    el.song.classList.remove('loading');
    el.optsSkel.hidden = true;
    setStatus('');
    showBanner(`Could not load “${entry.title}”: ${(e as Error).message}`, () => { state.loadingId = null; choose(entry); });
    toast(`Could not load ${entry.title}`, 'error');
  }
}

/** Compile with the current options and refresh code, chips, timeline and counters (re-evaluates while playing). */
export function recompile() {
  const cur = state.current;
  if (!cur) return;
  const opts = options();
  const { song } = cur;
  cur.code = compile(song, opts);
  const playable = !cur.code.trimEnd().endsWith('\nsilence');
  el.play.disabled = !playable;
  hideBanner();
  if (!playable) {
    void stop();
    showBanner('No separate instrumental parts remain in this transcription with the current options.');
  }
  cur.tl = timeline(song, opts);
  cur.chordSource = song.tracks.length ? 'detected' : 'chart';
  let key: { tonic?: string; mode?: 'major' | 'minor' } = { tonic: song.meta.tonic, mode: song.meta.mode };
  let keyTitle = '';
  if (song.tracks.length && song.structure?.length) {
    // MIDI provides the notes, McGill the chart: lay the annotated sections and chords on the rendered bar grid
    // so the lane, the readout and the code's `// chords:` line agree. When the two transcriptions are different
    // cuts of the song the chart cannot be laid out, and the lane keeps the chords read from the notes.
    const songBars = barRange(song)?.totalBars;
    const chart = structureChords(song.structure, cur.tl.bars, song.meta.beatsPerBar, songBars);
    if (chart) { cur.tl.chords = chart; cur.chordSource = 'chart'; } else cur.chordSource = 'mismatch';
    if (!cur.tl.sections.length) cur.tl.sections = structureSections(song.structure, cur.tl.bars, songBars);
  }
  // No annotated structure: the form read from the chords, when it is clear enough to be worth showing.
  if (!cur.tl.sections.length) cur.tl.sections = deriveForm(cur.tl.chords, cur.tl.bars);
  el.posSrc.hidden = cur.chordSource !== 'mismatch';
  if (cur.chordSource === 'mismatch') {
    // What plays is the MIDI, so every fact shown follows the MIDI: the chords line lists the chords read from the
    // notes (the compiler prints the chart) and the key is estimated from the notes, since the chart's key may be
    // that of another cut of the record (In-A-Gadda-Da-Vida: the chart says D minor, the transcription is in D♭).
    const chartBars = song.structure?.reduce((n, s) => n + s.bars, 0) ?? 0;
    const midiBars = barRange(song)?.totalBars ?? cur.tl.bars;
    const why = `McGill's chord chart of this song is a different cut (${chartBars} bars against ${midiBars} in the MIDI), so it cannot be laid on these bars`;
    el.posSrc.title = `Chords read from the MIDI notes bar by bar. ${why}.`;
    cur.code = replaceChordLine(cur.code, chordSummary(song.sections), [`chords read from the MIDI notes; ${why}`]);
    // The chart's key still says major/minor; its tonic is moved by the interval between the chart and the notes
    // (a transcription a semitone low plays in C♯ minor, not D minor). Without a chart key the notes are asked directly.
    const shift = chartShift(song.structure ?? [], song.sections);
    const shifted = shiftTonic(song.meta.tonic, shift);
    const estimated = shifted ? { tonic: shifted, mode: song.meta.mode } : midiKey(song.tracks);
    if (estimated && (estimated.tonic !== song.meta.tonic || estimated.mode !== song.meta.mode)) {
      key = estimated;
      keyTitle = `Key of the MIDI notes, which play ${Math.abs(shift)} semitone${Math.abs(shift) === 1 ? '' : 's'} ${shift < 0 ? 'below' : 'above'} the chord chart (${keyName(song.meta.tonic!, song.meta.mode ?? 'major')}).`;
    }
  }
  cur.flats = prefersFlats(key.tonic, key.mode);
  // The code the user copies spells its chords and key exactly as the readout and the lane do (comments only).
  cur.code = respellKeyLine(respellChordLine(cur.code, cur.flats), key.tonic, key.mode);
  showCode(cur.code, cur.entry.id);
  renderChips(cur.entry, song, cur.code, key, keyTitle);
  renderTimeline();
  el.totalTime.textContent = fmt(cur.tl.bars * cur.tl.secondsPerBar);
  el.track.setAttribute('aria-valuemax', String(Math.max(0, cur.tl.bars - 1)));
  state.pausedBar = Math.min(state.pausedBar, Math.max(0, cur.tl.bars - 1));
  updatePosition(state.started ? 0 : state.pausedBar, true);
  if (state.started) play(); // re-evaluate with the new code
}
for (const input of [el.melody, el.maxBars, el.codeStyle]) input.addEventListener('change', recompile);
