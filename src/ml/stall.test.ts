import { describe, expect, it } from 'vitest';
import { makeStall } from './stall';

describe('makeStall', () => {
  it('is null (no await, no timer) when stallMs is 0', () => {
    expect(makeStall({ stallMs: 0, stallAfterMs: 5000 })).toBeNull();
  });

  it('sleeps only once stallAfterMs has passed since the first block', async () => {
    let t = 1000;
    const slept: number[] = [];
    const stall = makeStall({ stallMs: 400, stallAfterMs: 5000 }, () => t, async (ms) => void slept.push(ms))!;
    await stall(); // first block
    t += 4999;
    await stall();
    expect(slept).toEqual([]);
    t += 1;
    await stall();
    expect(slept).toEqual([400]);
  });
});
