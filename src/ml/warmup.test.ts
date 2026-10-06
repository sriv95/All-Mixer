import { describe, expect, it } from 'vitest';
import { warmUp, warmUpGated } from './warmup';

describe('warmUp', () => {
  it('excludes skipped runs from p50/p95 and reports them in firstMs', async () => {
    const durations = [500, 100, ...Array.from({ length: 10 }, (_, i) => 10 + i)];
    let clock = 0, k = 0, pending = 0;
    const now = () => clock;
    const step = async () => { pending = durations[k++]; };
    // advance the fake clock when the step finishes: now() after step = start + duration
    const wrapped = async () => { await step(); clock += pending; };
    const r = await warmUp(wrapped, { skip: 2, n: 10 }, now);
    expect(r.firstMs).toBe(600);
    expect(r.p95).toBe(19); // max of the timed set
    expect(r.p90).toBe(18);
    expect(r.p50).toBe(14);
    expect(k).toBe(12);
  });
});

describe('warmUp gate', () => {
  const fake = (durations: number[]) => {
    let clock = 0, k = 0;
    return { now: () => clock, step: async () => { clock += durations[k++]; } };
  };
  const GATE = 212.8;

  it('one outlier among n=20 keeps p90 under the gate', async () => {
    const f = fake([...Array.from({ length: 19 }, () => 190), 400]);
    const r = await warmUp(f.step, { skip: 0, n: 20 }, f.now);
    expect(r.p90).toBe(190);
    expect(r.p90).toBeLessThan(GATE);
  });

  it('sustained slow (15 of 20 over the gate) fails the gate', async () => {
    const f = fake([...Array.from({ length: 5 }, () => 150), ...Array.from({ length: 15 }, () => 230)]);
    const r = await warmUp(f.step, { skip: 0, n: 20 }, f.now);
    expect(r.p90).toBeGreaterThanOrEqual(GATE);
  });

  it('first attempt over the gate, fast second attempt: second wins, no third', async () => {
    let calls = 0;
    const r = await warmUpGated(async (retry) => {
      calls++;
      return retry ? { p50: 150, p90: 180, p95: 190, firstMs: 0 } : { p50: 200, p90: 220, p95: 230, firstMs: 500 };
    }, GATE);
    expect(calls).toBe(2);
    expect(r).toEqual({ p50: 150, p90: 180, p95: 190, firstMs: 500, attempts: 2 });
  });

  it('both attempts slow: still slow, lower p90 reported, exactly two attempts', async () => {
    let calls = 0;
    const r = await warmUpGated(async (retry) => {
      calls++;
      return retry ? { p50: 220, p90: 235, p95: 240, firstMs: 0 } : { p50: 230, p90: 250, p95: 260, firstMs: 500 };
    }, GATE);
    expect(calls).toBe(2);
    expect(r.p90).toBe(235);
    expect(r.p90).toBeGreaterThanOrEqual(GATE);
    expect(r.attempts).toBe(2);
  });

  it('passing first attempt is not retried', async () => {
    let calls = 0;
    const r = await warmUpGated(async () => { calls++; return { p50: 100, p90: 140, p95: 150, firstMs: 300 }; }, GATE);
    expect(calls).toBe(1);
    expect(r.attempts).toBe(1);
  });
});
