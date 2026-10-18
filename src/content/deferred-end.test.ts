import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferEnd } from './deferred-end';

describe('deferEnd', () => {
  let video: HTMLVideoElement;
  let seen: string[];
  let off: () => void;
  let delay: number;
  let waits: boolean[];

  beforeEach(() => {
    vi.useFakeTimers();
    video = document.createElement('video');
    document.body.append(video);
    Object.defineProperty(video, 'ended', { value: true, configurable: true });
    seen = [];
    delay = 2000;
    waits = [];
    for (const e of ['pause', 'ended']) video.addEventListener(e, () => seen.push(e));
    off = deferEnd(() => video, () => delay, (w) => waits.push(w));
  });
  afterEach(() => {
    off();
    video.remove();
    vi.useRealTimers();
  });

  const end = () => {
    video.dispatchEvent(new Event('pause'));
    video.dispatchEvent(new Event('ended'));
  };

  it('holds pause and ended back until the delay has passed', () => {
    end();
    vi.advanceTimersByTime(1999);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual(['pause', 'ended']);
    expect(waits).toEqual([true, false]);
  });

  it('passes them straight through without a delay', () => {
    delay = 0;
    end();
    expect(seen).toEqual(['pause', 'ended']);
  });

  it('drops the held end when the user seeks back', () => {
    end();
    video.dispatchEvent(new Event('seeking'));
    vi.advanceTimersByTime(5000);
    expect(seen).toEqual([]);
    expect(waits).toEqual([true, false]);
  });

  it('does not touch an ordinary pause', () => {
    Object.defineProperty(video, 'ended', { value: false, configurable: true });
    video.dispatchEvent(new Event('pause'));
    expect(seen).toEqual(['pause']);
  });
});
