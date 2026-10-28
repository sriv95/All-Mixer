import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../shared/settings';
import { PreloadRunner, videoKey } from './preload-run';

const videoOf = (duration: number) => {
  const v = document.createElement('video');
  Object.defineProperty(v, 'duration', { value: duration });
  return v;
};
const runner = (o: { site?: 'youtube' | 'generic'; video?: HTMLMediaElement | null; exporting?: boolean } = {}) => {
  const onChange = vi.fn();
  const r = new PreloadRunner({ site: o.site ?? 'youtube', video: () => (o.video === undefined ? videoOf(200) : o.video), onChange, exporting: () => o.exporting ?? false });
  return { r, onChange };
};

beforeEach(() => {
  vi.stubGlobal('chrome', { runtime: { getURL: (p: string) => `chrome-extension://x/${p}` } });
});

describe('videoKey', () => {
  it('is the v= id on YouTube and YouTube Music, else the address', () => {
    expect(videoKey('https://www.youtube.com/watch?v=abc&t=5')).toBe('abc');
    expect(videoKey('https://music.youtube.com/watch?v=xyz&list=L')).toBe('xyz');
    expect(videoKey('https://example.com/clip')).toBe('https://example.com/clip');
  });
});

describe('PreloadRunner', () => {
  it('starts idle: no cache, nothing running', () => {
    const { r } = runner();
    expect(r.status(DEFAULT_SETTINGS)).toEqual({ state: 'idle' });
    expect(r.running).toBe(false);
    expect(r.ready()).toBeNull();
  });

  it.each([
    ['an export is running', { exporting: true }, /export is running/],
    ['there is no video', { video: null }, /no video to preload/],
    ['a live stream', { video: videoOf(Infinity) }, /no fixed length/],
    ['a page that is not YouTube', { site: 'generic' as const }, /works on YouTube pages/],
    ['a video too long for the memory', { video: videoOf(3 * 3600) }, /too long to keep in memory with 2 stems/],
  ])('refuses to start when %s, and the status carries the reason', (_n, o, reason) => {
    const { r, onChange } = runner(o);
    const answer = r.start(DEFAULT_SETTINGS);
    expect(answer.ok).toBe(false);
    expect((answer as { error: string }).error).toMatch(reason);
    expect(r.running).toBe(false);
    const st = r.status(DEFAULT_SETTINGS);
    expect(st.state).toBe('error');
    expect(st.progress?.error).toMatch(reason);
    expect(st.tooBig === true).toBe(/too long/.test(String(reason)));
    expect(onChange).toHaveBeenCalled();
  });
});
