import { describe, expect, it } from 'vitest';
import { DelaySchedule, FrameQueue, PresentedClock, VIDEO_DELAY_BUDGET_BYTES, captureSize, overlayDelayMs } from './schedule';

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
  it('max covers the old delay until a pending decrease takes effect', () => {
    const s = new DelaySchedule(0);
    s.set(2000, -Infinity);
    s.set(300, 1000);
    expect(s.max).toBe(2000);
    s.prune(1000);
    expect(s.max).toBe(300);
  });

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

  it('holds delay + 250 ms of frames at 24, 30 and 60 fps', () => {
    for (const fps of [24, 30, 60]) {
      for (const delayMs of [500, 2000]) {
        const r = captureSize({ ...base, delayMs, fps });
        expect(r.maxFrames).toBeGreaterThanOrEqual(Math.ceil(((delayMs + 250) / 1000) * fps));
      }
    }
  });

  it('fits a 2560x1440 display at 2 s / 60 fps in the 512 MiB budget', () => {
    const r = captureSize({ ...base, displayW: 2560, displayH: 1440, videoW: 3840, videoH: 2160, delayMs: 2000 });
    expect(r.width * r.height * 4 * r.maxFrames).toBeLessThanOrEqual(VIDEO_DELAY_BUDGET_BYTES);
    expect(r.width).toBeLessThan(2560);
  });

  it('does not upscale a small video and keeps at least 320 px', () => {
    const r = captureSize({ ...base, displayW: 1920, displayH: 1080, videoW: 640, videoH: 360, delayMs: 300 });
    expect([r.width, r.height]).toEqual([640, 360]);
    const t = captureSize({ ...base, displayW: 8000, displayH: 4500, videoW: 8000, videoH: 4500, delayMs: 2000 });
    expect(t.width).toBeGreaterThanOrEqual(320);
  });

  it('stays in order and within cap at 2x playback (every other frame)', () => {
    const { maxFrames } = captureSize({ ...base, delayMs: 2000 });
    const q = new FrameQueue<number>(() => {});
    q.setCap(maxFrames);
    const step = 1000 / 60;
    let last = -1;
    for (let n = 0; n < 600; n++) {
      const t = n * step;
      // rVFC delivers a frame every other vsync at 2x; due is wall clock + D.
      if (n % 2 === 0) q.push({ due: t + 2000, mediaTime: n * 2 * step, img: n }, t);
      expect(q.size).toBeLessThanOrEqual(maxFrames);
      const f = q.take(t, step);
      if (f) {
        expect(f.mediaTime).toBeGreaterThan(last);
        last = f.mediaTime;
      }
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

/**
 * Simulated overlay: a 30 fps stream of frames captured at `t` (media time `m0 + (t - t0) * rate`)
 * and drawn at `t + D`. `run(from, to)` steps 1 ms at a time, feeding the clock as DelayedVideo does.
 */
class Sim {
  clock = new PresentedClock();
  now = 0;
  private frames: { shownAt: number; media: number }[] = [];
  private shownIdx = 0;
  rate = 1;
  constructor(readonly d: number) {}

  /** Capture frames over [from, to) ms; media time advances from `media0` at `rate`. */
  capture(from: number, to: number, media0: number, rate = 1): void {
    for (let t = from; t < to; t += 1000 / 30) this.frames.push({ shownAt: t + this.d, media: media0 + ((t - from) / 1000) * rate });
    this.rate = rate;
  }

  /** Drop frames not shown yet (a seek clears the queue). */
  clearQueue(): void {
    this.frames = this.frames.filter((f) => f.shownAt <= this.now);
  }

  run(to: number, onStep?: (now: number) => void): void {
    for (; this.now <= to; this.now++) {
      const due = this.frames.filter((f) => f.shownAt <= this.now);
      const last = due[due.length - 1];
      if (last && this.frames.indexOf(last) >= this.shownIdx) {
        this.clock.show(last.media, last.shownAt, this.rate);
        this.shownIdx = this.frames.indexOf(last) + 1;
      }
      this.clock.pending(this.frames.find((f) => f.shownAt > this.now)?.media ?? null);
      onStep?.(this.now);
    }
  }
}

describe.each([500, 2000])('PresentedClock at D = %i ms', (D) => {
  it('is null before the first frame and after reset', () => {
    const c = new PresentedClock();
    expect(c.at(100)).toBeNull();
    c.show(5, 100, 1);
    expect(c.at(100)).toBe(5);
    c.reset();
    expect(c.at(200)).toBeNull();
  });

  it('steady play: equals the media time of the audio heard now (within a frame)', () => {
    const sim = new Sim(D);
    sim.capture(0, 20000, 10);
    sim.run(D + 5000, (now) => {
      if (now < D + 100) return;
      const heard = 10 + (now - D) / 1000;
      expect(Math.abs(sim.clock.at(now)! - heard)).toBeLessThan(0.034);
    });
  });

  it('pause: keeps advancing for D, then freezes at the last frame with no jump back', () => {
    const sim = new Sim(D);
    const P = 3000;
    sim.capture(0, P, 0);
    let prev = -1;
    let atP = 0;
    sim.run(P + D + 3000, (now) => {
      const v = sim.clock.at(now);
      if (v === null) return;
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = v;
      if (now === P) atP = v;
    });
    // Between P and P + D the user still hears the tail.
    expect(atP).toBeCloseTo((P - D) / 1000, 1);
    const last = (P - 1000 / 30) / 1000;
    expect(sim.clock.at(P + D + 3000)).toBeGreaterThan(last - 0.001);
    expect(sim.clock.at(P + D + 3000)).toBeLessThanOrEqual(last + 0.05 + 1e-9);
    expect(sim.clock.at(P + D + 1000)).toBe(sim.clock.at(P + D + 3000));
  });

  it('play after pause: frozen until the first new frame is shown at play + D, then advances without a jump', () => {
    const sim = new Sim(D);
    sim.capture(0, 2000, 0);
    const resume = 6000;
    sim.capture(resume, resume + 4000, 2.0);
    const samples: [number, number][] = [];
    sim.run(resume + D + 1000, (now) => samples.push([now, sim.clock.at(now) ?? NaN]));
    const frozen = samples.find(([n]) => n === 2000 + D + 500)![1];
    for (const [n, v] of samples) if (n >= 2000 + D + 100 && n < resume + D) expect(v).toBe(frozen);
    let prev = frozen;
    for (const [n, v] of samples) {
      if (n < resume + D) continue;
      expect(v - prev).toBeLessThan(0.05);
      prev = v;
    }
    expect(samples.find(([n]) => n === resume + D + 900)![1]).toBeCloseTo(2.9, 1);
  });

  it('seek 60 s -> 10 s: holds the old time until the first new frame at seek + D, then 10 s', () => {
    const sim = new Sim(D);
    sim.capture(0, 5000, 55);
    const seekAt = 5000;
    let held = 0;
    sim.run(seekAt);
    sim.clearQueue();
    const lastShown = sim.clock.at(seekAt)!;
    sim.capture(seekAt + 100, seekAt + 4000, 10);
    let after = 0;
    sim.run(seekAt + D + 1000, (now) => {
      const v = sim.clock.at(now)!;
      if (now === seekAt + D + 100 + 500) after = v;
      if (now >= seekAt + D - 50 && now < seekAt + 100 + D) {
        expect(v).toBeGreaterThan(lastShown - 0.05);
        expect(v).toBeLessThan(lastShown + 0.06);
        held++;
      }
    });
    expect(held).toBeGreaterThan(0);
    expect(after).toBeCloseTo(10.5, 1);
  });

  it('rate 1.5x: advances 1.5 s per s', () => {
    const sim = new Sim(D);
    sim.capture(0, 20000, 0, 1.5);
    let a = 0;
    let b = 0;
    sim.run(D + 6000, (now) => {
      if (now === D + 3000) a = sim.clock.at(now)!;
      if (now === D + 5000) b = sim.clock.at(now)!;
    });
    // Allow one frame of quantisation (clamped to the next frame).
    expect((b - a) / 2).toBeGreaterThan(1.4);
    expect((b - a) / 2).toBeLessThan(1.6);
  });

  it('buffering stall: freezes, resumes without a jump', () => {
    const sim = new Sim(D);
    sim.capture(0, 2000, 0);
    sim.capture(5000, 8000, 2.0); // no frames for 3 s, no pause event
    let prev = -1;
    let maxStep = 0;
    let stalled = 0;
    sim.run(5000 + D + 1500, (now) => {
      const v = sim.clock.at(now);
      if (v === null) return;
      if (now === 2000 + D + 500) stalled = v;
      if (prev >= 0) {
        expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
        maxStep = Math.max(maxStep, v - prev);
      }
      prev = v;
    });
    expect(maxStep).toBeLessThan(0.05);
    expect(stalled).toBeLessThan(2.1);
  });
});

describe('hold / release (pause)', () => {
  const mk = () => {
    const released: number[] = [];
    return { released, q: new FrameQueue<number>((n) => released.push(n)) };
  };
  const f = (due: number, img: number, still = false) => ({ due, mediaTime: img, img, still });

  it('queue: held take returns null and keeps every frame', () => {
    const { q, released } = mk();
    q.push(f(100, 1), 0);
    q.push(f(110, 2), 0);
    q.hold(50);
    expect(q.held).toBe(true);
    expect(q.take(1000, 16)).toBeNull();
    expect(q.size).toBe(2);
    expect(released).toEqual([]);
    expect(q.skipped).toBe(0);
  });

  it('queue: release shifts all due by the held time and keeps order', () => {
    const { q } = mk();
    q.push(f(100, 1), 0);
    q.push(f(110, 2), 0);
    q.hold(50);
    q.hold(60); // idempotent: first heldAt stays
    expect(q.release(550)).toBe(500);
    expect(q.held).toBe(false);
    expect(q.release(600)).toBe(0);
    expect(q.take(590, 16)).toBeNull();
    expect(q.take(600, 16)?.img).toBe(1);
    expect(q.take(610, 16)?.img).toBe(2);
  });

  it('queue: a still frame is taken while held, frames behind it stay', () => {
    const { q } = mk();
    q.hold(0);
    q.push(f(5, 1, true), 0);
    q.push(f(9000, 2), 0);
    expect(q.take(10, 16)?.img).toBe(1);
    expect(q.take(10, 16)).toBeNull();
    expect(q.size).toBe(1);
  });

  it('queue: clear keeps the hold, rebase moves heldAt', () => {
    const { q } = mk();
    q.push(f(1, 1), 0);
    q.hold(10);
    q.clear();
    expect(q.held).toBe(true);
    q.rebase(100);
    q.push(f(200, 2), 100);
    expect(q.release(300)).toBe(200);
    expect(q.take(400, 16)?.img).toBe(2);
    q.rebase(5); // not held: no-op
    expect(q.held).toBe(false);
  });

  it('queue: push while held does not trim as overdue', () => {
    const { q, released } = mk();
    q.setCap(4);
    q.setCap(2); // hard cap stays 4, so only overdue frames may be trimmed
    q.push(f(0, 1), 0);
    q.push(f(1, 2), 0);
    q.hold(1);
    q.push(f(2, 3), 5000); // `now` far past due, but frozen at 1
    expect(q.size).toBe(3);
    expect(released).toEqual([]);
  });

  it('schedule: a pending step moves by the pause, a step added meanwhile does not', () => {
    const s = new DelaySchedule(100);
    s.set(500, 1000);
    s.hold(200);
    s.set(300, 1100); // added during the pause: keeps its time
    s.release(500);
    expect(s.at(1099)).toBe(100);
    expect(s.at(1100)).toBe(300);
    expect(s.at(1500)).toBe(500);

    const t = new DelaySchedule(100);
    t.set(500, 1000);
    t.hold(200);
    t.set(50, 1200); // keeps its time, ends up before the shifted step
    t.release(500);
    expect(t.at(1200)).toBe(50);
    expect(t.at(1499)).toBe(50);
    expect(t.at(1500)).toBe(500); // the shifted change is not lost
    expect(t.target).toBe(500);
  });

  it('schedule: steps already in effect are not shifted', () => {
    const s = new DelaySchedule(100);
    s.set(500, 100);
    s.hold(200);
    s.release(500);
    expect(s.at(150)).toBe(500);
  });

  it('clock: frozen while held, continues from the held value after release', () => {
    const c = new PresentedClock();
    c.show(10, 0, 1);
    c.pending(null);
    expect(c.at(30)).toBeCloseTo(10.03);
    c.hold(40);
    expect(c.at(40)).toBeCloseTo(10.04);
    expect(c.at(5000)).toBeCloseTo(10.04);
    c.release(1000);
    expect(c.at(1040)).toBeCloseTo(10.04);
    expect(c.at(1060)).toBeCloseTo(10.05); // capped by MAX_EXTRAPOLATE_S, no jump
  });

  it('clock: a frame shown while held starts counting at release', () => {
    const c = new PresentedClock();
    c.hold(100);
    c.show(20, 150, 1);
    expect(c.at(200)).toBe(20);
    c.release(300);
    expect(c.at(400)).toBe(20);
    expect(c.at(420)).toBeCloseTo(20.02);
  });
});
