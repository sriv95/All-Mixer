import { describe, expect, it } from 'vitest';
import { DELAY_RANGE } from './rof-plan';
import { MDX_KIM2, MDX_T_MAX, MDX_T_MIN, MDX_T_STEP, mdxGeometry, mdxSegment, mdxSlack, planMdx } from './mdx-plan';
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

describe('planMdx for Kim Vocal 2', () => {
  const plan = (sec: number, baseMs = 100) => planMdx(s(sec), baseMs, MDX_KIM2);
  it('the delay range is 3 to 8 s and the first limit gives a valid segment (32-frame steps, whole quanta, no Karaoke tail)', () => {
    expect(DELAY_RANGE.kim2).toEqual({ min: 3, max: 8 });
    const p = plan(3)!;
    expect(p.frames % MDX_T_STEP).toBe(0);
    expect(p.frames).toBeGreaterThanOrEqual(MDX_T_MIN);
    expect(p.geometry.latency).toBeLessThanOrEqual(s(3));
    expect(p.geometry.resultOffset).toBe(p.geometry.block);
    for (const n of [p.geometry.block, p.geometry.latency]) expect(n % ML_QUANTUM).toBe(0);
  });
  it('a longer limit gives a larger segment, capped at 256 frames, never over the limit', () => {
    let prev = 0;
    for (const sec of [3, 4, 5, 6, 8]) {
      const p = plan(sec)!;
      expect(p.geometry.latency).toBeLessThanOrEqual(s(sec));
      expect(p.frames).toBeGreaterThanOrEqual(prev);
      prev = p.frames;
    }
    expect(plan(8)!.frames).toBe(MDX_T_MAX);
    expect(plan(15)!.frames).toBe(MDX_T_MAX);
    expect(plan(3)!.frames).toBeLessThan(MDX_T_MAX);
  });
  it('null when the GPU is too slow for the limit', () => {
    expect(plan(3, 1500)).toBeNull();
  });
});
