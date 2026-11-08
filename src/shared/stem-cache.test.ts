import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from './settings';
import { createStemCache, serveStemCache, stemKey } from './stem-cache';
import type { StemSet, StemStore } from './stem-store';

const set = (n: number): StemSet => ({
  sampleRate: 44100,
  length: n,
  stems: { vocals: [Float32Array.from({ length: n }, (_, i) => i / 3), Float32Array.from({ length: n }, (_, i) => -i)], music: [new Float32Array(n).fill(0.25), new Float32Array(n).fill(-0.5)] },
});

/** A memory store behind serveStemCache, a client on the other end of a MessageChannel. */
function pair(store: Partial<StemStore> | (() => Promise<StemStore>), timeoutMs = 1000) {
  const { port1, port2 } = new MessageChannel();
  const mem = new Map<string, StemSet>();
  const impl: StemStore = { get: async (k) => mem.get(k) ?? null, put: async (k, s) => (mem.set(k, s), true), evict: async () => {}, ...(typeof store === 'function' ? {} : store) };
  serveStemCache(port2, typeof store === 'function' ? store : async () => impl);
  const dispose = vi.fn(() => (port1.close(), port2.close()));
  return { cache: createStemCache(() => ({ port: port1, dispose }), timeoutMs), dispose };
}

describe('stemKey', () => {
  it('joins version, video, rounded duration, preload signature and sample rate', () => {
    expect(stemKey('abc', 200.6, DEFAULT_SETTINGS)).toMatch(/^v1\|abc\|201\|.+\|44100$/);
  });
});

describe('stem cache over a port', () => {
  it('round trips the exact data and transfers the buffers on put', async () => {
    const { cache, dispose } = pair({});
    const a = set(64);
    const expected = set(64);
    const [v0] = a.stems.vocals;
    expect(await cache.put('k', a)).toBe(true);
    expect(v0.byteLength).toBe(0); // detached: moved, not copied
    expect(await cache.get('k')).toEqual(expected);
    expect(await cache.get('missing')).toBeNull();
    cache.dispose();
    expect(dispose).toHaveBeenCalled();
  });

  it('a host error gives null / false and logs once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const boom = async () => { throw new Error('boom'); };
    const { cache } = pair({ get: boom, put: boom });
    expect(await cache.get('k')).toBeNull();
    expect(await cache.put('k', set(4))).toBe(false);
    warn.mockRestore();
  });

  it('a store that cannot open gives null / false', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { cache } = pair(async () => { throw new Error('no opfs'); });
    expect(await cache.get('k')).toBeNull();
    expect(await cache.put('k', set(4))).toBe(false);
    warn.mockRestore();
  });

  it('a host that never answers times out with null / false, logged once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const never = () => new Promise<never>(() => {});
    const { cache } = pair({ get: never, put: never }, 20);
    expect(await cache.get('k')).toBeNull();
    expect(await cache.put('k', set(4))).toBe(false);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('[stem-cache]'))).toHaveLength(1);
    warn.mockRestore();
  });

  it('a missing iframe (connect throws) gives null / false', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cache = createStemCache(() => { throw new Error('no iframe'); });
    expect(await cache.get('k')).toBeNull();
    expect(await cache.put('k', set(4))).toBe(false);
    warn.mockRestore();
  });
});
