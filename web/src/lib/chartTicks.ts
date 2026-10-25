// Which x-axis labels the trend chart can afford at its current width (about one per 64 px).
import type { Bucket } from './types';

/** Decimate year boundaries, not arbitrary months: always preserve the first and last year. */
export function tickIndices(buckets: Bucket[], by: string, width: number): Set<number> {
  const candidates = buckets.flatMap((b, i) => by !== 'month' || i === 0 || String(b.key).endsWith('-01') ? [i] : []);
  const capacity = Math.max(2, Math.floor(width / 64));
  if (candidates.length <= capacity) return new Set(candidates);
  return new Set(Array.from({ length: capacity }, (_, i) => candidates[Math.round(i * (candidates.length - 1) / (capacity - 1))]));
}
