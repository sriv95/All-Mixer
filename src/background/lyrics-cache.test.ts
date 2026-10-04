import { describe, expect, it, vi } from 'vitest';
import { LyricsCache } from './lyrics-cache';
import type { TrackInfo } from '../lyrics/types';

function memArea() {
  const d: Record<string, unknown> = {};
  return {
    d,
    get: async (k: string | null) => (k === null ? { ...d } : k in d ? { [k]: d[k] } : {}),
    set: async (o: Record<string, unknown>) => void Object.assign(d, o),
    remove: async (ks: string[]) => void ks.forEach((k) => delete d[k]),
  };
}
const t = (id: string): TrackInfo => ({ videoId: id, title: 'a', artist: 'b', duration: 1 });
const found = { synced: 's', record: { id: 1, trackName: 'a', artistName: 'b', duration: 1 } };

describe('LyricsCache', () => {
  it('caches hits and negatives, not errors', async () => {
    const area = memArea();
    const c = new LyricsCache(area as never);
    const load = vi.fn().mockResolvedValue(found);
    await c.getOrFetch(t('a'), load);
    await c.getOrFetch(t('a'), load);
    expect(load).toHaveBeenCalledTimes(1);
    const bad = vi.fn().mockRejectedValue(new Error('net'));
    await expect(c.getOrFetch(t('b'), bad)).rejects.toThrow();
    expect(await c.lookup('b')).toEqual({ hit: false, found: null });
  });
  it('expires negative results after a day', async () => {
    let now = 0;
    const c = new LyricsCache(memArea() as never, () => now);
    const load = vi.fn().mockResolvedValue(null);
    await c.getOrFetch(t('a'), load);
    now = 23 * 3600e3;
    await c.getOrFetch(t('a'), load);
    expect(load).toHaveBeenCalledTimes(1);
    now = 25 * 3600e3;
    await c.getOrFetch(t('a'), load);
    expect(load).toHaveBeenCalledTimes(2);
  });
  it('caps at 300 dropping oldest', async () => {
    let now = 0;
    const area = memArea();
    const c = new LyricsCache(area as never, () => now++);
    for (let i = 0; i < 302; i++) await c.store(`v${i}`, found);
    const keys = Object.keys(area.d);
    expect(keys.length).toBe(300);
    expect(keys).not.toContain('lyrics:v0');
    expect(keys).toContain('lyrics:v301');
  });
});

describe('LyricsCache in-flight', () => {
  it('shares one fetch between concurrent requests for the same video', async () => {
    const c = new LyricsCache(memArea() as never);
    const load = vi.fn().mockResolvedValue(found);
    const [a, b] = await Promise.all([c.getOrFetch(t('a'), load), c.getOrFetch(t('a'), load)]);
    expect(a).toEqual(found);
    expect(b).toEqual(found);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
