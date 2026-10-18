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

  it('stops on pause', () => {
    fire('seeking');
    fire('playing');
    fire('pause');
    expect(waits).toEqual([true, false]);
    vi.advanceTimersByTime(5000);
    expect(waits).toEqual([true, false]);
  });
});
