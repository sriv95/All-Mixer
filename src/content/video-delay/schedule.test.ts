import { describe, expect, it } from 'vitest';
import { DelaySchedule, FrameQueue, overlayDelayMs } from './schedule';

describe('overlayDelayMs', () => {
  it('matches the graph in Separate mode', () => {
    expect(overlayDelayMs('separate', 49.3)).toBe(49.3);
    expect(overlayDelayMs('separate', 320)).toBe(320);
  });

  it('only turns on in Default mode above 45 ms of device latency', () => {
    expect(overlayDelayMs('default', 20)).toBe(0);
    expect(overlayDelayMs('default', 45)).toBe(0);
    expect(overlayDelayMs('default', 120)).toBe(120);
  });

  it('is off for zero, negative or unknown latency', () => {
    expect(overlayDelayMs('separate', 0)).toBe(0);
    expect(overlayDelayMs('separate', -5)).toBe(0);
    expect(overlayDelayMs('separate', NaN)).toBe(0);
  });
});

describe('DelaySchedule', () => {
  it('keeps the old delay until the change takes effect', () => {
    const s = new DelaySchedule(50);
    s.set(305, 1000);
    expect(s.at(999)).toBe(50);
    expect(s.at(1000)).toBe(305);
    expect(s.target).toBe(305);
  });

  it('a newer change replaces later pending ones', () => {
    const s = new DelaySchedule(50);
    s.set(305, 2000);
    s.set(100, 1500);
    expect(s.at(1700)).toBe(100);
    expect(s.at(2500)).toBe(100);
  });

  it('prune keeps the delay that applies at the prune time', () => {
    const s = new DelaySchedule(50);
    s.set(305, 1000);
    s.set(100, 3000);
    s.prune(2000);
    expect(s.at(0)).toBe(305);
    expect(s.at(3000)).toBe(100);
  });
});

describe('FrameQueue', () => {
  const make = () => {
    const released: number[] = [];
    const q = new FrameQueue<number>((n) => released.push(n), 4);
    return { q, released };
  };

  it('returns nothing before the first frame is due', () => {
    const { q } = make();
    q.push({ due: 100, mediaTime: 0, img: 1 });
    expect(q.take(80, 16)).toBeNull();
    expect(q.take(92, 16)?.img).toBe(1); // due within half a vsync
  });

  it('takes the newest due frame and releases the skipped ones', () => {
    const { q, released } = make();
    for (let i = 0; i < 3; i++) q.push({ due: 100 + i * 10, mediaTime: i, img: i });
    expect(q.take(125, 16)?.img).toBe(2);
    expect(released).toEqual([0, 1]);
    expect(q.skipped).toBe(2);
    expect(q.size).toBe(0);
  });

  it('keeps due order when captures arrive out of order', () => {
    const { q } = make();
    q.push({ due: 120, mediaTime: 1, img: 2 });
    q.push({ due: 110, mediaTime: 0, img: 1 });
    expect(q.take(110, 0)?.img).toBe(1);
  });

  it('drops the oldest frames past the cap', () => {
    const { q, released } = make();
    for (let i = 0; i < 6; i++) q.push({ due: i, mediaTime: i, img: i });
    expect(q.size).toBe(4);
    expect(released).toEqual([0, 1]);
  });

  it('clear releases everything', () => {
    const { q, released } = make();
    q.push({ due: 1, mediaTime: 0, img: 7 });
    q.clear();
    expect(released).toEqual([7]);
    expect(q.size).toBe(0);
  });
});
