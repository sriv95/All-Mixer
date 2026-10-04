import { describe, expect, it } from 'vitest';
import { warmUp } from './warmup';

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
    expect(r.p50).toBe(14);
    expect(k).toBe(12);
  });
});
