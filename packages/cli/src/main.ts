#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { Command, InvalidArgumentError } from 'commander';
import { createIndex, loadSong, compile, shareUrl, MAX_SHARE_URL, DEFAULT_MAX_BARS, DEFAULT_MAX_TRACKS, type IndexEntry, type CompileOptions } from '@strudelify/core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = process.env.STRUDELIFY_DB ?? path.resolve(HERE, '..', '..', 'data', 'public', 'db');

function openIndex(db: string) {
  const file = path.join(db, 'index.json');
  if (!fs.existsSync(file)) {
    console.error(`No database at ${db}. Run \`npm run data\` first (or set STRUDELIFY_DB).`);
    process.exit(2);
  }
  const entries: IndexEntry[] = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { entries, index: createIndex(entries), read: async (p: string) => new Uint8Array(fs.readFileSync(path.join(db, p))) };
}

function describe(e: IndexEntry): string {
  const bits = [e.year, e.key, e.bpm ? `${e.bpm} bpm` : undefined, e.sources.join('+')].filter(Boolean);
  return `${e.title} — ${e.artist}  (${bits.join(', ')})`;
}

/** Commander parser for a count option: a whole number of at least 1, or a usage error naming the option. */
function positiveInt(value: string): number {
  const n = Number(value);
  if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(n) || n < 1) throw new InvalidArgumentError('Expected a whole number of at least 1.');
  return n;
}

/**
 * The command that opens a URL in the default browser, and the longest URL it can be given: one
 * argument of at most 128 KiB on Linux, a command line of 32,767 characters on Windows (`rundll32`
 * runs no shell, so the `%` of an encoded link is not expanded), about 1 MiB of arguments on macOS.
 */
function opener(url: string): { file: string; args: string[]; limit: number } {
  if (process.platform === 'darwin') return { file: 'open', args: [url], limit: 1_000_000 };
  if (process.platform === 'win32') return { file: 'rundll32', args: ['url.dll,FileProtocolHandler', url], limit: 32_000 };
  return { file: 'xdg-open', args: [url], limit: 128 * 1024 - 1 };
}

const program = new Command();
program.name('strudelify').description('Turn a song name into Strudel live-coding code.').version('0.1.0');
program.option('--db <dir>', 'database directory', DEFAULT_DB);

program
  .command('search')
  .argument('<query...>', 'song title and/or artist')
  .option('-n, --limit <n>', 'number of results', positiveInt, 10)
  .description('list matching songs without compiling')
  .action((query: string[], o: { limit: number }) => {
    const { index } = openIndex(program.opts().db);
    const hits = index.search(query.join(' '), o.limit);
    if (!hits.length) { console.error('No matches.'); process.exit(1); }
    for (const h of hits) console.log(`${h.id}\t${describe(h)}`);
  });

program
  .command('compile', { isDefault: true })
  .argument('<query...>', 'song title and/or artist, or an exact id from `search`')
  .option('-o, --out <file>', 'write the code (or the --json model) to a file instead of stdout')
  .option('-u, --url', 'print a strudel.cc share link')
  .option('--open', 'open the song in strudel.cc')
  .option('--no-melody', 'also leave out instrumental lead melodies (vocals are always removed)')
  // Defaults come from core so the CLI, the web app and `compile()` agree.
  .option('--max-bars <n>', 'cap on bars rendered (counted in 4/4 bars)', positiveInt, DEFAULT_MAX_BARS)
  .option('--max-tracks <n>', 'cap on pitched tracks rendered', positiveInt, DEFAULT_MAX_TRACKS)
  .option('--full-song', 'render the full-song form (respects --max-bars) instead of a main loop')
  .option('--source-detail', 'emit unrounded MIDI events instead of reusable live-coding riffs')
  .option('--json', 'dump the analysed song model instead of code')
  .description('compile a song to Strudel code')
  .action(async (query: string[], o: { out?: string; url?: boolean; open?: boolean; melody: boolean; maxBars: number; maxTracks: number; json?: boolean; sourceDetail?: boolean; fullSong?: boolean }) => {
    const { entries, index, read } = openIndex(program.opts().db);
    const q = query.join(' ');
    let entry = entries.find((e) => e.id === q);
    if (!entry) {
      // The index decides: an exact title shared by several artists is ambiguous unless
      // one candidate is clearly the original (popularity margin); an artist name alone is
      // a catalogue; words inside a title only count when they explain nearly all of the
      // query and at least half of the title, so a song that is not in the database is
      // never silently replaced by one that shares a word with it.
      const r = index.resolve(q, 6);
      if (r.kind === 'none') { console.error(`No song matches "${q}".`); process.exit(1); }
      if (r.kind === 'ambiguous') {
        const best = r.hits[0].match;
        const whole = best.title === 'exact' || best.title === 'fuzzy' || best.title === 'prefix' || best.artist !== 'none';
        console.error(whole ? `"${q}" is ambiguous. Did you mean:` : `No song is titled "${q}". The nearest matches are:`);
        for (const h of r.hits) console.error(`  ${h.id}\t${describe(h)}`);
        // "Add the artist name" only helps when the query does not name one already.
        const named = r.hits.some((h) => h.match.artist === 'exact');
        console.error(named ? 'Re-run with the exact id.' : 'Re-run with the exact id, or add the artist name.');
        process.exit(1);
      }
      entry = r.entry;
    }
    const song = await loadSong(entry, read);
    const write = (text: string) => {
      if (!o.out) return false;
      fs.writeFileSync(o.out, text.endsWith('\n') ? text : `${text}\n`);
      console.error(`wrote ${o.out}`);
      return true;
    };
    if (o.json) { if (!write(JSON.stringify(song, null, 2))) console.log(JSON.stringify(song, null, 2)); return; }
    const opts: CompileOptions = { form: o.fullSong || o.sourceDetail ? 'song' : 'loop', timing: o.sourceDetail ? 'source' : 'patterns', melody: o.melody, maxBars: o.maxBars, maxTracks: o.maxTracks };
    const code = compile(song, opts);
    console.error(`# ${describe(entry)}`);
    if (!write(code) && !o.url && !o.open) console.log(code);
    if (!o.url && !o.open) return;
    const url = shareUrl(code);
    if (o.url) {
      console.log(url);
      if (url.length > MAX_SHARE_URL) console.error(`warning: this link is ${url.length.toLocaleString('en')} characters, more than a browser opens; use -o and paste the code into strudel.cc instead.`);
    }
    if (o.open) {
      const { file, args, limit } = opener(url);
      const fail = (why: string) => {
        console.error(`Could not open strudel.cc: ${why}. ${o.url ? 'Open the link above yourself' : o.out ? `Paste ${o.out} into strudel.cc instead` : 'Re-run with --url or -o <file>'}.`);
        process.exitCode = 1;
      };
      if (url.length > Math.min(limit, MAX_SHARE_URL)) fail(`the link is ${url.length.toLocaleString('en')} characters, more than ${file} or a browser accepts`);
      else execFile(file, args, (error) => { if (error) fail(error.message); });
    }
  });

program.parseAsync(process.argv);
