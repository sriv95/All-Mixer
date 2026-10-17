import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, clampPct, masterGainFor, normalizeSettings, separationFor } from './settings';

describe('clampPct', () => {
  it('clamps to 0–600 and rounds', () => {
    expect(clampPct(-5)).toBe(0);
    expect(clampPct(601)).toBe(600);
    expect(clampPct(250.6)).toBe(251);
    expect(clampPct('300')).toBe(300);
  });
  it('falls back on junk', () => {
    expect(clampPct(NaN)).toBe(100);
    expect(clampPct('abc', 42)).toBe(42);
    expect(clampPct(undefined)).toBe(100);
  });
});

describe('normalizeSettings', () => {
  it('returns defaults for non-objects', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings('x')).toEqual(DEFAULT_SETTINGS);
  });
  it('keeps valid values and fixes invalid ones', () => {
    expect(normalizeSettings({ mode: 'separate', masterPct: 900, vocalPct: 0, instrumentalPct: 'x' })).toEqual({
      mode: 'separate',
      masterPct: 600,
      vocalPct: 0,
      instrumentalPct: 100,
      mlModel: 'mdx',
    });
    expect(normalizeSettings({ mode: 'weird' }).mode).toBe('default');
  });
  it('keeps a known ML model and falls back to mdx otherwise', () => {
    expect(normalizeSettings({ mlModel: 'roformer' }).mlModel).toBe('roformer');
    expect(normalizeSettings({ mlModel: 'mdx' }).mlModel).toBe('mdx');
    expect(normalizeSettings({ mlModel: 'nope' }).mlModel).toBe('mdx');
    expect(normalizeSettings({ mlModel: 3 }).mlModel).toBe('mdx');
  });
  it.each(['light', 'auto', 'quality', 'ultra', 3])('drops a stored separationQuality (%s) from older versions', (q) => {
    const out = normalizeSettings({ mode: 'separate', masterPct: 200, separationQuality: q });
    expect(out).toEqual({ mode: 'separate', masterPct: 200, vocalPct: 100, instrumentalPct: 100, mlModel: 'mdx' });
    expect('separationQuality' in out).toBe(false);
    expect('separationQuality' in DEFAULT_SETTINGS).toBe(false);
  });
});

describe('masterGainFor', () => {
  it('maps percent to linear gain in default mode', () => {
    expect(masterGainFor({ ...DEFAULT_SETTINGS, masterPct: 600 })).toBe(6);
    expect(masterGainFor({ ...DEFAULT_SETTINGS, masterPct: 0 })).toBe(0);
  });
  it('is unity in separate mode until separation ships', () => {
    expect(masterGainFor({ ...DEFAULT_SETTINGS, mode: 'separate', masterPct: 600 })).toBe(1);
  });
});

describe('separationFor', () => {
  it('is off in Default mode and maps percent to linear gain in Separate mode', () => {
    expect(separationFor(DEFAULT_SETTINGS).on).toBe(false);
    expect(separationFor({ ...DEFAULT_SETTINGS, mode: 'separate', vocalPct: 0, instrumentalPct: 600 })).toEqual({
      on: true,
      vocal: 0,
      instrumental: 6,
    });
  });
});
