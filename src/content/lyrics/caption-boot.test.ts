import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptionBoot } from './caption-boot';

function setup(initial: 'on' | 'off' | null) {
  let state = initial;
  const toggle = vi.fn(() => {
    state = state === 'on' ? 'off' : 'on';
  });
  const onInitial = vi.fn();
  const boot = new CaptionBoot({ state: () => state, toggle, onInitial });
  return { boot, toggle, onInitial, setState: (s: 'on' | 'off' | null) => (state = s) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('CaptionBoot', () => {
  it('CC already on: does nothing', () => {
    const t = setup('on');
    t.boot.start('v1');
    expect(t.onInitial).toHaveBeenCalledWith(true);
    expect(t.toggle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20_000);
    expect(t.toggle).not.toHaveBeenCalled();
  });

  it('CC off: turns it on, then off again after the captions loaded', () => {
    const t = setup('off');
    t.boot.start('v1');
    expect(t.onInitial).toHaveBeenCalledWith(false);
    expect(t.toggle).toHaveBeenCalledTimes(1);
    expect(t.boot.isOwnChange()).toBe(true);
    t.boot.captionsLoaded('v1');
    vi.advanceTimersByTime(1600);
    expect(t.toggle).toHaveBeenCalledTimes(2);
  });

  it('start again (mode toggle) with CC off: turns CC on once more and back off; restoringOff is true in between', () => {
    const t = setup('off');
    t.boot.start('v1');
    expect(t.boot.restoringOff).toBe(true);
    t.boot.captionsLoaded('v1');
    vi.advanceTimersByTime(1600);
    expect(t.boot.restoringOff).toBe(false);
    expect(t.toggle).toHaveBeenCalledTimes(2);
    t.boot.start('v1');
    expect(t.toggle).toHaveBeenCalledTimes(3);
    t.boot.captionsLoaded('v1');
    vi.advanceTimersByTime(1600);
    expect(t.toggle).toHaveBeenCalledTimes(4);
  });

  it('CC off and no captions event: turns it off after the fallback time', () => {
    const t = setup('off');
    t.boot.start('v1');
    vi.advanceTimersByTime(10_100);
    expect(t.toggle).toHaveBeenCalledTimes(2);
  });

  it('waits for the CC button to be ready', () => {
    const t = setup(null);
    t.boot.start('v1');
    vi.advanceTimersByTime(900);
    expect(t.onInitial).not.toHaveBeenCalled();
    t.setState('off');
    vi.advanceTimersByTime(400);
    expect(t.onInitial).toHaveBeenCalledWith(false);
  });

  it('a user press after our own window ends the boot: CC stays on', () => {
    const t = setup('off');
    t.boot.start('v1');
    vi.advanceTimersByTime(2500);
    t.boot.userToggled();
    t.boot.captionsLoaded('v1');
    vi.advanceTimersByTime(20_000);
    expect(t.toggle).toHaveBeenCalledTimes(1);
  });

  it('ignores captions of another video', () => {
    const t = setup('off');
    t.boot.start('v1');
    t.boot.captionsLoaded('v2');
    vi.advanceTimersByTime(1600);
    expect(t.toggle).toHaveBeenCalledTimes(1);
  });
});
