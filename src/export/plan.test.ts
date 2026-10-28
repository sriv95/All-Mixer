import { describe, expect, it } from 'vitest';
import { EXPORT_SAMPLE_RATE, MAX_CHUNK_S } from '../shared/export';
import { chunkAt, planChunks } from './plan';

describe('planChunks', () => {
  it('cuts equal chunks that are never longer than the maximum', () => {
    for (const d of [0.5, 14.9, 15, 15.01, 30, 200, 215.3, 3601]) {
      const p = planChunks(d);
      expect(p.seconds).toBeLessThanOrEqual(MAX_CHUNK_S);
      expect(p.samples * p.count).toBeGreaterThanOrEqual(p.total);
      expect(p.samples * (p.count - 1)).toBeLessThan(p.total);
    }
  });

  it('200 s is 14 chunks of 14.3 s, a short video is one chunk', () => {
    const p = planChunks(200);
    expect(p.count).toBe(14);
    expect(p.seconds).toBeCloseTo(14.29, 2);
    expect(planChunks(9).count).toBe(1);
    expect(planChunks(15).count).toBe(1);
    expect(planChunks(15).total).toBe(15 * EXPORT_SAMPLE_RATE);
  });

  it('chunkAt is 1-based and stops at the last chunk', () => {
    const p = planChunks(40);
    expect(chunkAt(p, 0)).toBe(1);
    expect(chunkAt(p, p.samples)).toBe(2);
    expect(chunkAt(p, p.total * 2)).toBe(p.count);
  });
});
