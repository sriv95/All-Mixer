import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LYRICS_PREFS } from '../shared/lyrics-prefs';
import { EXPORT_SAMPLE_RATE, defaultExportOptions } from '../shared/export';
import { DEFAULT_SETTINGS, type MixerSettings } from '../shared/settings';
import type { StemCache as PersistentCache } from '../shared/stem-cache';
import type { StemSet } from '../shared/stem-store';
import type { StemSlice } from '../export/mix';
import type { AudioTap } from '../export/fast-audio';

// Preload and Export share the persistent stem cache: the real engine, runners and a fake store; only the model is a fake.

const out = vi.hoisted(() => ({ audio: [] as { id: string; sum: number; n: number }[] }));
vi.mock('../export/encode', async (orig) => ({
  ...(await orig<typeof import('../export/encode')>()),
  mp3Sink: vi.fn(async () => ({
    addAudio: async (id: string, l: Float32Array) => void out.audio.push({ id, sum: l.reduce((a, x) => a + x, 0), n: l.length }),
    describe: () => 'fake',
    finish: async () => ({ name: 'x.mp3', blob: new Blob(['x']) }),
    cancel: async () => {},
  })),
}));
const tap = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock('./page-tap', () => ({ pageTap: async () => tap.value }));

import * as realEngine from '../export/engine';
import { ExportRunner } from './export-run';
import { PreloadRunner } from './preload-run';

const DUR = 20; // s, two chunks
const N = DUR * EXPORT_SAMPLE_RATE;
const pcm = { l: Float32Array.from({ length: N }, (_, i) => (i % 1000) / 1000), r: Float32Array.from({ length: N }, (_, i) => -(i % 1000) / 1000) };

/** A model that gives full slices: vocal, "vocal for the instrumental" and a guitar part. */
let sessions = 0;
const openSession = (async () => {
  sessions++;
  let start = 0;
  const scaled = (a: Float32Array, k: number) => a.map((x) => x * k);
  return {
    adapter: 'fake',
    dispose() {},
    separator: {
      backlog: 0,
      push: async (l: Float32Array, r: Float32Array): Promise<StemSlice> => {
        const s: StemSlice = {
          start,
          length: l.length,
          dry: [l, r],
          vk: [scaled(l, 0.5), scaled(r, 0.5)],
          vocal: [scaled(l, 0.25), scaled(r, 0.25)],
          parts: { guitar: [scaled(l, 0.1), scaled(r, 0.1)] },
        };
        start += l.length;
        return s;
      },
      finish: async () => null,
    },
  };
}) as unknown as realEngine.ExportDeps['openSession'];
const loadEngine = async () =>
  ({ ...realEngine, runPreload: (d, f) => realEngine.runPreload({ ...d, openSession }, f), runExport: (d) => realEngine.runExport({ ...d, openSession }) }) as typeof realEngine;

/** An in-memory store with the contract of the real one: it transfers (detaches) what it is given and hands out copies. */
function fakeCache(over: Partial<Pick<PersistentCache, 'get' | 'put'>> = {}) {
  const map = new Map<string, StemSet>();
  const store = {
    map,
    get: vi.fn(async (key: string) => (map.has(key) ? structuredClone(map.get(key)!) : null)),
    put: vi.fn(async (key: string, set: StemSet) => {
      const buffers = [...new Set(Object.values(set.stems).flatMap((c) => c.map((x) => x.buffer)))];
      map.set(key, structuredClone(set, { transfer: buffers }));
      return true;
    }),
    dispose: vi.fn(),
    ...over,
  };
  return store;
}

class FakeAudioBuffer {
  private readonly ch: Float32Array[];
  readonly length: number;
  constructor(o: { length: number; numberOfChannels: number }) {
    this.length = o.length;
    this.ch = Array.from({ length: o.numberOfChannels }, () => new Float32Array(o.length));
  }
  getChannelData(c: number) {
    return this.ch[c]!;
  }
  copyToChannel(a: Float32Array, c: number, at: number) {
    this.ch[c]!.set(a, at);
  }
}

function videoAt(id: string) {
  history.replaceState(null, '', `/watch?v=${id}`);
  const v = document.createElement('video');
  const props = { duration: DUR, currentSrc: 'blob:v', currentTime: 3, paused: false, muted: false, playbackRate: 1, seeking: false, ended: false };
  for (const [k, value] of Object.entries(props)) Object.defineProperty(v, k, { value, writable: true, configurable: true });
  Object.assign(v, { pause: vi.fn(), play: vi.fn(async () => {}) });
  return v;
}

