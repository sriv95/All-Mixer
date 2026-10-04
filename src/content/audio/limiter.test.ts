import { describe, expect, it } from 'vitest';
import { LIMITER, makeupTrim, softClip, softClipCurve } from './limiter';

describe('softClip', () => {
  it('is transparent below the knee', () => {
    expect(softClip(0.5)).toBe(0.5);
    expect(softClip(-0.8)).toBe(-0.8);
  });
  it('never reaches full scale, even for 6× overs', () => {
    for (const x of [0.9, 1, 2, 6, 100]) {
      expect(softClip(x)).toBeLessThan(1);
      expect(softClip(-x)).toBeGreaterThan(-1);
    }
  });
  it('is monotonic and continuous at the knee', () => {
    let prev = -Infinity;
    for (let x = -3; x <= 3; x += 0.001) {
      const y = softClip(x);
      expect(y).toBeGreaterThanOrEqual(prev);
      prev = y;
    }
    expect(softClip(LIMITER.clipKnee + 1e-6)).toBeCloseTo(LIMITER.clipKnee, 5);
  });
});

describe('softClipCurve', () => {
  it('spans [-1, 1] and stays inside full scale', () => {
    const c = softClipCurve(1025);
    expect(c[512]).toBeCloseTo(0, 6);
    expect(Math.max(...c)).toBeLessThan(1);
    expect(Math.min(...c)).toBeGreaterThan(-1);
  });
});

describe('makeupTrim', () => {
  it('cancels the spec makeup gain', () => {
    const t = -1.5;
    const r = 20;
    const curveAt0Db = 10 ** ((t - t / r) / 20);
    const makeup = (1 / curveAt0Db) ** 0.6;
    expect(makeupTrim(t, r) * makeup).toBeCloseTo(1, 10);
    expect(makeupTrim(t, r)).toBeLessThan(1);
  });
});
