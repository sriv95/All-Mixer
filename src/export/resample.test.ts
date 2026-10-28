import { describe, expect, it } from 'vitest';
import { Resampler } from './resample';

const sine = (hz: number, rate: number, n: number, from = 0) => Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * hz * (from + i)) / rate));

function through(r: Resampler, x: Float32Array, pieces: number[]): Float32Array {
  const out: Float32Array[] = [];
  let at = 0;
  for (const n of pieces) {
    const [l] = r.process(x.subarray(at, at + n), x.subarray(at, at + n));
    out.push(l);
    at += n;
  }
  const all = new Float32Array(out.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of out) {
    all.set(a, o);
    o += a.length;
  }
  return all;
}

describe('Resampler', () => {
  it('48 kHz to 44.1 kHz keeps a 1 kHz sine: right length, right level, right phase', () => {
    const n = 48000;
    const y = through(new Resampler(48000, 44100), sine(1000, 48000, n), [n]);
    expect(Math.abs(y.length - 44100)).toBeLessThanOrEqual(40); // the kernel needs look-ahead: the tail is not flushed
    let worst = 0;
    for (let i = 100; i < y.length - 100; i++) worst = Math.max(worst, Math.abs(y[i] - Math.sin((2 * Math.PI * 1000 * i) / 44100)));
    expect(worst).toBeLessThan(2e-3);
  });

  it('gives the same samples whatever the pieces', () => {
    const x = sine(440, 48000, 9000);
    const whole = through(new Resampler(48000, 44100), x, [9000]);
    const cut = through(new Resampler(48000, 44100), x, [1, 17, 4096, 333, 4553]);
    expect(cut.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i++) expect(cut[i]).toBeCloseTo(whole[i], 6);
  });

  it('removes a tone above the output Nyquist when it goes down', () => {
    const y = through(new Resampler(48000, 44100), sine(23500, 48000, 9600), [9600]);
    let peak = 0;
    for (let i = 200; i < y.length - 200; i++) peak = Math.max(peak, Math.abs(y[i]));
    expect(peak).toBeLessThan(0.05);
  });

  it('is a pass-through at the same rate and works up as well', () => {
    const x = sine(440, 44100, 100);
    expect(new Resampler(44100, 44100).process(x, x)[0]).toBe(x);
    const up = through(new Resampler(22050, 44100), sine(500, 22050, 4000), [4000]);
    expect(Math.abs(up.length - 8000)).toBeLessThanOrEqual(80);
    expect(Math.abs(up[3000] - Math.sin((2 * Math.PI * 500 * 3000) / 44100))).toBeLessThan(5e-3);
  });
});