const tapOf = (): AudioTap => ({
  status: async () => ({ usable: true, mime: 'audio/webm', covered: [[0, DUR]], incomplete: [], bytes: 1 }),
  take: async () => ({ mime: 'audio/webm', data: new ArrayBuffer(8) }),
});

const preload = async (store: ReturnType<typeof fakeCache>, settings: MixerSettings = DEFAULT_SETTINGS, video = videoAt('a')) => {
  const r = new PreloadRunner({ site: 'youtube', video: () => video, onChange() {}, exporting: () => false, loadEngine, persistent: () => store });
  expect(r.start(settings).ok).toBe(true);
  await vi.waitFor(() => expect(store.dispose).toHaveBeenCalled());
  return r;
};

const exportIt = async (store: ReturnType<typeof fakeCache>, settings: MixerSettings = DEFAULT_SETTINGS, held?: PreloadRunner, video = videoAt('a')) => {
  out.audio.length = 0;
  const r = new ExportRunner({ site: 'youtube', video: () => video, lyrics: () => null, onChange() {}, held: () => held?.ready() ?? null, keep: (c) => held?.keep(c), loadEngine, persistent: () => store });
  const options = { ...defaultExportOptions(settings, DEFAULT_LYRICS_PREFS, 'mp3'), tracks: 'mix' as const, audio: { ...settings, vocalPct: 50 } };
  expect(r.start(options).ok).toBe(true);
  await vi.waitFor(() => expect(r.progress?.state).not.toBe('running'));
  return r;
};

beforeEach(() => {
  sessions = 0;
  tap.value = tapOf();
  vi.stubGlobal('chrome', { runtime: { getURL: (p: string) => `chrome-extension://x/${p}` } });
  vi.stubGlobal('AudioBuffer', FakeAudioBuffer);
  vi.stubGlobal(
    'OfflineAudioContext',
    class {
      async decodeAudioData() {
        return { duration: DUR, numberOfChannels: 2, getChannelData: (c: number) => (c === 0 ? pcm.l : pcm.r) };
      }
    },
  );
  URL.createObjectURL = vi.fn(() => 'blob:x');
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});

