import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, PITCH_MAX, clampDelayS, clampPct, effectsFor, masterGainFor, mlDelayMsFor, normalizeSettings, separationFor } from './settings';

describe('clampPct', () => {
  it('clamps to 0–100 and rounds', () => {
    expect(clampPct(-5)).toBe(0);
    expect(clampPct(101)).toBe(100);
    expect(clampPct(25.6)).toBe(26);
    expect(clampPct('30')).toBe(30);
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
      splitInstrumental: false,
      splitGuitar: false,
      drumsPct: 100,
      guitarPct: 100,
      bassPct: 100,
      pianoPct: 100,
      othersPct: 100,
      mlDelayS: 2,
      gpu: 'auto',
      pitch: 0,
      pitchSplit: false,
      vocalPitch: 0,
      instrPitch: 0,
      reverbMix: 0,
      eqLow: 0,
      eqMid: 0,
      eqHigh: 0,
      preload: false,
    });
    expect(normalizeSettings({ mode: 'weird' }).mode).toBe('default');
  });
  it('keeps the guitar split switch and level valid', () => {
    expect(normalizeSettings({ splitGuitar: true }).splitGuitar).toBe(true);
    expect(normalizeSettings({ splitGuitar: 'yes' }).splitGuitar).toBe(false);
    expect(normalizeSettings({ guitarPct: 40 }).guitarPct).toBe(40);
    expect(normalizeSettings({ guitarPct: 400 }).guitarPct).toBe(100);
  });
  it('keeps the bass and piano levels valid, and the all-stems model as a known model', () => {
    expect(normalizeSettings({ bassPct: 30, pianoPct: 70 })).toMatchObject({ bassPct: 30, pianoPct: 70 });
    expect(normalizeSettings({ bassPct: 400, pianoPct: 'x' })).toMatchObject({ bassPct: 100, pianoPct: 100 });
    expect(normalizeSettings({ mlModel: 'sw' }).mlModel).toBe('sw');
  });
  it('keeps a known GPU preference and falls back to auto otherwise', () => {
    for (const g of ['auto', 'high-performance', 'low-power']) expect(normalizeSettings({ gpu: g }).gpu).toBe(g);
    expect(normalizeSettings({ gpu: 'nvidia' }).gpu).toBe('auto');
  });
  it('keeps a known ML model and falls back to mdx otherwise', () => {
    expect(normalizeSettings({ mlModel: 'roformer' }).mlModel).toBe('kim2'); // the dropped High quality id follows Kim Vocal 2
    for (const m of ['kim2', 'deux']) expect(normalizeSettings({ mlModel: m }).mlModel).toBe(m);
    expect(normalizeSettings({ mlModel: 'kim' }).mlModel).toBe('mdx');
    expect(normalizeSettings({ mlModel: 'mdx' }).mlModel).toBe('mdx');
    expect(normalizeSettings({ mlModel: 'nope' }).mlModel).toBe('mdx');
    expect(normalizeSettings({ mlModel: 3 }).mlModel).toBe('mdx');
  });
  it('keeps the stored delay limit between 2 and 10 s (default 2) and converts it to ms', () => {
    expect(normalizeSettings({ mlDelayS: 9 }).mlDelayS).toBe(9);
    expect(normalizeSettings({ mlDelayS: '7' }).mlDelayS).toBe(7);
    expect(normalizeSettings({ mlDelayS: 1 }).mlDelayS).toBe(2);
    expect(normalizeSettings({ mlDelayS: 99 }).mlDelayS).toBe(10);
    expect(normalizeSettings({ mlDelayS: 'x' }).mlDelayS).toBe(2);
    expect(normalizeSettings({}).mlDelayS).toBe(2);
    expect('mlAuto' in normalizeSettings({ mlAuto: true })).toBe(false); // the removed Auto setting is dropped
    expect(mlDelayMsFor(normalizeSettings({ mlDelayS: 6, mlModel: 'kim2' }))).toBe(6000);
  });
  it('the delay limit in use is the stored value within the selected model range, which is not rewritten', () => {
    expect(clampDelayS(9, 'mdx')).toBe(4);
    expect(clampDelayS(1, 'kim2')).toBe(3);
    expect(clampDelayS(99, 'kim2')).toBe(8);
    expect(clampDelayS(2, 'deux')).toBe(3);
    expect(clampDelayS(99, 'sw')).toBe(10);
    const stored = normalizeSettings({ mlModel: 'mdx', mlDelayS: 2 });
    expect(mlDelayMsFor({ ...stored, mlModel: 'deux' })).toBe(3000); // Default at 2 s -> Best Vocal uses 3 s
    expect(mlDelayMsFor(stored)).toBe(2000); // back on Default: 2 s again
    expect(mlDelayMsFor({ mlModel: 'mdx', mlDelayS: 9 })).toBe(4000);
  });
  it('keeps the split instrumental switch (off unless exactly true) and its two gains', () => {
    expect(normalizeSettings({}).splitInstrumental).toBe(false);
    expect(normalizeSettings({ splitInstrumental: true }).splitInstrumental).toBe(true);
    for (const v of ['true', 1, null]) expect(normalizeSettings({ splitInstrumental: v }).splitInstrumental).toBe(false);
    expect(normalizeSettings({ drumsPct: 0, othersPct: 900 })).toMatchObject({ drumsPct: 0, othersPct: 100 });
    expect(normalizeSettings({ drumsPct: 'x', othersPct: undefined })).toMatchObject({ drumsPct: 100, othersPct: 100 });
  });
  it.each(['light', 'auto', 'quality', 'ultra', 3])('drops a stored separationQuality (%s) from older versions', (q) => {
    const out = normalizeSettings({ mode: 'separate', masterPct: 200, separationQuality: q });
    expect(out).toEqual({ ...DEFAULT_SETTINGS, mode: 'separate', masterPct: 200 });
    expect('separationQuality' in out).toBe(false);
    expect('separationQuality' in DEFAULT_SETTINGS).toBe(false);
  });
});

