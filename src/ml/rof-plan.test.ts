import { describe, expect, it } from 'vitest';
import { ML_QUANTUM, ML_SAMPLE_RATE, ROF_BLOCK, ROF_CHUNK, ROF_LATENCY_SAMPLES, ROF_OVERLAP } from '../worklet/protocol';
import { BASE_FRAMES, HOP, MARGIN, MAX_FRAMES, OVERLAP, gateMs, makeGeometry, planRof, stepMs } from './rof-plan';

const S = ML_SAMPLE_RATE;

describe('makeGeometry', () => {
  it('reproduces the 2 s geometry of protocol.ts', () => {
    const g = makeGeometry(ROF_BLOCK, ROF_OVERLAP, 39040);
    expect(g).toMatchObject({ frames: BASE_FRAMES, chunk: ROF_CHUNK, latency: ROF_LATENCY_SAMPLES });
  });
  it('chunk = (frames − 1) hops and holds at least 439 samples of context', () => {
    for (const [b, r] of [[22016, 8832], [100096, 20096], [300032, 66048]]) {
      const g = makeGeometry(b, r, 0);
      expect(g.chunk).toBe((g.frames - 1) * HOP);
      expect(g.chunk - g.block - g.overlap).toBeGreaterThanOrEqual(439);
      expect(g.chunk - g.block - g.overlap).toBeLessThan(439 + HOP);
    }
  });
});

describe('stepMs', () => {
  it('is the measured step at the base length and grows faster than linearly past 400 frames', () => {
    expect(stepMs(BASE_FRAMES, 700)).toBe(700);
    expect(stepMs(224, 700)).toBeCloseTo(1400, 0);
    expect(stepMs(896, 700)).toBeGreaterThan(8 * 700 * 1.2);
  });
});

describe('planRof', () => {
  const M1 = 717; // Kim FT, measured at 112 frames
  it('2 s on an M1-class GPU: about the shipped geometry, never over the budget', () => {
    const g = planRof(2 * S, M1)!;
    expect(g).not.toBeNull();
    expect(g.latency).toBeLessThanOrEqual(2 * S);
    expect(g.overlap).toBe(OVERLAP);
    expect(g.block).toBeGreaterThanOrEqual(0.85 * S);
    expect(g.frames).toBeLessThan(130);
  });
  it('every plan stays inside its budget, is on the quantum grid and keeps up (step ≤ block)', () => {
    for (const base of [150, 400, 717]) {
      for (let s = 2; s <= 15; s++) {
        const g = planRof(s * S, base);
        if (!g) continue;
        expect(g.latency).toBeLessThanOrEqual(s * S);
        for (const v of [g.block, g.overlap, g.slack, g.latency]) expect(v % ML_QUANTUM).toBe(0);
        expect(g.frames).toBeLessThanOrEqual(MAX_FRAMES);
        expect(g.slack).toBeLessThanOrEqual(g.block);
        expect(gateMs(g) * MARGIN * (S / 1000)).toBeCloseTo(g.slack, 5);
      }
    }
  });
  it('a longer budget gives a longer block and chunk, and with a slow GPU it stops at what the GPU can keep up with', () => {
    let prev = 0;
    for (let s = 2; s <= 15; s++) {
      const g = planRof(s * S, 400)!;
      expect(g.block).toBeGreaterThanOrEqual(prev); // flat once the chunk is at MAX_FRAMES
      prev = g.block;
    }
    expect(planRof(15 * S, 400)!.frames).toBeGreaterThan(planRof(2 * S, 400)!.frames * 3);
    expect(planRof(15 * S, 884)!.latency).toBeLessThan(10 * S); // throughput-bound: more delay budget does not make the block longer
  });
  it('a faster GPU gets a longer block for the same budget', () => {
    expect(planRof(2 * S, 200)!.block).toBeGreaterThan(planRof(2 * S, 700)!.block);
  });
  it('null when the GPU cannot keep up at any block length of that budget', () => {
    expect(planRof(2 * S, 1000)).toBeNull(); // step is longer than the audio it covers
    expect(planRof(15 * S, 2000)).toBeNull();
  });
});
