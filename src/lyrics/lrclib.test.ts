import { describe, expect, it, vi } from 'vitest';
import { findLyrics } from './lrclib';
import type { TrackInfo } from './types';

const track: TrackInfo = { videoId: 'v', title: 'Yellow (Official Video)', artist: 'Coldplay - Topic', duration: 269.4 };
const SYNCED = '[00:01.00] x\n[00:02.00] y\n[00:03.00] z\n[00:04.00] w';
const PLAIN = 'x\ny\nz\nw';
const record = { id: 7, trackName: 'Yellow', artistName: 'Coldplay', duration: 269, syncedLyrics: SYNCED, plainLyrics: PLAIN };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('findLyrics', () => {
  it('uses /get with cleaned names and rounded duration', async () => {
    const f = vi.fn().mockResolvedValue(json(record));
    const res = await findLyrics(track, f as unknown as typeof fetch);
    expect(res?.synced).toBe(SYNCED);
    expect(f).toHaveBeenCalledTimes(1);
    const url = new URL(f.mock.calls[0][0] as string);
    expect(url.pathname).toBe('/api/get');
    expect(url.searchParams.get('track_name')).toBe('Yellow');
    expect(url.searchParams.get('artist_name')).toBe('Coldplay');
    expect(url.searchParams.get('duration')).toBe('269');
    expect(f.mock.calls[0][1]).toEqual({ signal: expect.any(AbortSignal) }); // no custom headers
  });

  it('falls back to /search on 404 and picks the best', async () => {
    const f = vi.fn((u: string) =>
      Promise.resolve(
        u.includes('/get?') ? json({}, 404) : json([{ ...record, id: 1, duration: 400 }, { ...record, id: 2 }]),
      ),
    );
    const res = await findLyrics(track, f as unknown as typeof fetch);
    expect(res?.record.id).toBe(2);
  });

  it('skips a placeholder exact match and uses /search', async () => {
    const junk = { ...record, id: 9, syncedLyrics: '[00:00.00]probe', plainLyrics: 'probe' };
    const f = vi.fn((u: string) => Promise.resolve(u.includes('/get?') ? json(junk) : json([junk, { ...record, id: 2 }])));
    const res = await findLyrics(track, f as unknown as typeof fetch);
    expect(res?.record.id).toBe(2);
  });

  it('tries the q search when the structured search is empty', async () => {
    const f = vi.fn((u: string) => Promise.resolve(u.includes('q=') ? json([record]) : json(u.includes('/get?') ? {} : [], u.includes('/get?') ? 404 : 200)));
    const res = await findLyrics(track, f as unknown as typeof fetch);
    expect(res?.record.id).toBe(7);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('returns null when nothing is found', async () => {
    const f = vi.fn((u: string) => Promise.resolve(u.includes('/get?') ? json({}, 404) : json([])));
    expect(await findLyrics(track, f as unknown as typeof fetch)).toBeNull();
  });

  it('returns plain lyrics when only those exist', async () => {
    const plainRec = { ...record, syncedLyrics: null };
    const f = vi.fn((u: string) => Promise.resolve(json(u.includes('/get?') ? plainRec : [plainRec])));
    const res = await findLyrics(track, f as unknown as typeof fetch);
    expect(res?.synced).toBeUndefined();
    expect(res?.plain).toBe(PLAIN);
  });

  it('aborts after the timeout', async () => {
    vi.useFakeTimers();
    const f = vi.fn((_u: string, init: RequestInit) => new Promise((_, rej) => init.signal!.addEventListener('abort', () => rej(new Error('aborted')))));
    const p = findLyrics(track, f as unknown as typeof fetch).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(8000 * 3 + 10);
    expect(await p).toBeInstanceOf(Error);
    vi.useRealTimers();
  });
});

// Real network; run with LRCLIB_LIVE=1.
describe.skipIf(!process.env.LRCLIB_LIVE)('live LRCLIB', () => {
  it('finds Coldplay – Yellow', async () => {
    const res = await findLyrics({ videoId: 'x', title: 'Yellow', artist: 'Coldplay', duration: 269 });
    console.log('live synced length', res?.synced?.length);
    expect(res?.synced).toBeTruthy();
  });
});
