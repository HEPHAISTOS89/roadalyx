import { describe, expect, it } from 'vitest';
import { tickIndices } from '../src/lib/chartTicks';
import type { Bucket } from '../src/lib/types';
const monthly = Array.from({ length: 82 }, (_, i) => ({ key: `${2020 + Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}` } as Bucket));
describe('time axis ticks', () => {
  it('shows multiple year boundaries on a narrow monthly chart, including the last year', () => {
    const ticks = [...tickIndices(monthly, 'month', 300)];
    expect(ticks.length).toBe(4);
    expect(ticks[0]).toBe(0);
    expect(ticks.at(-1)).toBe(72);
    expect(ticks.every((i) => String(monthly[i].key).endsWith('-01'))).toBe(true);
  });
  it('preserves all yearly ticks when they fit and handles empty series', () => {
    expect([...tickIndices(monthly.slice(0, 7), 'year', 600)]).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect([...tickIndices([], 'month', 390)]).toEqual([]);
  });
  it('labels a partial first year even when the series starts after January', () => {
    expect([...tickIndices(monthly.slice(5), 'month', 300)][0]).toBe(0);
  });
});
