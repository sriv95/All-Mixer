import { describe, expect, it } from 'vitest';
import { defaultExportOptions, tracksOf, type ExportOptions } from '../shared/export';
import { DEFAULT_LYRICS_PREFS } from '../shared/lyrics-prefs';
import { DEFAULT_SETTINGS } from '../shared/settings';
import { mixSlice, stemsOfSlice, type Pair, type StemSlice } from './mix';

const opts = (audio: Partial<ExportOptions['audio']>, tracks: ExportOptions['tracks'] = 'single'): ExportOptions => ({
  ...defaultExportOptions({ ...DEFAULT_SETTINGS, ...audio }, DEFAULT_LYRICS_PREFS),
  tracks,
});
const fill = (v: number): Pair => [Float32Array.of(v, v), Float32Array.of(v, v)];
// dry 0.5 = vocal 0.15 + instrumental 0.35 (Vk = the vocal for the instrumental); instrumental = drums 0.1 + rest 0.25
const slice = (): StemSlice => ({ start: 0, length: 2, dry: fill(0.5), vk: fill(0.15), vocal: fill(0.15), parts: { drums: fill(0.1) } });
const first = (p: Pair | undefined) => p![0][0];

describe('mixSlice', () => {
  it('100 % everywhere is the recording back (vocal + instrumental = dry)', () => {
    const t = mixSlice(opts({}), slice());
    expect(first(t.mix)).toBeCloseTo(0.5, 6);
  });

  it('a cappella and karaoke levels', () => {
    expect(first(mixSlice(opts({ vocalPct: 100, instrumentalPct: 0 }), slice()).mix)).toBeCloseTo(0.15, 6);
    expect(first(mixSlice(opts({ vocalPct: 0, instrumentalPct: 100 }), slice()).mix)).toBeCloseTo(0.35, 6);
  });

  it('master volume scales the mix and a boost never clips', () => {
    expect(first(mixSlice(opts({ masterPct: 50 }), slice()).mix)).toBeCloseTo(0.25, 6);
    const loud = first(mixSlice(opts({ masterPct: 600 }), slice()).mix); // 3.0 before the limit
    expect(loud).toBeLessThan(1);
    expect(loud).toBeGreaterThan(0.97);
  });

  it('split levels: drums, then the others (the live formula)', () => {
    const o = opts({ splitInstrumental: true, drumsPct: 50, othersPct: 0, instrumentalPct: 100 });
    expect(first(mixSlice(o, slice()).mix)).toBeCloseTo(0.15 + 0.5 * 0.1, 6);
  });

  it('separate tracks: the mix has the levels, each stem is raw, and the stems add up to the recording', () => {
    const o = opts({ splitInstrumental: true, vocalPct: 80, drumsPct: 50, othersPct: 70, instrumentalPct: 90, masterPct: 100 }, 'separate');
    const t = mixSlice(o, slice());
    expect(tracksOf(o)).toEqual(['mix', 'vocals', 'drums', 'others']);
    expect(first(t.vocals)).toBeCloseTo(0.15, 6);
    expect(first(t.drums)).toBeCloseTo(0.1, 6);
    expect(first(t.others)).toBeCloseTo(0.25, 6);
    expect(first(t.vocals) + first(t.drums) + first(t.others)).toBeCloseTo(0.5, 6);
    expect(first(t.mix)).toBeCloseTo(0.8 * 0.15 + 0.9 * (0.5 * 0.1 + 0.7 * 0.25), 6); // levels only here
    expect(t.instrumental).toBeUndefined();
  });

  it('the global volume applies to every track', () => {
    const t = mixSlice(opts({ masterPct: 50 }, 'separate'), { ...slice(), parts: {} });
    expect(first(t.vocals)).toBeCloseTo(0.075, 6);
    expect(first(t.instrumental)).toBeCloseTo(0.175, 6);
  });

  it('without a model the slice is the recording at the master level', () => {
    const t = mixSlice(opts({ masterPct: 200 }), { start: 0, length: 2, dry: fill(0.25) });
    expect(first(t.mix)).toBeCloseTo(0.5, 6);
  });
});

describe('stemsOfSlice', () => {
  const a = (over: Partial<ExportOptions['audio']> = {}) => ({ ...DEFAULT_SETTINGS, ...over });
  it('without parts: the vocal and the instrumental (dry − vk)', () => {
    const s = stemsOfSlice(a(), slice());
    expect(Object.keys(s)).toEqual(['vocals', 'instrumental']);
    expect(first(s.vocals)).toBeCloseTo(0.15, 6);
    expect(first(s.instrumental)).toBeCloseTo(0.35, 6);
  });
  it('with a split part: the part, and the rest of the instrumental without it', () => {
    const s = stemsOfSlice(a({ splitInstrumental: true }), slice());
    expect(Object.keys(s)).toEqual(['vocals', 'drums', 'others']);
    expect(first(s.drums)).toBeCloseTo(0.1, 6);
    expect(first(s.others)).toBeCloseTo(0.25, 6);
  });
  it('the stems at their own level add up to the mix of mixSlice', () => {
    const o = opts({ vocalPct: 50, instrumentalPct: 80, drumsPct: 25, othersPct: 60, splitInstrumental: true });
    const s = stemsOfSlice(o.audio, slice());
    const g = { v: 0.5, i: 0.8, d: 0.25, o: 0.6 };
    const sum = g.v * first(s.vocals) + g.i * (g.d * first(s.drums) + g.o * first(s.others));
    expect(first(mixSlice(o, slice()).mix)).toBeCloseTo(sum, 6);
  });
  it('a slice without a model has no stems', () => {
    expect(stemsOfSlice(a(), { start: 0, length: 2, dry: fill(0.5) })).toEqual({});
  });
});
