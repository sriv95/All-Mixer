import { describe, expect, it } from 'vitest';
import { MlTiming } from './timing';

describe('MlTiming', () => {
  it('posts a summary every 32 blocks with p50/p95/max, catchUp stats and the skipped count', () => {
    const t = new MlTiming();
    const lines: string[] = [];
    for (let i = 0; i < 64; i++) {
      t.catchUp(10 + (i % 2));
      const l = t.block(100 + i, 3);
      if (l) lines.push(l);
    }
    expect(lines.length).toBe(2);
    expect(lines[0]).toBe('[all-mixer ml] mdx resp p50/p95/max 116/130/131 ms, spl catchUp p50/p95/max 11/11/11 ms, n 32, spleeter-skipped 3');
    expect(lines[1]).toContain('n 64');
  });
});
