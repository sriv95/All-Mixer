import { afterEach, describe, expect, it, vi } from 'vitest';
import { Badges, applyBadge, badgeFor } from './badge';

describe('badgeFor', () => {
  it('shows no badge when idle', () => {
    expect(badgeFor({ kind: 'off' }).text).toBe('');
  });
  it('shows dots while warming up, ON while live, ! on a stop', () => {
    expect(badgeFor({ kind: 'warming' }).text).toBe('···');
    expect(badgeFor({ kind: 'live', delayS: '1.9' })).toMatchObject({ text: 'ON', title: 'All Mixer!: separating, 1.9 s delay' });
    for (const kind of ['unavailable', 'stopped', 'error'] as const) {
      expect(badgeFor({ kind, cause: 'device too slow' })).toMatchObject({ text: '!', title: 'All Mixer!: separation stopped, device too slow' });
    }
  });
});

describe('applyBadge', () => {
  it('sets the badge for that tab only', async () => {
    const action = { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn(), setBadgeTextColor: vi.fn(), setTitle: vi.fn() };
    await applyBadge(7, { kind: 'live', delayS: '2.0' }, action as unknown as typeof chrome.action);
    expect(action.setBadgeText).toHaveBeenCalledWith({ tabId: 7, text: 'ON' });
    expect(action.setTitle).toHaveBeenCalledWith({ tabId: 7, title: 'All Mixer!: separating, 2.0 s delay' });
  });
});

describe('Badges', () => {
  const fakeAction = () => ({ setBadgeText: vi.fn().mockResolvedValue(undefined), setBadgeBackgroundColor: vi.fn(), setBadgeTextColor: vi.fn(), setTitle: vi.fn() });
  const texts = (a: ReturnType<typeof fakeAction>) => a.setBadgeText.mock.calls.map((c) => c[0].text);
  afterEach(() => vi.useRealTimers());

  it('cycles the dots while warming up and stops when the state changes', () => {
    vi.useFakeTimers();
    const a = fakeAction();
    const badges = new Badges(a as unknown as typeof chrome.action, 400);
    void badges.set(7, { kind: 'warming' });
    vi.advanceTimersByTime(1200);
    expect(texts(a)).toEqual(['·', '··', '···', '·']);
    void badges.set(7, { kind: 'live', delayS: '1.9' });
    vi.advanceTimersByTime(2000);
    expect(texts(a).at(-1)).toBe('ON');
    expect(texts(a)).toHaveLength(5);
  });

  it('clear stops the dots, and a tab that is gone stops them too', async () => {
    vi.useFakeTimers();
    const a = fakeAction();
    const badges = new Badges(a as unknown as typeof chrome.action, 400);
    void badges.set(7, { kind: 'warming' });
    badges.clear(7);
    vi.advanceTimersByTime(2000);
    expect(texts(a)).toEqual(['·']);
    a.setBadgeText.mockRejectedValue(new Error('No tab with id: 8'));
    badges.set(8, { kind: 'warming' }).catch(() => {}); // the first write rejects too; the handler logs it
    await vi.advanceTimersByTimeAsync(400); // the first frame after set fails: the timer clears itself
    const calls = texts(a).length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(texts(a)).toHaveLength(calls);
  });
});