describe('the persistent stem cache across Preload and Export', () => {
  it('a hit: preload, then export of the same video and settings separates once; the export still comes out', async () => {
    const store = fakeCache();
    await preload(store);
    expect(sessions).toBe(1);
    expect(store.put).toHaveBeenCalledTimes(1);
    const miss = await exportIt(fakeCache()); // reference: the same export from scratch
    const reference = out.audio.map((a) => a.sum);
    expect(sessions).toBe(2);
    sessions = 1;
    const hit = await exportIt(store); // no preload in memory: the persistent copy
    expect(sessions).toBe(1); // not separated again
    expect(hit.progress?.state).toBe('done');
    expect(miss.progress?.state).toBe('done');
    expect(out.audio.length).toBeGreaterThan(0);
    out.audio.forEach((a, i) => (expect(a.n).toBeGreaterThan(0), expect(a.sum).toBeCloseTo(reference[i]!, 0)));
    expect(store.dispose).toHaveBeenCalled();
  });

  it('a hit from memory: the export of the preloaded song asks nobody and separates nothing', async () => {
    const store = fakeCache();
    const r = await preload(store);
    const spare = fakeCache();
    const done = await exportIt(spare, DEFAULT_SETTINGS, r);
    expect(sessions).toBe(1);
    expect(spare.get).not.toHaveBeenCalled();
    expect(done.progress?.state).toBe('done');
    expect(out.audio.length).toBeGreaterThan(0);
  });

  it('a second preload of the same song (a new tab, say) comes from the cache', async () => {
    const store = fakeCache();
    await preload(store);
    store.dispose.mockClear();
    const r = await preload(store);
    expect(sessions).toBe(1);
    expect(store.put).toHaveBeenCalledTimes(1);
    expect(r.ready()?.buffers.size).toBe(2);
  });

  it('a miss: another split setting or another video separates again, and memory keeps one song', async () => {
    const store = fakeCache();
    const first = await preload(store);
    await exportIt(store, { ...DEFAULT_SETTINGS, splitGuitar: true });
    expect(sessions).toBe(2);
    store.dispose.mockClear();
    const next = videoAt('b');
    const r = new PreloadRunner({ site: 'youtube', video: () => next, onChange() {}, exporting: () => false, loadEngine, persistent: () => store });
    // same runner as the first song: its memory is cleared when the other song starts
    void first;
    (r as unknown as { cache: unknown }).cache = first.ready('a');
    expect(r.ready('a')).not.toBeNull();
    r.start(DEFAULT_SETTINGS);
    expect(r.ready('a')).toBeNull();
    await vi.waitFor(() => expect(store.dispose).toHaveBeenCalled());
    expect(sessions).toBe(3);
    expect(r.ready('b')).not.toBeNull();
  });

  it('a cache that fails (null / false / throws) never breaks Preload or Export', async () => {
    const broken = () => fakeCache({ get: vi.fn(async () => null), put: vi.fn(async () => false) });
    const store = broken();
    const r = await preload(store);
    expect(r.status(DEFAULT_SETTINGS).state).toBe('ready');
    expect(store.dispose).toHaveBeenCalled();
    const e1 = await exportIt(store);
    expect(e1.progress?.state).toBe('done');
    expect(sessions).toBe(2);
    const throwing = fakeCache({
      get: vi.fn(async () => {
        throw new Error('boom');
      }),
      put: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const r2 = await preload(throwing);
    expect(r2.status(DEFAULT_SETTINGS).state).toBe('ready');
    const e2 = await exportIt(throwing);
    expect(e2.progress?.state).toBe('done');
    expect(throwing.dispose).toHaveBeenCalled();
  });

  it('a cancelled run still disposes the connection', async () => {
    const store = fakeCache();
    const video = videoAt('a');
    const r = new PreloadRunner({ site: 'youtube', video: () => video, onChange() {}, exporting: () => false, loadEngine, persistent: () => store });
    r.start(DEFAULT_SETTINGS);
    r.cancel();
    await vi.waitFor(() => expect(store.dispose).toHaveBeenCalled());
    expect(r.status(DEFAULT_SETTINGS).state).toBe('cancelled');
  });

  it('an export miss saves its stems: a second export of the same video separates nothing more', async () => {
    const store = fakeCache();
    const first = await exportIt(store);
    const reference = out.audio.map((a) => a.sum);
    expect(first.progress?.state).toBe('done');
    expect(sessions).toBe(1);
    await vi.waitFor(() => expect(store.dispose).toHaveBeenCalled());
    expect(store.put).toHaveBeenCalledTimes(1);
    const second = await exportIt(store);
    expect(second.progress?.state).toBe('done');
    expect(sessions).toBe(1);
    expect(out.audio.length).toBeGreaterThan(0);
    out.audio.forEach((a, i) => expect(a.sum).toBeCloseTo(reference[i]!, 0));
  });

  it('an export miss also fills the memory (one song) and stores a copy', async () => {
    const store = fakeCache();
    const holder = new PreloadRunner({ site: 'youtube', video: () => null, onChange() {}, exporting: () => false, loadEngine, persistent: () => store });
    await exportIt(store, DEFAULT_SETTINGS, holder);
    await vi.waitFor(() => expect(store.dispose).toHaveBeenCalled());
    const mem = holder.ready('a');
    expect(mem?.buffers.size).toBe(2);
    expect(mem!.buffers.get('vocals')!.getChannelData(0).length).toBe(N); // memory keeps its own arrays, not the detached ones
    const stored = [...store.map.values()][0]!;
    expect(stored.stems.vocals![0]!.length).toBe(N);
    expect(mem!.buffers.get('vocals')!.getChannelData(0).some((x) => x !== 0)).toBe(true);
  });

  it('a failing put during an export miss does not stop the export', async () => {
    for (const put of [vi.fn(async () => false), vi.fn(async () => Promise.reject(new Error('boom')))]) {
      const store = fakeCache({ put });
      const done = await exportIt(store);
      expect(done.progress?.state).toBe('done');
      await vi.waitFor(() => expect(store.dispose).toHaveBeenCalled());
      expect(put).toHaveBeenCalledTimes(1);
      expect(out.audio.length).toBeGreaterThan(0);
    }
  });

  it('a cancelled export writes nothing', async () => {
    const store = fakeCache();
    const holder = new PreloadRunner({ site: 'youtube', video: () => null, onChange() {}, exporting: () => false, loadEngine, persistent: () => store });
    const video = videoAt('a');
    const r = new ExportRunner({ site: 'youtube', video: () => video, lyrics: () => null, onChange() {}, keep: (c) => holder.keep(c), loadEngine, persistent: () => store });
    const options = { ...defaultExportOptions(DEFAULT_SETTINGS, DEFAULT_LYRICS_PREFS, 'mp3'), tracks: 'mix' as const, audio: { ...DEFAULT_SETTINGS, vocalPct: 50 } };
    r.start(options);
    r.cancel();
    await vi.waitFor(() => expect(store.dispose).toHaveBeenCalled());
    expect(r.progress?.state).toBe('cancelled');
    expect(store.put).not.toHaveBeenCalled();
    expect(holder.ready('a')).toBeNull();
  });
});
