import { describe, expect, it, vi } from 'vitest';
import { Backoff, RateLimited } from './backoff';
import { findLrcmuxLyrics } from './lrcmux';
import { LyricsCache } from '../background/lyrics-cache';
import type { TrackInfo } from './types';

const track: TrackInfo = { videoId: 'v', title: 'Shape of You', artist: 'Ed Sheeran', duration: 234 };
const LRC = '[00:09.85] The club isn\'t the best place to find a lover\n[00:12.17] So the bar is where I go\n[00:14.98] Me and my friends at the table\n[00:17.16] Drinking fast and then we talk slow';
const rec = (over: object = {}) => ({ id: 0, trackName: 'Shape of You', artistName: 'Ed Sheeran', duration: 233, instrumental: false, syncedLyrics: LRC, plainLyrics: 'The club isn\'t the best place to find a lover\nSo the bar is where I go\nMe and my friends at the table\nDrinking fast and then we talk slow', ...over });
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const asFetch = (f: unknown) => f as typeof fetch;

describe('findLrcmuxLyrics', () => {
  it('returns synced and plain lyrics from the LRCLIB-compatible route', async () => {
    const f = vi.fn().mockResolvedValue(json(rec()));
    const found = await findLrcmuxLyrics({ ...track, album: 'Divide' }, asFetch(f), new Backoff());
    expect(found?.synced).toContain('[00:09.85]');
    expect(found?.plain).toContain('So the bar');
    const url = new URL(f.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe('https://api.lrcmux.dev/compat/lrclib/api/get');
    expect(Object.fromEntries(url.searchParams)).toEqual({ track_name: 'Shape of You', artist_name: 'Ed Sheeran', duration: '234', album_name: 'Divide' });
  });

  it('returns plain-only lyrics', async () => {
    const f = vi.fn().mockResolvedValue(json(rec({ syncedLyrics: null })));
    const found = await findLrcmuxLyrics(track, asFetch(f), new Backoff());
    expect(found?.synced).toBeUndefined();
    expect(found?.plain).toBeTruthy();
  });

  it('treats a 404 as a miss', async () => {
    const f = vi.fn().mockResolvedValue(json({ detail: 'no lyrics found' }, 404));
    expect(await findLrcmuxLyrics(track, asFetch(f), new Backoff())).toBeNull();
  });

  it('rejects a wrong song', async () => {
    const f = vi.fn().mockResolvedValue(json(rec({ trackName: 'Completely Different Tune', artistName: 'Someone Else' })));
    expect(await findLrcmuxLyrics(track, asFetch(f), new Backoff())).toBeNull();
    const far = vi.fn().mockResolvedValue(json(rec({ duration: 600 })));
    expect(await findLrcmuxLyrics(track, asFetch(far), new Backoff())).toBeNull();
  });

  it('throws other HTTP errors without a cooldown', async () => {
    const f = vi.fn().mockResolvedValue(json({}, 500));
    const backoff = new Backoff();
    await expect(findLrcmuxLyrics(track, asFetch(f), backoff)).rejects.toThrow('HTTP 500');
    expect(() => backoff.check()).not.toThrow();
  });

  it('429 throws RateLimited (the caller skips to the next source); the cooldown blocks calls until Retry-After passes', async () => {
    let now = 1000;
    const backoff = new Backoff(() => now);
    const f = vi.fn().mockResolvedValueOnce(json({}, 429, { 'Retry-After': '30' })).mockResolvedValue(json(rec()));
    await expect(findLrcmuxLyrics(track, asFetch(f), backoff)).rejects.toBeInstanceOf(RateLimited);
    now += 29_000;
    await expect(findLrcmuxLyrics(track, asFetch(f), backoff)).rejects.toBeInstanceOf(RateLimited);
    expect(f).toHaveBeenCalledTimes(1);
    now += 2_000;
    expect((await findLrcmuxLyrics(track, asFetch(f), backoff))?.synced).toBeTruthy();
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('cools down 60 seconds without Retry-After', async () => {
    let now = 0;
    const backoff = new Backoff(() => now, 60_000);
    const f = vi.fn().mockResolvedValue(json({}, 429));
    await expect(findLrcmuxLyrics(track, asFetch(f), backoff)).rejects.toBeInstanceOf(RateLimited);
    now = 59_000;
    expect(() => backoff.check()).toThrow(RateLimited);
    now = 61_000;
    expect(() => backoff.check()).not.toThrow();
  });

  it('the per-track cache prevents a second fetch, and a rate limit is not cached', async () => {
    const d: Record<string, unknown> = {};
    const area = {
      get: async (k: string | null) => (k === null ? { ...d } : k in d ? { [k]: d[k] } : {}),
      set: async (o: Record<string, unknown>) => void Object.assign(d, o),
      remove: async (ks: string[]) => void ks.forEach((k) => delete d[k]),
    };
    const cache = new LyricsCache<unknown>(area as never, Date.now, 'lrcmux-lyrics:');
    const f = vi.fn().mockResolvedValueOnce(json({}, 429)).mockResolvedValue(json(rec()));
    const backoff = new Backoff(() => 0);
    const load = (t: TrackInfo) => findLrcmuxLyrics(t, asFetch(f), backoff);
    await expect(cache.getOrFetch(track, load)).rejects.toBeInstanceOf(RateLimited);
    expect(await cache.lookup('v')).toEqual({ hit: false, found: null });
    const fresh = new Backoff();
    const load2 = (t: TrackInfo) => findLrcmuxLyrics(t, asFetch(f), fresh);
    await cache.getOrFetch(track, load2);
    await cache.getOrFetch(track, load2);
    expect(f).toHaveBeenCalledTimes(2);
  });
});
