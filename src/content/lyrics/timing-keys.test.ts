import { afterEach, describe, expect, it, vi } from 'vitest';
import { showToast, timingKeyDelta } from './timing-keys';

const key = (key: string, over: Partial<Parameters<typeof timingKeyDelta>[0]> = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, target: document.body, ...over });

describe('timingKeyDelta', () => {
  it('] is +100, [ is -100, other keys 0', () => {
    expect(timingKeyDelta(key(']'))).toBe(100);
    expect(timingKeyDelta(key('['))).toBe(-100);
    expect(timingKeyDelta(key('a'))).toBe(0);
  });

  it('ignores modifier combinations and text fields', () => {
    expect(timingKeyDelta(key(']', { ctrlKey: true }))).toBe(0);
    expect(timingKeyDelta(key(']', { metaKey: true }))).toBe(0);
    expect(timingKeyDelta(key(']', { altKey: true }))).toBe(0);
    expect(timingKeyDelta(key(']', { target: document.createElement('input') }))).toBe(0);
    expect(timingKeyDelta(key(']', { target: document.createElement('textarea') }))).toBe(0);
    const div = document.createElement('div');
    Object.defineProperty(div, 'isContentEditable', { value: true });
    expect(timingKeyDelta(key(']', { target: div }))).toBe(0);
  });
});

describe('showToast', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it('shows one message, replaces it, and removes it after a moment', () => {
    vi.useFakeTimers();
    showToast('a');
    showToast('b');
    const all = document.querySelectorAll('[data-allmixer-toast]');
    expect(all).toHaveLength(1);
    expect(all[0].textContent).toBe('b');
    vi.advanceTimersByTime(1300);
    expect(document.querySelector('[data-allmixer-toast]')).toBeNull();
  });
});