describe('effects settings', () => {
  it('default flat and dry, clamped to 0–100 % and ±12 dB, whole dB', () => {
    expect(effectsFor(DEFAULT_SETTINGS)).toEqual({ reverb: 0, low: 0, mid: 0, high: 0 });
    expect(normalizeSettings({ reverbMix: 250, eqLow: -99, eqMid: 3.6, eqHigh: 'x' })).toMatchObject({ reverbMix: 100, eqLow: -12, eqMid: 4, eqHigh: 0 });
    expect(effectsFor(normalizeSettings({ reverbMix: 40, eqLow: 5, eqMid: -2, eqHigh: 12 }))).toEqual({ reverb: 0.4, low: 5, mid: -2, high: 12 });
  });
});

describe('masterGainFor', () => {
  it('maps percent to linear gain in both modes', () => {
    expect(masterGainFor({ ...DEFAULT_SETTINGS, masterPct: 600 })).toBe(6);
    expect(masterGainFor({ ...DEFAULT_SETTINGS, mode: 'separate', masterPct: 250 })).toBe(2.5);
  });
  it('can attenuate down to 0', () => {
    expect(normalizeSettings({ masterPct: 0 }).masterPct).toBe(0);
    expect(normalizeSettings({ masterPct: -5 }).masterPct).toBe(0);
  });
});

describe('separationFor', () => {
  it('is off in Default mode and maps percent to linear gain in Separate mode', () => {
    expect(separationFor(DEFAULT_SETTINGS).on).toBe(false);
    expect(separationFor({ ...DEFAULT_SETTINGS, mode: 'separate', vocalPct: 0, instrumentalPct: 80 })).toEqual({
      on: true,
      vocal: 0,
      instrumental: 0.8,
      drums: 1,
      guitar: 1,
      bass: 1,
      piano: 1,
      others: 1,
      pitchVocal: 0,
      pitchInstrumental: 0,
    });
  });
  it('keeps pitches whole and within ±PITCH_MAX', () => {
    expect(normalizeSettings({ pitch: 3.6, vocalPitch: -99, instrPitch: 'x' })).toMatchObject({ pitch: 4, vocalPitch: -PITCH_MAX, instrPitch: 0 });
    expect(normalizeSettings({ pitchSplit: 'yes' }).pitchSplit).toBe(false);
  });
  it('own pitches apply only in Separate mode with the split on, else the global pitch', () => {
    const base = { ...DEFAULT_SETTINGS, pitch: 2, vocalPitch: -1, instrPitch: 3 };
    expect(separationFor({ ...base, mode: 'separate' })).toMatchObject({ pitchVocal: 2, pitchInstrumental: 2 });
    expect(separationFor({ ...base, mode: 'separate', pitchSplit: true })).toMatchObject({ pitchVocal: -1, pitchInstrumental: 3 });
    expect(separationFor({ ...base, mode: 'default', pitchSplit: true })).toMatchObject({ pitchVocal: 2, pitchInstrumental: 2 });
  });
  it('the drums and others gains apply only with the split on (the instrumental gain stays separate)', () => {
    const base = { ...DEFAULT_SETTINGS, mode: 'separate' as const, instrumentalPct: 50, drumsPct: 200, othersPct: 25 };
    expect(separationFor(base)).toMatchObject({ instrumental: 0.5, drums: 1, others: 1 });
    expect(separationFor({ ...base, splitInstrumental: true })).toMatchObject({ instrumental: 0.5, drums: 2, others: 0.25 });
    expect(separationFor({ ...base, splitGuitar: true, guitarPct: 30 })).toMatchObject({ instrumental: 0.5, drums: 1, guitar: 0.3, others: 0.25 });
    expect(separationFor({ ...base, splitInstrumental: true, splitGuitar: true, guitarPct: 30 })).toMatchObject({ drums: 2, guitar: 0.3, others: 0.25 });
  });
  it('the all-stems model applies the drums, guitar, bass, piano and others levels whatever the split switches say', () => {
    const sw = { ...DEFAULT_SETTINGS, mode: 'separate' as const, mlModel: 'sw' as const, instrumentalPct: 50, drumsPct: 20, guitarPct: 30, bassPct: 40, pianoPct: 60, othersPct: 80 };
    expect(separationFor(sw)).toMatchObject({ instrumental: 0.5, drums: 0.2, guitar: 0.3, bass: 0.4, piano: 0.6, others: 0.8 });
    expect(separationFor({ ...sw, splitInstrumental: true, splitGuitar: true })).toMatchObject({ drums: 0.2, guitar: 0.3 });
    // another model: bass and piano stay out of the mix
    expect(separationFor({ ...sw, mlModel: 'deux' })).toMatchObject({ drums: 1, guitar: 1, bass: 1, piano: 1, others: 1 });
  });
});
