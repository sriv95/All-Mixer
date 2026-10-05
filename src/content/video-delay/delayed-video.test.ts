import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DelayedVideo } from './delayed-video';

type Vfc = (now: number, md: { expectedDisplayTime: number; mediaTime: number }) => void;

let video: HTMLVideoElement;
let vfcCb: Vfc | null;
let rafCb: ((t: number) => void) | null;
let createBitmap: ReturnType<typeof vi.fn>;
let closed: number;
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

afterEach(() => vi.unstubAllGlobals());

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
    dv.setDelay(100); // no-op after destroy
    expect(canvas()).toBeNull();
  });
});
