import { afterEach, describe, expect, it, vi } from 'vitest';
import { Compare } from './compare';

describe('Compare', () => {
  afterEach(() => vi.useRealTimers());

  it('is on while held and off when released, and tells its owner once per change', () => {
    const onChange = vi.fn();
    const c = new Compare(onChange);
    c.set(true);
    c.set(true);
    expect(c.active).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    c.set(false);
    expect(c.active).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('lets go by itself when the popup stops saying it is held', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const c = new Compare(onChange, 800);
    c.set(true);
    vi.advanceTimersByTime(600);
    c.set(true); // still held: the timer restarts
    vi.advanceTimersByTime(600);
    expect(c.active).toBe(true);
    vi.advanceTimersByTime(300);
    expect(c.active).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
