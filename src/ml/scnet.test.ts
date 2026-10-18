import { describe, expect, it } from 'vitest';
import { DrumStage, SC_BINS, SC_CHUNK, SC_FRAMES, SC_INPUT, SC_LAG, SC_STRIDE, ScnetChunk } from './scnet';

const sineL = (n: number) => 0.5 * Math.sin((2 * Math.PI * 440 * n) / 44100) + 0.1 * Math.sin((2 * Math.PI * 3000 * n) / 44100);
const sineR = (n: number) => 0.4 * Math.cos((2 * Math.PI * 1000 * n) / 44100) + 0.2 * Math.sin((2 * Math.PI * 7000 * n) / 44100);
const make = (f: (n: number) => number, from: number, len: number) => Float32Array.from({ length: len }, (_, i) => f(from + i));
/** Drums = the input, so the stage output is the instrumental it was given. */
const identity = (x: Float32Array): Float32Array => x;

describe('ScnetChunk', () => {
  it('geometry: 128 frames, odd frame count after SCNet padding, lag covers the chunk', () => {
    expect(SC_INPUT).toBe(4 * SC_BINS * SC_FRAMES);
    expect(SC_CHUNK).toBe(129772);
    expect((SC_CHUNK + 276) / 1024).toBe(127);
    expect(SC_LAG % 128).toBe(0);
    expect(SC_LAG).toBeGreaterThanOrEqual(SC_CHUNK);
  });

  it('STFT matches torch.stft (n_fft 4096, hop 1024, rectangular, normalized, centre reflect, zero pad 276)', () => {
    const c = new ScnetChunk();
    c.analyze(make(sineL, 0, SC_CHUNK), make(sineR, 0, SC_CHUNK));
    const plane = SC_BINS * SC_FRAMES;
    const at = (ch: number, t: number, k: number) => [c.x[(2 * ch) * plane + k * SC_FRAMES + t], c.x[(2 * ch + 1) * plane + k * SC_FRAMES + t]];
    // [channel, frame, bin, re, im] from torch.stft on this signal (zero-padded by 276, window=ones, normalized=True)
    const cases: [number, number, number, number, number][] = [
      [0, 0, 41, 3.28184175491333, 0],
      [0, 64, 41, 11.048364639282227, 10.930914878845215],
      [1, 64, 372, -0.00046688690781593323, -0.001291528344154358],
      [1, 127, 372, 0.00821211189031601, 0.00527113676071167],
      [0, 100, 1000, 0.00021773111075162888, 0.0001740138977766037],
      [1, 3, 5, -0.02009056694805622, -0.0014576750108972192],
      [0, 127, 41, 5.070338726043701, 0.3193110227584839],
    ];
    for (const [ch, t, k, re, im] of cases) {
      const [r, i] = at(ch, t, k);
      expect(r).toBeCloseTo(re, 3);
      expect(i).toBeCloseTo(im, 3);
    }
  });

  it('iSTFT of the unchanged STFT gives the chunk back', () => {
    const c = new ScnetChunk();
    const l = make(sineL, 0, SC_CHUNK), r = make(sineR, 0, SC_CHUNK);
    c.analyze(l, r);
    const oL = new Float32Array(SC_CHUNK), oR = new Float32Array(SC_CHUNK);
    c.synthesize(c.x, oL, oR);
    let worst = 0;
    for (let i = 0; i < SC_CHUNK; i++) worst = Math.max(worst, Math.abs(oL[i] - l[i]), Math.abs(oR[i] - r[i]));
    expect(worst).toBeLessThan(2e-4);
  });
});

describe('DrumStage', () => {
  it('returns the pushed signal below `ready`, across several chunks and blocks of any size', async () => {
    const s = new DrumStage();
    const total = 3 * SC_STRIDE + SC_CHUNK + 5000;
    let pushed = 0;
    for (const n of [50000, 70000, 40000, total - 160000]) {
      await s.push(make(sineL, pushed, n), make(sineR, pushed, n), n, identity);
      pushed += n;
      expect(s.length).toBe(pushed);
      // never more than one chunk behind
      expect(pushed - s.ready).toBeLessThan(SC_LAG);
    }
    expect(s.ready).toBe(4 * SC_STRIDE);
    const oL = new Float32Array(s.ready), oR = new Float32Array(s.ready);
    s.read(0, s.ready, oL, oR);
    let worst = 0;
    for (let i = 0; i < s.ready; i++) worst = Math.max(worst, Math.abs(oL[i] - sineL(i)), Math.abs(oR[i] - sineR(i)));
    expect(worst).toBeLessThan(3e-4);
  });

  it('reset starts a new stream; reads before the stream are silent', async () => {
    const s = new DrumStage();
    await s.push(make(sineL, 0, SC_CHUNK), make(sineR, 0, SC_CHUNK), SC_CHUNK, identity);
    s.reset();
    expect(s.ready).toBe(0);
    expect(s.length).toBe(0);
    const o = new Float32Array(4).fill(1);
    s.read(-4, 4, o, new Float32Array(4));
    expect([...o]).toEqual([0, 0, 0, 0]);
  });

  it('refuses a block that would not leave room for its chunk', async () => {
    await expect(new DrumStage().push(new Float32Array(1), new Float32Array(1), 2 ** 20, identity)).rejects.toThrow();
  });
});
