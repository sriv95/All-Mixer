import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, normalizeSettings } from './settings';
import { PRELOAD_MAX_BYTES, preloadBytes, preloadSignature } from './preload';

describe('preload', () => {
  it('the preload switch is a boolean that defaults to Live', () => {
    expect(DEFAULT_SETTINGS.preload).toBe(false);
    expect(normalizeSettings({ preload: true }).preload).toBe(true);
    expect(normalizeSettings({ preload: 'yes' }).preload).toBe(false);
  });
  it('memory: a stereo Float32 buffer per stem', () => {
    expect(preloadBytes(DEFAULT_SETTINGS, 240)).toBe(2 * 240 * 44100 * 8); // vocals + instrumental, 4 min = 170 MB
    expect(preloadBytes({ ...DEFAULT_SETTINGS, mlModel: 'sw' }, 240)).toBe(6 * 240 * 44100 * 8); // vocals, 4 parts, others
    expect(preloadBytes(DEFAULT_SETTINGS, 40 * 60)).toBeGreaterThan(PRELOAD_MAX_BYTES);
  });
  it('the signature changes with the model and the stems', () => {
    const a = preloadSignature(DEFAULT_SETTINGS);
    expect(preloadSignature({ ...DEFAULT_SETTINGS, mlDelayS: 9 } as typeof DEFAULT_SETTINGS)).toBe(a); // the delay limit is not part of the stems
    expect(preloadSignature({ ...DEFAULT_SETTINGS, splitInstrumental: true })).not.toBe(a);
    expect(preloadSignature({ ...DEFAULT_SETTINGS, mlModel: 'deux' })).not.toBe(a);
  });
});
