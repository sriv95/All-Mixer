import { describe, expect, it } from 'vitest';
import { MDX_T_MAX, MDX_T_MIN, MDX_T_STEP, mdxGeometry, mdxSegment, mdxSlack, planMdx } from './mdx-plan';
import { GEOMETRY, ML_QUANTUM, ML_SAMPLE_RATE, ML_SLACK_SAMPLES, MDX_SEGMENT } from '../worklet/protocol';

const s = (sec: number): number => sec * ML_SAMPLE_RATE;

describe('planMdx', () => {
  it('the shipped segment is the 64-frame geometry, unchanged', () => {
    expect(mdxSegment(MDX_T_MIN)).toBe(MDX_SEGMENT);
    expect(mdxGeometry(MDX_T_MIN, ML_SLACK_SAMPLES)).toEqual(GEOMETRY.mdx);
  });

  it('2 s (the default limit) keeps the shipped segment on any GPU that passes its gate', () => {
    for (const baseMs of [60, 140, 200]) expect(planMdx(s(2), baseMs)?.geometry).toEqual(GEOMETRY.mdx);
  });

  it('a longer limit gives a longer segment, never over the limit, in whole quanta and 32-frame steps', () => {
    let prev = 0;
    for (const sec of [3, 4, 5, 6, 8, 15]) {
      const p = planMdx(s(sec), 140)!;
      expect(p.geometry.latency).toBeLessThanOrEqual(s(sec));
      expect(p.frames % MDX_T_STEP).toBe(0);
      for (const n of [p.geometry.block, p.geometry.resultOffset, p.geometry.latency]) expect(n % ML_QUANTUM).toBe(0);
      expect(p.frames).toBeGreaterThanOrEqual(prev);
      prev = p.frames;
    }
  });

  it('stops at the longest segment', () => {
    expect(planMdx(s(15), 100)!.frames).toBe(MDX_T_MAX);
  });

  it('a slower GPU gets more slack, so a shorter segment for the same limit', () => {
    expect(mdxSlack(128, 200)).toBeGreaterThan(mdxSlack(128, 100));
    expect(planMdx(s(5), 200)!.frames).toBeLessThan(planMdx(s(5), 60)!.frames);
  });

  it('null when even the shipped segment does not fit', () => {
    expect(planMdx(s(2), 400)).toBeNull();
    expect(planMdx(s(1), 100)).toBeNull();
  });

  it('the gate leaves the step its MARGIN in the slack', () => {
    const g = mdxGeometry(128, mdxSlack(128, 140));
    expect(g.warmupP90Ms).toBeGreaterThanOrEqual(140 * 2);
  });
});
