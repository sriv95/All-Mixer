import { describe, expect, it } from 'vitest';
import { DelaySchedule, FrameQueue, VIDEO_DELAY_BUDGET_BYTES, captureSize, overlayDelayMs } from './schedule';

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
    q.push({ due: 100, mediaTime: 0, img: 1 }, 0);
    expect(q.take(80, 16)).toBeNull();
    expect(q.take(92, 16)?.img).toBe(1); // due within half a vsync
  });

  it('takes the newest due frame and releases the skipped ones', () => {
    const { q, released } = make();
    for (let i = 0; i < 3; i++) q.push({ due: 100 + i * 10, mediaTime: i, img: i }, 0);
    expect(q.take(125, 16)?.img).toBe(2);
    expect(released).toEqual([0, 1]);
    expect(q.skipped).toBe(2);
    expect(q.size).toBe(0);
  });

  it('keeps due order when captures arrive out of order', () => {
    const { q } = make();
    q.push({ due: 120, mediaTime: 1, img: 2 }, 0);
    q.push({ due: 110, mediaTime: 0, img: 1 }, 0);
    expect(q.take(110, 0)?.img).toBe(1);
  });

  it('drops the oldest frames past the cap', () => {
    const { q, released } = make();
    for (let i = 0; i < 6; i++) q.push({ due: i, mediaTime: i, img: i }, 0);
    expect(q.size).toBe(4);
    expect(released).toEqual([0, 1]);
  });

  it('clear releases everything', () => {
    const { q, released } = make();
    q.push({ due: 1, mediaTime: 0, img: 7 }, 0);
    q.clear();
    expect(released).toEqual([7]);
    expect(q.size).toBe(0);
  });
});

describe('captureSize', () => {
  const base = { displayW: 1920, displayH: 1080, videoW: 1920, videoH: 1080, fps: 60, budgetBytes: VIDEO_DELAY_BUDGET_BYTES };

  it('keeps full size at a short delay', () => {
    const r = captureSize({ ...base, delayMs: 305 });
    expect([r.width, r.height]).toEqual([1920, 1080]);
  });

  it('fits the budget at 2 s and keeps the aspect', () => {
    const r = captureSize({ ...base, delayMs: 2000 });
    const frames = Math.ceil(2 * 60) + 8;
    expect(r.width * r.height * 4 * frames).toBeLessThanOrEqual(VIDEO_DELAY_BUDGET_BYTES);
    expect(Math.abs(r.width / r.height / (1920 / 1080) - 1)).toBeLessThan(0.01);
    expect(r.maxFrames).toBeGreaterThanOrEqual(frames);
  });

  it('caps a 4K display at the 1080p video size', () => {
    const r = captureSize({ ...base, displayW: 3840, displayH: 2160, delayMs: 305 });
    expect([r.width, r.height]).toEqual([1920, 1080]);
  });

  it('allows a larger size at 30 fps than at 60 fps', () => {
    const a = captureSize({ ...base, delayMs: 2000, fps: 60 });
    const b = captureSize({ ...base, delayMs: 2000, fps: 30 });
    expect(b.width * b.height).toBeGreaterThan(a.width * a.height);
  });

  it('queue sized by captureSize does not skip at a steady 2 s / 60 fps', () => {
    const { maxFrames } = captureSize({ ...base, delayMs: 2000 });
    const q = new FrameQueue<number>(() => {});
    q.setCap(maxFrames);
    const step = 1000 / 60;
    for (let n = 0; n < 600; n++) {
      const t = n * step;
      q.push({ due: t + 2000, mediaTime: t, img: n }, t);
      q.take(t, step);
    }
    expect(q.skipped).toBe(0);
  });

  it('keeps not-yet-due frames when the cap shrinks (2000 -> 0 ms)', () => {
    const { maxFrames } = captureSize({ ...base, delayMs: 2000 });
    const small = captureSize({ ...base, delayMs: 0 }).maxFrames;
    const q = new FrameQueue<number>(() => {});
    q.setCap(maxFrames);
    const step = 1000 / 60;
    let taken = 0;
    for (let n = 0; n < 480; n++) {
      const t = n * step;
      if (n === 240) q.setCap(small);
      q.push({ due: t + 2000, mediaTime: t, img: n }, t);
      if (q.take(t, step)) taken++;
    }
    expect(q.skipped).toBe(0);
    expect(taken).toBeGreaterThanOrEqual(238);
  });

  it('trims overdue frames when nothing is taken (hidden tab)', () => {
    const q = new FrameQueue<number>(() => {}, 10);
    for (let n = 0; n < 30; n++) q.push({ due: n, mediaTime: n, img: n }, 1000);
    expect(q.size).toBeLessThanOrEqual(10);
  });
});
