import { describe, it, expect } from 'vitest';
import { fitGrid } from '../src/grid.js';

const grids = [16, 24, 32, 48];
describe('fitGrid', () => {
  it('finds sixteenths for notes on the beat, with no shift', () => {
    expect(fitGrid(Array.from({ length: 32 }, (_, i) => i * 0.5), 4, 120, grids, 32, 0.9, 0.035)).toEqual({ grid: 16, shift: 0 });
  });
  it('shifts the grid by a transcription\'s common lateness, which would otherwise need a finer grid', () => {
    // Every note 40 ms late at 110 bpm (0.073 beats): more than the 35 ms a sixteenth grid allows.
    const late = 0.04 * 110 / 60;
    const { grid, shift } = fitGrid(Array.from({ length: 32 }, (_, i) => i * 0.5 + late), 4, 110, grids, 32, 0.9, 0.035);
    expect(grid).toBe(16);
    expect(shift).toBeCloseTo(late, 6);
  });
  it('reads swing as triplets, not as an offset', () => {
    const swung = Array.from({ length: 16 }, (_, i) => Math.floor(i / 2) + (i % 2 ? 2 / 3 : 0));
    expect(fitGrid(swung, 4, 120, grids, 32, 0.9, 0.035)).toEqual({ grid: 24, shift: 0 });
  });
  it('never shifts by more than 60 ms: further off the beat is a feel or another rhythm', () => {
    expect(fitGrid(Array.from({ length: 16 }, (_, i) => i + 0.09), 4, 60, [16], 48, 0.9, 0.035)).toEqual({ grid: 48, shift: 0 });
  });
  it('shifts a grid the notes fit anyway when more of them then land on it', () => {
    // 30 ms late: sixteenths fit as they are (35 ms allowed), but a note a few ms later would round away from the rest.
    const late = 0.03 * 2, onsets = Array.from({ length: 32 }, (_, i) => i * 0.5 + late + (i % 8 === 3 ? 0.02 : 0));
    const { grid, shift } = fitGrid(onsets, 4, 120, grids, 32, 0.9, 0.035);
    expect(grid).toBe(16);
    expect(shift).toBeGreaterThan(0.05);
  });
});
