/** The `strudelify` command end to end, against a small database built from the curated sources. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const MAIN = path.join(ROOT, 'packages/cli/src/main.ts');
let dir = '';

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strudelify-cli-'));
  fs.mkdirSync(path.join(dir, 'songs'));
  fs.copyFileSync(path.join(ROOT, 'packages/data/curated/love-me-do.mid'), path.join(dir, 'songs/love-me-do.mid'));
  const entries = [
    { id: 'the-beatles--love-me-do', title: 'Love Me Do', artist: 'The Beatles', sources: ['midi'], popularity: 3, files: { midi: 'songs/love-me-do.mid' } },
    // Two recordings of one title at the same popularity: ambiguous without the artist.
    { id: 'artist-one--yesterday', title: 'Yesterday', artist: 'Artist One', sources: ['midi'], popularity: 1, files: { midi: 'songs/missing.mid' } },
    { id: 'artist-two--yesterday', title: 'Yesterday', artist: 'Artist Two', sources: ['midi'], popularity: 1, files: { midi: 'songs/missing.mid' } },
  ];
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(entries));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function cli(args: string[], env: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', MAIN, '--db', dir, ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('strudelify CLI', () => {
  it('compiles a song found by name to Strudel code on stdout', () => {
    const r = cli(['love', 'me', 'do']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('setcpm(');
    expect(r.err).toContain('Love Me Do — The Beatles');
  });
  it('lists search results and takes its defaults from core', () => {
    const r = cli(['search', 'love']);
    expect([r.code, r.out.split('\t')[0]]).toEqual([0, 'the-beatles--love-me-do']);
    const help = cli(['compile', '--help']).out;
    expect(help).toMatch(/--max-bars <n>[\s\S]*\(default: 200\)/);
    expect(help).toMatch(/--max-tracks <n>[\s\S]*\(default: 12\)/);
  });
  it('rejects counts that are not whole numbers of at least 1', () => {
    for (const args of [['--max-bars', 'abc', 'love me do'], ['--max-tracks', '0', 'love me do'], ['search', '-n', '-3', 'love'], ['search', '-n', '2.5', 'love']]) {
      const r = cli(args);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/Expected a whole number of at least 1/);
      expect(r.out).toBe('');
    }
  });
  it('exits 1 with the candidates when the query is ambiguous or unknown', () => {
    const ambiguous = cli(['yesterday']);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.err).toContain('artist-one--yesterday');
    expect(ambiguous.err).toContain('artist-two--yesterday');
    const unknown = cli(['zzzz qqqq']);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toMatch(/No song/);
  });
  it('writes the code, or the --json song model, to the -o file', () => {
    const code = path.join(dir, 'love.js'), model = path.join(dir, 'love.json');
    const r = cli(['love me do', '-o', code]);
    expect([r.code, r.out]).toEqual([0, '']);
    expect(fs.readFileSync(code, 'utf8')).toContain('setcpm(');
    const j = cli(['love me do', '--json', '-o', model]);
    expect([j.code, j.out]).toEqual([0, '']);
    expect(JSON.parse(fs.readFileSync(model, 'utf8')).meta.title).toBe('Love Me Do');
  });
  it('says so and exits 1 when no browser can be opened', () => {
    const r = cli(['love me do', '--open', '--url'], { PATH: path.join(dir, 'nothing-here') });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^https:\/\/strudel\.cc\/#/);
    expect(r.err).toMatch(/Could not open strudel\.cc: .*Open the link above yourself/);
  });
});
