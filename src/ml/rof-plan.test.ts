import { describe, expect, it } from 'vitest';
import { ML_BLOCK, ML_QUANTUM, ML_RESULT_OFFSET, ML_SAMPLE_RATE, ROF_BLOCK, ROF_CHUNK, ROF_LATENCY_SAMPLES, ROF_OVERLAP } from '../worklet/protocol';
import { BASE_FRAMES, HOP, MARGIN, MAX_FRAMES, OVERLAP, drumRuns, gateMs, makeGeometry, planMdxDrums, planRof, stepMs } from './rof-plan';
import { SC_LAG, SC_STRIDE } from './scnet';

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

describe('planRof with the drum stage', () => {
  const FAST = 200, DRUM = 250; // a desktop-class GPU: Kim FT at 112 frames, one SCNet Tran run (an M1 measured 717 and 820)
  it('drums add the wait for the chunk to the delay, and their runs to the step', () => {
    expect(planRof(10 * S, FAST)!.extra).toBe(0);
    const g = planRof(10 * S, FAST, DRUM)!;
    expect(g).not.toBeNull();
    expect(g.extra).toBe(SC_LAG);
    expect(g.latency).toBe(g.block + g.overlap + g.extra + g.slack + ML_QUANTUM);
    expect(g.latency).toBeLessThanOrEqual(10 * S + SC_LAG);
    expect(g.slack).toBeGreaterThanOrEqual(Math.floor((MARGIN * (stepMs(g.frames, FAST) + drumRuns(g.block) * DRUM) * S) / 1000));
    expect(g.slack).toBeLessThanOrEqual(g.block);
    for (const v of [g.block, g.overlap, g.extra, g.slack, g.latency]) expect(v % ML_QUANTUM).toBe(0);
  });
  it('the same budget gives a shorter block with drums', () => {
    expect(planRof(10 * S, FAST, DRUM)!.block).toBeLessThan(planRof(10 * S, FAST)!.block);
  });
  it('the drum wait is on top of the budget, and a GPU that cannot do both in real time never plans (an M1 with the High quality model)', () => {
    const g = planRof(2 * S, FAST, DRUM)!;
    expect(g.latency).toBe(g.block + g.overlap + g.slack + ML_QUANTUM + SC_LAG);
    expect(planRof(15 * S, 717, 820)).toBeNull();
  });
  it('a slower GPU needs a longer budget', () => {
    const need = (base: number, drum: number) => [...Array(14).keys()].map((i) => i + 2).find((s) => planRof(s * S, base, drum));
    expect(need(400, 500)).toBeGreaterThan(need(200, 250)!);
  });
  it('a block of more than one stride runs the drum model more than once', () => {
    expect(drumRuns(SC_STRIDE - 1)).toBe(1);
    expect(drumRuns(SC_STRIDE)).toBe(2);
  });
});

describe('planMdxDrums', () => {
  it('keeps the MDX block and adds the drum wait; the slack covers a step with a drum run', () => {
    const g = planMdxDrums(143, 820)!; // MDX block step and one SCNet Tran run, measured on an M1
    expect(g).not.toBeNull();
    expect(g.block).toBe(ML_BLOCK);
    expect(g.resultOffset).toBe(ML_RESULT_OFFSET + SC_LAG);
    expect(g.drums).toBe(true);
    const slack = g.latency - g.block - g.resultOffset - ML_QUANTUM;
    expect(slack).toBeGreaterThanOrEqual(Math.floor((MARGIN * (143 + 820) * S) / 1000));
    for (const v of [g.block, g.resultOffset, g.latency]) expect(v % ML_QUANTUM).toBe(0);
    expect(g.latency / S).toBeLessThan(8); // an M1: about 6 s in all
  });
  it('null when the load of both models is over the block period', () => {
    expect(planMdxDrums(143, 820 * 3)).toBeNull();
    expect(planMdxDrums(700, 820)).toBeNull();
  });
});
