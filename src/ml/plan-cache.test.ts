import { describe, expect, it } from 'vitest';
import { SPEED_TTL_MS, lookupSpeed, rememberSpeed, speedKey } from './plan-cache';

const key = speedKey({ model: 'roformer', modelVersion: 2, appVersion: '0.3.0', adapter: 'apple metal-3' });

describe('speed cache', () => {
  it('finds what was remembered, until it is old', () => {
    const c = rememberSpeed(undefined, key, 790, 1000);
    expect(lookupSpeed(c, key, 2000)).toBe(790);
    expect(lookupSpeed(c, key, 1000 + SPEED_TTL_MS)).toBeNull();
  });

  it('another GPU, model version or app version is a different key', () => {
    const c = rememberSpeed(undefined, key, 790);
    for (const other of [{ adapter: 'nvidia' }, { modelVersion: 3 }, { appVersion: '0.4.0' }, { model: 'deux' }]) {
      expect(lookupSpeed(c, speedKey({ model: 'roformer', modelVersion: 2, appVersion: '0.3.0', adapter: 'apple metal-3', ...other }))).toBeNull();
    }
  });

  it('ignores junk: no cache, a missing key, a non-positive or non-finite speed, a time in the future', () => {
    expect(lookupSpeed(undefined, key)).toBeNull();
    expect(lookupSpeed({}, key)).toBeNull();
    expect(lookupSpeed({ [key]: { baseMs: 0, at: 1 } }, key, 2)).toBeNull();
    expect(lookupSpeed({ [key]: { baseMs: NaN, at: 1 } }, key, 2)).toBeNull();
    expect(lookupSpeed({ [key]: { baseMs: 800, at: 10 } }, key, 5)).toBeNull();
  });

  it('keeps the newest few entries', () => {
    let c = rememberSpeed(undefined, 'k0', 1, 0);
    for (let i = 1; i <= 10; i++) c = rememberSpeed(c, `k${i}`, 1, i);
    expect(Object.keys(c)).toHaveLength(8);
    expect(c.k0).toBeUndefined();
    expect(c.k10).toBeDefined();
  });

  it('does not change the cache it was given', () => {
    const c = rememberSpeed(undefined, key, 790, 1);
    rememberSpeed(c, 'x', 1, 2);
    expect(Object.keys(c)).toEqual([key]);
  });
});
