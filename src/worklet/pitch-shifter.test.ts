import { describe, expect, it } from 'vitest';
import { PitchShifter } from './pitch-shifter';
import { PITCH_LATENCY_SAMPLES } from './protocol';

const RATE = 44100;
const Q = 128;

/** Run `x` through the shifter in render quanta. */
function run(x: Float32Array, semitones: number | ((q: number) => number)): Float32Array {
  const sh = new PitchShifter();
  const out = new Float32Array(x.length);
  for (let q = 0; q < x.length / Q; q++) {
    const a = x.subarray(q * Q, (q + 1) * Q);
    sh.process(a, a, out.subarray(q * Q, (q + 1) * Q), new Float32Array(Q), Q, typeof semitones === 'number' ? semitones : semitones(q));
  }
  return out;
}

const sine = (hz: number, n: number) => Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / RATE));

/** Frequency from upward zero crossings over the second half of `x`. */
function hzOf(x: Float32Array): number {
  const from = x.length >> 1;
  let first = -1;
  let last = -1;
  let count = 0;
  for (let i = from + 1; i < x.length; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) {
      if (first < 0) first = i;
      last = i;
      count++;
    }
  }
  return ((count - 1) * RATE) / (last - first);
}

describe('PitchShifter', () => {
  it('at 0 semitones is the input delayed by PITCH_LATENCY_SAMPLES', () => {
    const x = sine(440, Q * 40);
    const y = run(x, 0);
    for (let i = PITCH_LATENCY_SAMPLES; i < x.length; i++) expect(y[i]).toBeCloseTo(x[i - PITCH_LATENCY_SAMPLES], 6);
  });
  it('moves the pitch by the semitones and keeps the tempo', () => {
    const x = sine(440, RATE);
    for (const st of [-5, -2, 3, 6]) {
      const y = run(x, st);
      expect(hzOf(y) / (440 * 2 ** (st / 12))).toBeCloseTo(1, 1);
    }
  });
  it('fades back to the plain delay at 0 and stays near full level while shifting', () => {
    const x = sine(440, RATE);
    const y = run(x, (q) => (q < 200 ? 4 : 0));
    const tail = y.subarray(y.length - 2000);
    const ref = x.subarray(x.length - 2000 - PITCH_LATENCY_SAMPLES, x.length - PITCH_LATENCY_SAMPLES);
    for (let i = 0; i < tail.length; i++) expect(tail[i]).toBeCloseTo(ref[i], 4);
    const shifted = run(x, 4).subarray(RATE / 2);
    const peak = shifted.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(peak).toBeGreaterThan(0.4);
    expect(peak).toBeLessThan(0.6);
  });
  it('reset clears the delay line', () => {
    const sh = new PitchShifter();
    const a = sine(440, Q);
    const out = new Float32Array(Q);
    sh.process(a, a, out, new Float32Array(Q), Q, 3);
    sh.reset();
    sh.process(new Float32Array(Q), new Float32Array(Q), out, new Float32Array(Q), Q, 0);
    expect(out.every((v) => v === 0)).toBe(true);
  });
});
