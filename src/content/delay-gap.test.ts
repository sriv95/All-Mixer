import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchDelayGap } from './delay-gap';

describe('watchDelayGap', () => {
  let video: HTMLVideoElement;
  let waits: boolean[];
  let delay: number;
  let off: () => void;
  const fire = (type: string) => video.dispatchEvent(new Event(type));

  beforeEach(() => {
    vi.useFakeTimers();
    video = document.createElement('video');
    document.body.append(video);
    waits = [];
    delay = 2000;
    off = watchDelayGap(() => video, () => delay, (w) => waits.push(w));
  });
  afterEach(() => {
    off();
    video.remove();
    vi.useRealTimers();
  });

  it('waits one delay after playback resumes from a seek', () => {
    fire('seeking');
    fire('playing');
    expect(waits).toEqual([true]);
    vi.advanceTimersByTime(2000);
    expect(waits).toEqual([true, false]);
  });

  it('does not wait when resuming from a plain pause', () => {
    fire('pause');
    fire('playing');
    expect(waits).toEqual([]);
  });

  it('does not wait without a delay', () => {
    delay = 0;
    fire('seeking');
    fire('playing');
    expect(waits).toEqual([]);
  });

  it('stops on pause and shows the rest of the gap on play', () => {
    fire('seeking');
    fire('playing');
    vi.advanceTimersByTime(500);
    fire('pause');
    expect(waits).toEqual([true, false]);
    vi.advanceTimersByTime(5000);
    expect(waits).toEqual([true, false]);
    fire('playing');
    expect(waits).toEqual([true, false, true]);
    vi.advanceTimersByTime(1499);
    expect(waits).toEqual([true, false, true]);
    vi.advanceTimersByTime(1);
    expect(waits).toEqual([true, false, true, false]);
  });
});
