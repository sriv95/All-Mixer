import { describe, expect, it, vi } from 'vitest';
import { applyBadge, badgeFor } from './badge';

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
