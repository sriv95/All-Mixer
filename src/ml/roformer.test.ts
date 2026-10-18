import { describe, expect, it } from 'vitest';
import { ROF_BLOCK, ROF_CHUNK, ROF_OVERLAP } from '../worklet/protocol';
import { ROF_FRAMES, RoformerStream, type RoformerMeta } from './roformer';

const H = ROF_BLOCK, R = ROF_OVERLAP, K = ROF_CHUNK - ROF_BLOCK;
const BINS = 1025;

/** Every (bin, channel) value goes to the model once, covered by one band: masks of 1 give the identity. */
const meta: RoformerMeta = {
  frames: ROF_FRAMES,
  chunk: ROF_CHUNK,
  nFft: 2048,
  hop: 441,
  sel: Array.from({ length: 2 * BINS }, (_, i) => i),
  bands: Array.from({ length: BINS }, () => 1),
};

const sineL = (n: number) => 0.5 * Math.sin((2 * Math.PI * 440 * n) / 44100) + 0.1 * Math.sin((2 * Math.PI * 3000 * n) / 44100);
const sineR = (n: number) => 0.4 * Math.cos((2 * Math.PI * 1000 * n) / 44100) + 0.2 * Math.sin((2 * Math.PI * 7000 * n) / 44100);
const block = (f: (n: number) => number, b: number) => Float32Array.from({ length: H }, (_, i) => f(b * H + i));

/** masks of 1 + 0i for every model input value */
const identity = (x: Float32Array): Float32Array => {
  const m = new Float32Array(x.length);
  for (let i = 0; i < m.length; i += 2) m[i] = 1;
  return m;
};

describe('RoformerStream', () => {
  it('geometry: 112 frames, history + block = chunk, overlap smaller than the history', () => {
    expect(ROF_FRAMES).toBe(112);
    expect(K + H).toBe(ROF_CHUNK);
    expect(R).toBeLessThan(K);
  });

  it('STFT matches torch.stft (n_fft 2048, hop 441, hann, centre reflect) on a two-block signal', () => {
    const s = new RoformerStream(meta);
    s.analyze(block(sineL, 0), block(sineR, 0));
    s.analyze(block(sineL, 1), block(sineR, 1)); // the chunk is now signal [H − K, 2H)
    const at = (ch: number, t: number, k: number) => {
      const j = 2 * k + ch; // identity sel: value j is bin j >> 1, channel j & 1
      return [s.x[t * 4100 + 2 * j], s.x[t * 4100 + 2 * j + 1]];
    };
    const want: [number, number, number, number, number][] = [
      [0, 0, 20, 50.790184020996094, -1.264044112758711e-5],
      [0, 50, 21, -121.3265380859375, -167.99444580078125],
      [0, 111, 140, -36.991554260253906, -16.948638916015625],
      [1, 3, 47, 159.525390625, 47.965187072753906],
      [1, 60, 325, 90.75331115722656, 46.52650451660156],
      [1, 111, 1, 0.6536170244216919, 0.0020132954232394695],
      [0, 7, 0, -0.017839839681982994, 0],
    ];
    for (const [ch, t, k, re, im] of want) {
      const [gr, gi] = at(ch, t, k);
      expect(gr).toBeCloseTo(re, 2);
      expect(gi).toBeCloseTo(im, 2);
    }
  });

  it('masks of 1 reproduce the input, delayed by the overlap R, from the second block on', async () => {
    const s = new RoformerStream(meta);
    const outL = new Float32Array(H), outR = new Float32Array(H);
    let worst = 0;
    for (let b = 0; b < 4; b++) {
      await s.process(block(sineL, b), block(sineR, b), identity, outL, outR);
      if (b === 0) continue; // the first chunk has silence in front of it
      // block b is input [b·H − R, (b + 1)·H − R)
      for (let i = 0; i < H; i++) {
        const n = b * H - R + i;
        worst = Math.max(worst, Math.abs(outL[i] - sineL(n)), Math.abs(outR[i] - sineR(n)));
      }
    }
    expect(worst).toBeLessThan(2e-4);
  });

  it('a mask of 0.5 halves the signal', async () => {
    const s = new RoformerStream(meta);
    const half = (x: Float32Array) => identity(x).map((v) => v * 0.5);
    const outL = new Float32Array(H), outR = new Float32Array(H);
    await s.process(block(sineL, 0), block(sineR, 0), half, outL, outR);
    await s.process(block(sineL, 1), block(sineR, 1), half, outL, outR);
    const n = H - R + 5000;
    expect(outL[5000]).toBeCloseTo(0.5 * sineL(n), 4);
  });

  it('gate: masks of 1 pass, masks of 0.05 are removed, and the raw output does not change', async () => {
    const scaled = (g: number) => (x: Float32Array) => identity(x).map((v) => v * g);
    const run = async (g: number) => {
      const s = new RoformerStream(meta);
      const raw = [new Float32Array(H), new Float32Array(H)], gated = { l: new Float32Array(H), r: new Float32Array(H) };
      for (let b = 0; b < 2; b++) await s.process(block(sineL, b), block(sineR, b), scaled(g), raw[0], raw[1], gated);
      return { raw: raw[0], gated: gated.l };
    };
    const pass = await run(1);
    expect(pass.gated[5000]).toBeCloseTo(sineL(H - R + 5000), 4);
    expect(pass.raw[5000]).toBeCloseTo(sineL(H - R + 5000), 4);
    const weak = await run(0.05);
    expect(Math.abs(weak.gated[5000])).toBeLessThan(1e-4);
    expect(weak.raw[5000]).toBeCloseTo(0.05 * sineL(H - R + 5000), 4);
  });

  it('overlapping bands: the masks of the bands that cover a bin are averaged', async () => {
    // every value is sent twice (two "bands"); masks 1 and 0 average to 0.5
    const twice: RoformerMeta = { ...meta, sel: [...meta.sel, ...meta.sel], bands: meta.bands.map(() => 2) };
    const s = new RoformerStream(twice);
    const m = (x: Float32Array) => {
      const out = new Float32Array(x.length);
      const fin = x.length / ROF_FRAMES;
      for (let t = 0; t < ROF_FRAMES; t++) for (let i = 0; i < fin / 2; i += 2) out[t * fin + i] = 1; // first copy: 1, second copy: 0
      return out;
    };
    const outL = new Float32Array(H), outR = new Float32Array(H);
    await s.process(block(sineL, 0), block(sineR, 0), m, outL, outR);
    await s.process(block(sineL, 1), block(sineR, 1), m, outL, outR);
    expect(outL[5000]).toBeCloseTo(0.5 * sineL(H - R + 5000), 4);
  });

  it('reset clears the history and the tail', async () => {
    const s = new RoformerStream(meta);
    const a = new Float32Array(H), b = new Float32Array(H);
    await s.process(block(sineL, 3), block(sineR, 3), identity, a, b);
    s.reset();
    const c = new Float32Array(H), d = new Float32Array(H);
    await s.process(block(sineL, 3), block(sineR, 3), identity, c, d);
    expect(Array.from(c.subarray(0, 100))).toEqual(Array.from(a.subarray(0, 100)));
  });

  it('rejects a meta that does not match the geometry', () => {
    expect(() => new RoformerStream({ ...meta, frames: 111 })).toThrow();
  });
});
