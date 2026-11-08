import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultExportOptions, tracksOf, type ExportOptions } from '../shared/export';
import { DEFAULT_LYRICS_PREFS } from '../shared/lyrics-prefs';
import { DEFAULT_SETTINGS } from '../shared/settings';
import { ExportMixer, mixSlice, stemsOfSlice, type Pair, type StemSlice } from './mix';

const fxMock = vi.hoisted(() => ({ createEffects: vi.fn() }));
// EQ and reverb are the browser's nodes (createEffects on an OfflineAudioContext): stubbed here, see the ExportMixer effects tests.
vi.mock('../shared/effects', async (orig) => ({ ...(await orig<typeof import('../shared/effects')>()), createEffects: fxMock.createEffects }));
import { PITCH_LATENCY_SAMPLES } from '../worklet/protocol';

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

const L = PITCH_LATENCY_SAMPLES;
const sine = (n: number, from = 0): Float32Array => Float32Array.from({ length: n }, (_, i) => 0.4 * Math.sin((2 * Math.PI * 440 * (from + i)) / 44100));
const crossings = (x: Float32Array): number => x.reduce((k, v, i) => (i && (v < 0) !== (x[i - 1] < 0) ? k + 1 : k), 0);
/** The source `x` as stems: all vocal (vocal = dry, vk = dry) or all instrumental (vocal = 0, vk = 0). */
const stems = (x: Float32Array, start: number, kind: 'vocal' | 'instr'): StemSlice => {
  const pair = (v: Float32Array): Pair => [v, v.slice()];
  const none = new Float32Array(x.length);
  return { start, length: x.length, dry: pair(x), vk: pair(kind === 'vocal' ? x : none), vocal: pair(kind === 'vocal' ? x : none) };
};
/** All the pieces of an export of `x` cut at `cuts`, joined (left channel), with where each piece starts. */
async function run(o: ExportOptions, x: Float32Array, cuts: number[], kind: 'vocal' | 'instr'): Promise<{ out: Float32Array; starts: number[] }> {
  const m = new ExportMixer(o);
  const pieces = [];
  let at = 0;
  for (const end of [...cuts, x.length]) {
    pieces.push(await m.mix(stems(x.slice(at, end), at, kind)));
    at = end;
  }
  pieces.push(await m.flush());
  const got = pieces.filter((p) => p).map((p) => ({ start: p!.start, l: p!.tracks.mix![0] }));
  const out = new Float32Array(got.reduce((a, p) => a + p.l.length, 0));
  got.forEach((p) => out.set(p.l, p.start));
  return { out, starts: got.map((p) => p.start) };
}

describe('ExportMixer pitch (the real PitchShifter)', () => {
  const split = (vocalPitch: number, instrPitch: number) => opts({ mode: 'separate', pitchSplit: true, vocalPitch, instrPitch });

  it('without pitch and effects it is mixSlice and does nothing else', async () => {
    const m = new ExportMixer(opts({ vocalPct: 80 }));
    expect(m.active).toBe(false);
    const s = slice();
    expect((await m.mix(s))!.tracks.mix).toEqual(mixSlice(opts({ vocalPct: 80 }), s).mix);
    expect(await m.flush()).toBeNull();
  });

  it('a stem with no shift stays aligned: the latency is dropped at the start and flushed at the end, nothing lost', async () => {
    const x = sine(30000);
    // the vocal at 0, the (silent) instrumental shifted: the shifters run, so every sample goes through the delay
    const { out } = await run(split(0, 5), x, [10000, 20000], 'vocal');
    expect(out.length).toBe(x.length);
    expect(Array.from(out)).toEqual(Array.from(x));
  });

  it('shifts only the stem that has a pitch of its own, the same across slice seams', async () => {
    const x = sine(44100);
    const whole = await run(split(0, 12), x, [], 'instr');
    const cut = await run(split(0, 12), x, [10000, 30000], 'instr');
    expect(cut.out.length).toBe(x.length);
    expect(cut.starts).toEqual([0, 10000 - L, 30000 - L, 44100 - L]);
    expect(Array.from(cut.out)).toEqual(Array.from(whole.out)); // the shifters' state carries over the seams
    // +12 semitones: twice the pitch (zero crossings of the steady part), where the vocal stem at 0 stays at 440 Hz
    const mid = (v: Float32Array) => v.subarray(10000, 30000);
    expect(crossings(mid(cut.out)) / crossings(mid(x))).toBeGreaterThan(1.8);
    expect(crossings(mid(cut.out)) / crossings(mid(x))).toBeLessThan(2.2);
    const vocal = await run(split(0, 12), x, [], 'vocal');
    expect(Array.from(vocal.out)).toEqual(Array.from(x));
  });

  it('the global pitch moves the whole mix (and the stem tracks stay raw and aligned)', async () => {
    const o = { ...opts({ pitch: 12 }, 'separate') };
    const x = sine(20000);
    const m = new ExportMixer(o);
    const a = (await m.mix(stems(x.slice(0, 12000), 0, 'instr')))!;
    const c = (await m.mix(stems(x.slice(12000), 12000, 'instr')))!;
    const t = (await m.flush())!;
    expect([a.start, c.start, t.start]).toEqual([0, 12000 - L, 20000 - L]);
    expect(t.tracks.instrumental![0].length).toBe(L);
    expect(Array.from(a.tracks.instrumental![0])).toEqual(Array.from(x.slice(0, 12000 - L)));
    expect(Array.from(a.tracks.mix![0])).not.toEqual(Array.from(x.slice(0, 12000 - L)));
  });
});

