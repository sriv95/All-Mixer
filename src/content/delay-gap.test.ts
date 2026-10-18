import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchDelayGap } from './delay-gap';

describe('watchDelayGap', () => {
  let video: HTMLVideoElement;
  let waits: boolean[];
  let delay: number;
  let off: () => void;
  let sound: (() => void) | null;
  let armed: number;
  const fire = (type: string) => video.dispatchEvent(new Event(type));

  beforeEach(() => {
    vi.useFakeTimers();
    video = document.createElement('video');
    document.body.append(video);
    Object.defineProperty(video, 'paused', { value: false, configurable: true });
    waits = [];
    delay = 2000;
    sound = null;
    armed = 0;
    off = watchDelayGap(
      () => video,
      () => delay,
      (cb) => {
        armed++;
        sound = cb;
        return () => (sound = null);
      },
      (w) => waits.push(w),
    );
  });
  afterEach(() => {
    off();
    video.remove();
    vi.useRealTimers();
  });

  it('shows from the seek, over the loading, until the sound is out', () => {
    fire('seeking');
    expect(waits).toEqual([true]);
    fire('playing');
    expect(armed).toBe(1);
    expect(waits).toEqual([true, true]);
    sound!();
    expect(waits).toEqual([true, true, false]);
  });

  it('waits for play when the seek happened on a paused video', () => {
    Object.defineProperty(video, 'paused', { value: true, configurable: true });
    fire('seeking');
    expect(waits).toEqual([false]);
    fire('playing');
    expect(waits).toEqual([false, true]);
    sound!();
    expect(waits.at(-1)).toBe(false);
  });

  it('does nothing for a plain pause and play', () => {
    fire('pause');
    fire('playing');
    expect(waits).toEqual([]);
    expect(armed).toBe(0);
  });

  it('does nothing without a delay', () => {
    delay = 0;
    fire('seeking');
    fire('playing');
    expect(waits).toEqual([false]);
    expect(armed).toBe(0);
  });

  it('hides on pause and comes back on play while the sound is missing', () => {
    fire('seeking');
    fire('playing');
    fire('pause');
    expect(waits.at(-1)).toBe(false);
    fire('playing');
    expect(waits.at(-1)).toBe(true);
    expect(armed).toBe(1); // still the same wait
    sound!();
    expect(waits.at(-1)).toBe(false);
  });

  it('gives up when the sound never reports', () => {
    fire('seeking');
    fire('playing');
    vi.advanceTimersByTime(2000 + 5000);
    expect(waits.at(-1)).toBe(false);
  });
});
