import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MAX_BARS, DEFAULT_MAX_TRACKS, DEFAULT_MELODY_SOUND } from '../../core/src/strudel.js';

const src = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/main.ts'), 'utf8');

describe('CLI defaults', () => {
  it('takes its compile defaults from core instead of hard-coding them', () => {
    expect(src).toMatch(/'--max-tracks <n>'[^\n]*String\(DEFAULT_MAX_TRACKS\)/);
    expect(src).toMatch(/'--max-bars <n>'[^\n]*String\(DEFAULT_MAX_BARS\)/);
    expect(src).toMatch(/'--melody-sound <name>'[^\n]*DEFAULT_MELODY_SOUND/);
    expect(src).not.toMatch(/'--max-tracks <n>'[^\n]*'\d+'/);
    expect([DEFAULT_MAX_TRACKS, DEFAULT_MAX_BARS, DEFAULT_MELODY_SOUND]).toEqual([12, 200, 'gm_lead_2_sawtooth']);
  });
});
