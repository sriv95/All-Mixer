import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAUSE_REQUEST_EVENT } from '../shared/bridge';
import { WarmupHold } from './warmup-hold';

describe('WarmupHold', () => {
  let video: HTMLVideoElement;
  let hold: WarmupHold;
  let seen: string[];
  let userPaused: number;
  let paused: boolean;

  beforeEach(() => {
    vi.useFakeTimers();
    video = document.createElement('video');
    document.body.append(video);
    paused = false;
    Object.defineProperty(video, 'paused', { get: () => paused, configurable: true });
    // Like a browser: pause() queues the event.
    video.pause = () => {
      paused = true;
      queueMicrotask(() => video.dispatchEvent(new Event('pause')));
    };
    video.play = () => {
      paused = false;
      video.dispatchEvent(new Event('play'));
      video.dispatchEvent(new Event('playing'));
      return Promise.resolve();
    };
    seen = [];
    userPaused = 0;
    for (const e of ['pause', 'play', 'playing']) video.addEventListener(e, () => seen.push(e));
    hold = new WarmupHold(() => video, () => userPaused++);
  });
  afterEach(() => {
    hold.destroy();
    video.remove();
    vi.useRealTimers();
  });

  it('pauses without the player seeing a pause, and resumes with play', async () => {
    hold.hold();
    await Promise.resolve();
    expect(paused).toBe(true);
    expect(hold.active).toBe(true);
    expect(seen).toEqual([]);
    hold.release();
    expect(paused).toBe(false);
    expect(seen).toEqual(['play', 'playing']);
    expect(hold.active).toBe(false);
  });

  it('only swallows its own pause', async () => {
    hold.hold();
    await Promise.resolve();
    video.dispatchEvent(new Event('pause'));
    expect(seen).toEqual(['pause']);
  });

  it('leaves a video that is not playing alone', () => {
    paused = true;
    hold.hold();
    expect(hold.active).toBe(false);
    hold.release();
    expect(seen).toEqual([]);
  });

  it('a pause click during the hold shows the pause and keeps the video paused after the warm-up', async () => {
    hold.hold();
    await Promise.resolve();
    video.dispatchEvent(new Event(PAUSE_REQUEST_EVENT));
    expect(seen).toEqual(['pause']);
    expect(userPaused).toBe(1);
    hold.release();
    expect(paused).toBe(true);
  });
});
