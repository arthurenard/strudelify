import { it, expect } from 'vitest';
import fs from 'node:fs';
import { ACOUSTIC_DRUMS } from '../src/acoustic-drums.js';
const bank = JSON.parse(fs.readFileSync(new URL('./fixtures/acoustic-drums.json', import.meta.url), 'utf8'));
it('maps reviewed drums to actual recorded hits, not rolls or bowed samples', () => {
  for (const drum of Object.values(ACOUSTIC_DRUMS)) {
    const path = bank[drum.sample][drum.index];
    expect(path).toBeTypeOf('string');
    expect(path).not.toMatch(/roll|bow|cresc|scrape/i);
    expect(path).toMatch(/hit|xstick|close/i);
    expect(drum.gain).toBeGreaterThan(0);
  }
});