describe('ExportMixer effects (OfflineAudioContext and the effect nodes stubbed; the DSP of createEffects is the browser\'s)', () => {
  const rendered: { length: number; params: unknown; pre: Float32Array }[] = [];
  afterEach(() => {
    vi.unstubAllGlobals();
    rendered.length = 0;
    fxMock.createEffects.mockReset();
  });
  function stub() {
    fxMock.createEffects.mockImplementation((_ctx: unknown, params: unknown) => ({ input: {}, output: { connect() {} }, params }));
    vi.stubGlobal(
      'OfflineAudioContext',
      class {
        destination = {};
        data: Float32Array[] = [];
        constructor(public channels: number, public length: number) {}
        createBuffer(_c: number, length: number) {
          const data = [new Float32Array(length), new Float32Array(length)];
          this.data = data;
          return { getChannelData: (c: number) => data[c] };
        }
        createBufferSource() {
          return { connect() {}, start() {}, buffer: null };
        }
        async startRendering() {
          const params = fxMock.createEffects.mock.calls.at(-1)![1];
          rendered.push({ length: this.length, params, pre: this.data[0] });
          // "wet": twice the input, so a test can tell it from dry and from the pre-roll
          return { getChannelData: (c: number) => this.data[c].map((v) => 2 * v) };
        }
      },
    );
  }
  const fx = { reverbMix: 30, eqLow: 6, eqMid: -3, eqHigh: 2 };
  const dry = (v: number, n: number): StemSlice => ({ start: 0, length: n, dry: [new Float32Array(n).fill(v), new Float32Array(n).fill(v)] });

  it('gives the effects stage the settings, and puts it before the master gain and the limiter', async () => {
    stub();
    const o = opts({ ...fx, masterPct: 50 });
    const m = new ExportMixer(o);
    expect(m.active).toBe(true);
    const piece = (await m.mix(dry(0.2, 100)))!;
    expect(rendered[0].params).toEqual({ reverb: 0.3, low: 6, mid: -3, high: 2 });
    expect(piece.tracks.mix![0][0]).toBeCloseTo(0.5 * 2 * 0.2, 6); // effects (×2 in the stub), then master 50 %
    expect(piece.tracks.mix![0][0]).not.toBeCloseTo(0.5 * 0.2, 3); // not the dry mix
  });

  it('renders each slice with the mix before it as pre-roll and drops that output (no reset at the seams)', async () => {
    stub();
    const m = new ExportMixer(opts(fx));
    const a = (await m.mix(dry(0.1, 100)))!;
    const b = (await m.mix({ ...dry(0.3, 50), start: 100 }))!;
    expect(rendered.map((r) => r.length)).toEqual([100, 150]); // the second render has the first slice in front
    expect(Array.from(rendered[1].pre.subarray(0, 100)).every((v) => Math.abs(v - 0.1) < 1e-6)).toBe(true);
    expect(b.tracks.mix![0].length).toBe(50); // the pre-roll output is dropped
    expect(b.tracks.mix![0][0]).toBeCloseTo(0.6, 6);
    expect(a.tracks.mix![0][0]).toBeCloseTo(0.2, 6);
  });

  it('keeps the pre-roll to the reverb length plus margin', async () => {
    stub();
    const m = new ExportMixer(opts(fx));
    const n = 44100 * 4;
    await m.mix(dry(0.1, n));
    await m.mix({ ...dry(0.1, 10), start: n });
    expect(rendered[1].length).toBe(10 + Math.round(2.5 * 44100));
  });

  it('renders nothing when there are no effects and no pitch', async () => {
    stub();
    await new ExportMixer(opts({})).mix(dry(0.2, 10));
    expect(fxMock.createEffects).not.toHaveBeenCalled();
  });

  it('pitch and effects together: the shifted mix goes through the effects', async () => {
    stub();
    const m = new ExportMixer(opts({ ...fx, pitch: 12 }));
    const x = sine(8000);
    const a = (await m.mix(stems(x, 0, 'instr')))!;
    const t = (await m.flush())!;
    expect(a.tracks.mix![0].length + t.tracks.mix![0].length).toBe(8000);
    expect(rendered.length).toBe(2);
    expect(rendered[0].pre.length).toBe(8000 - L); // the effects see the stream after the latency was dropped
  });
});
