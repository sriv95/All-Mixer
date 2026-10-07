import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DelayedVideo } from './delayed-video';

type Vfc = (now: number, md: { expectedDisplayTime: number; mediaTime: number }) => void;

let video: HTMLVideoElement;
let vfcCb: Vfc | null;
let rafCb: ((t: number) => void) | null;
let createBitmap: ReturnType<typeof vi.fn>;
let closed: number;
let paused: boolean;
let removeSpy: ReturnType<typeof vi.spyOn>;

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  closed = 0;
  vfcCb = null;
  rafCb = null;
  document.body.innerHTML = '<div id="p"></div>';
  video = document.createElement('video');
  document.getElementById('p')!.append(video);
  (video as unknown as Record<string, unknown>).requestVideoFrameCallback = (cb: Vfc) => {
    vfcCb = cb;
    return 1;
  };
  (video as unknown as Record<string, unknown>).cancelVideoFrameCallback = () => {
    vfcCb = null;
  };
  paused = false;
  Object.defineProperty(video, 'paused', { get: () => paused });
  Object.defineProperty(video, 'clientWidth', { value: 640 });
  Object.defineProperty(video, 'clientHeight', { value: 360 });
  createBitmap = vi.fn(() => Promise.resolve({ close: () => closed++ }));
  vi.stubGlobal('createImageBitmap', createBitmap);
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
    rafCb = cb;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {
    rafCb = null;
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  HTMLCanvasElement.prototype.getContext = (() => ({ drawImage: () => {} })) as never;
  removeSpy = vi.spyOn(video, 'removeEventListener');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const canvas = () => document.querySelector<HTMLCanvasElement>('canvas.all-mixer-delayed-video');
const frame = (display: number) => vfcCb!(0, { expectedDisplayTime: display, mediaTime: 0 });

describe('DelayedVideo', () => {
  it('reports stats for drawn frames and honours the legacy budget', async () => {
    const dv = new DelayedVideo(video);
    dv.setDelay(100);
    frame(0);
    await flush();
    rafCb!(1000);
    const s = dv.stats;
    expect(s.drawn).toBe(1);
    expect(s.maxFrames).toBeGreaterThan(0);
    expect(s.errMs.p95).toEqual(expect.any(Number));
    dv.setBudget(1e15);
    expect(dv.stats.maxFrames).toBe(120);
  });

  it('keeps the canvas out of the DOM at delay 0', () => {
    const dv = new DelayedVideo(video);
    expect(canvas()).toBeNull();
    dv.setDelay(0);
    expect(canvas()).toBeNull();
    expect(dv.state).toBe('off');
  });

  it('places a hidden canvas after the video until the first frame is drawn', async () => {
    const dv = new DelayedVideo(video);
    dv.setDelay(100);
    const c = canvas()!;
    expect(video.nextElementSibling).toBe(c);
    expect(c.style.display).toBe('none');
    expect(dv.state).toBe('waiting');
    frame(0);
    await flush();
    rafCb!(1000);
    expect(c.style.display).toBe('');
    expect(dv.state).toBe('on');
  });

  it('drops queued frames on seeking', async () => {
    const dv = new DelayedVideo(video);
    dv.setDelay(100);
    frame(1e9); // due far in the future, so it stays queued
    await flush();
    video.dispatchEvent(new Event('seeking'));
    expect(closed).toBe(1);
    rafCb!(1e6);
    expect(dv.state).toBe('waiting'); // nothing left to draw
  });

  it('fails and removes the canvas after 30 capture errors in a row', async () => {
    const states: string[] = [];
    const dv = new DelayedVideo(video, (s) => states.push(s));
    createBitmap.mockImplementation(() => Promise.reject(new Error('tainted')));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    dv.setDelay(100);
    for (let i = 0; i < 30; i++) {
      frame(0);
      await flush();
    }
    expect(dv.state).toBe('failed');
    expect(canvas()).toBeNull();
    expect(states.at(-1)).toBe('failed');
  });

  it('turning the delay off waits until the audio change takes effect', () => {
    vi.useFakeTimers();
    try {
      const dv = new DelayedVideo(video);
      dv.setDelay(100);
      dv.setDelay(0, performance.now() + 40);
      expect(dv.state).not.toBe('off');
      vi.advanceTimersByTime(41);
      expect(dv.state).toBe('off');
      expect(canvas()).toBeNull();
      dv.setDelay(100);
      dv.setDelay(0, performance.now() + 40);
      dv.setDelay(80); // a new delay cancels the pending stop
      vi.advanceTimersByTime(100);
      expect(dv.state).not.toBe('off');
      dv.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('destroy removes the canvas and listeners', () => {
    const dv = new DelayedVideo(video);
    dv.setDelay(100);
    dv.destroy();
    expect(canvas()).toBeNull();
    expect(removeSpy).toHaveBeenCalledWith('seeking', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('emptied', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('loadstart', expect.any(Function));
    dv.setDelay(100); // no-op after destroy
    expect(canvas()).toBeNull();
  });

  describe('pause / seek (SRI-208)', () => {
    let now: number;
    const trace = vi.fn();
    const mk = () => {
      now = 1000;
      vi.spyOn(performance, 'now').mockImplementation(() => now);
      trace.mockClear();
      const dv = new DelayedVideo(video, () => {}, { trace, setOverlayInfo: () => {}, overlayReset: () => {}, overlayFrame: () => {} } as never);
      dv.setDelay(500, 0);
      return dv;
    };

    it('pause freezes the queue; playing shifts due by the pause length', async () => {
      const dv = mk();
      frame(1400); // due 1900
      await flush();
      video.dispatchEvent(new Event('pause'));
      expect(trace).toHaveBeenCalledWith('hold', expect.objectContaining({ queue: 1, delay: 500 }));
      now = 2500;
      rafCb!(2500); // long past due
      expect(dv.stats.queued).toBe(1);
      expect(dv.stats.drawn).toBe(0);
      expect(dv.presentedBusy()).toBe(false);
      now = 3000;
      video.dispatchEvent(new Event('playing'));
      expect(trace).toHaveBeenCalledWith('release', expect.objectContaining({ shiftMs: 2000, queue: 1 }));
      rafCb!(3800); // due is now 3900
      expect(dv.stats.drawn).toBe(0);
      rafCb!(3900);
      expect(dv.stats.drawn).toBe(1);
    });

    it('first frame after a seek is drawn at the next rAF regardless of its due', async () => {
      const dv = mk();
      video.dispatchEvent(new Event('seeking'));
      frame(1e9);
      await flush();
      rafCb!(1016);
      expect(dv.stats.drawn).toBe(1);
      frame(1e9 + 50); // later frames keep the delay
      await flush();
      rafCb!(1032);
      expect(dv.stats.drawn).toBe(1);
      expect(dv.stats.queued).toBe(1);
    });

    it('seek while paused draws the still and stays held', async () => {
      const dv = mk();
      video.dispatchEvent(new Event('pause'));
      video.dispatchEvent(new Event('seeking'));
      frame(1e9);
      await flush();
      rafCb!(1016);
      expect(dv.stats.drawn).toBe(1);
      frame(1e9 + 10); // a normal frame stays frozen
      await flush();
      now = 1e10;
      rafCb!(1e10);
      expect(dv.stats.drawn).toBe(1);
      expect(dv.stats.queued).toBe(1);
    });

    it('starts held when the video is already paused', async () => {
      paused = true;
      const dv = mk();
      expect(dv.state).toBe('waiting');
      video.dispatchEvent(new Event('playing'));
      expect(trace).toHaveBeenCalledWith('release', expect.anything());
    });

    it('delay 0 during a pause still stops at its effective time', () => {
      vi.useFakeTimers();
      try {
        const dv = mk();
        video.dispatchEvent(new Event('pause'));
        dv.setDelay(0, now + 40);
        expect(dv.state).not.toBe('off');
        vi.advanceTimersByTime(41);
        expect(dv.state).toBe('off');
      } finally {
        vi.useRealTimers();
      }
    });

    it('destroy removes the pause, ended and playing listeners', () => {
      const dv = mk();
      dv.destroy();
      for (const e of ['pause', 'ended', 'playing']) expect(removeSpy).toHaveBeenCalledWith(e, expect.any(Function));
    });
  });
});
