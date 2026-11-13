import { describe, expect, it } from 'vitest';
import { FFT } from './fft.js';

function naive(re: Float64Array, im: Float64Array, inverse: boolean) {
  const n = re.length, sg = inverse ? 1 : -1, or = new Float64Array(n), oi = new Float64Array(n);
  for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) {
    const a = (sg * 2 * Math.PI * ((k * j) % n)) / n;
    or[k] += re[j] * Math.cos(a) - im[j] * Math.sin(a);
    oi[k] += re[j] * Math.sin(a) + im[j] * Math.cos(a);
  }
  return [or, oi];
}

describe('FFT non power of two (Bluestein)', () => {
  it.each([12, 7680])('n=%i matches the naive DFT, forward and inverse', (n) => {
    const f = new FFT(n);
    for (const inverse of [false, true]) {
      const re = new Float64Array(n), im = new Float64Array(n);
      for (let i = 0; i < n; i++) { re[i] = Math.sin(i * 0.37) + (i % 5); im[i] = Math.cos(i * 0.11); }
      const [er, ei] = naive(re, im, inverse);
      f.transform(re, im, inverse);
      let err = 0;
      for (let i = 0; i < n; i++) err = Math.max(err, Math.abs(re[i] - er[i]), Math.abs(im[i] - ei[i]));
      expect(err).toBeLessThan(1e-6);
    }
  });
});
