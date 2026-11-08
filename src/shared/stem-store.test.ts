import { describe, expect, it } from 'vitest';
import { openStemStore, type StemSet } from './stem-store';

/** In-memory FileSystemDirectoryHandle (happy-dom has no OPFS); every write after the first `failAfter` closed files fails. */
function fakeDir(opts: { failAfter?: number } = {}) {
  const files = new Map<string, Uint8Array>();
  let writes = 0;
  return {
    files,
    async getFileHandle(name: string, o?: { create?: boolean }) {
      if (!files.has(name) && !o?.create) throw new DOMException('missing', 'NotFoundError');
      return {
        async getFile() {
          const b = files.get(name)!;
          return { size: b.length, text: async () => new TextDecoder().decode(b), arrayBuffer: async () => b.slice().buffer };
        },
        async createWritable() {
          let data: Uint8Array<ArrayBuffer> = new Uint8Array(0);
          return {
            async write(d: Uint8Array | string) {
              if (opts.failAfter !== undefined && writes >= opts.failAfter) throw new DOMException('quota', 'QuotaExceededError');
              data = typeof d === 'string' ? new TextEncoder().encode(d) : (d as Uint8Array<ArrayBuffer>);
            },
            async close() {
              writes++;
              files.set(name, data.slice());
            },
          };
        },
      };
    },
    async *keys() {
      yield* [...files.keys()];
    },
    async removeEntry(name: string) {
      if (!files.delete(name)) throw new DOMException('missing', 'NotFoundError');
    },
  };
}

const DAY = 24 * 3600e3;
/** 2 stems x 2 channels x `n` samples: n * 16 bytes of audio plus about 100 bytes of header. */
const set = (n: number, seed = 1): StemSet => ({
  sampleRate: 44100,
  length: n,
  stems: {
    vocals: [Float32Array.from({ length: n }, (_, i) => seed + i / 7), Float32Array.from({ length: n }, (_, i) => -seed - i)],
    music: [Float32Array.from({ length: n }, () => 0.5 * seed), Float32Array.from({ length: n }, (_, i) => i * 1e-9)],
  },
});
const open = (dir: ReturnType<typeof fakeDir>, t: { now: number }, extra = {}) =>
  openStemStore({ dir: dir as unknown as FileSystemDirectoryHandle, now: () => t.now, ...extra });
const bins = (dir: ReturnType<typeof fakeDir>) => [...dir.files.keys()].filter((k) => k.endsWith('.bin'));
const TWO_ENTRIES = 2 * (100 * 16 + 150) + 600; // room for two 100-sample entries, not three

describe('stem store', () => {
  it('get returns exactly what put stored', async () => {
    const s = await open(fakeDir(), { now: 1e9 });
    const a = set(100);
    expect(await s.put('k', a)).toBe(true);
    expect(await s.get('k')).toEqual(a);
    expect(await s.get('missing')).toBeNull();
  });

  it('evicts the least recently used entry over the cap', async () => {
    const dir = fakeDir();
    const t = { now: 1e9 };
    const s = await open(dir, t, { maxBytes: TWO_ENTRIES });
    for (const [i, k] of ['a', 'b', 'c'].entries()) {
      await s.put(k, set(100, i + 1));
      t.now += 1000;
    }
    expect(await s.get('a')).toBeNull();
    expect(await s.get('b')).not.toBeNull();
    expect(await s.get('c')).not.toBeNull();
    expect(bins(dir)).toHaveLength(2);
  });

  it('get updates the LRU order', async () => {
    const t = { now: 1e9 };
    const s = await open(fakeDir(), t, { maxBytes: TWO_ENTRIES });
    await s.put('a', set(100));
    t.now += 1000;
    await s.put('b', set(100, 2));
    t.now += 1000;
    await s.get('a');
    t.now += 1000;
    await s.put('c', set(100, 3));
    expect(await s.get('b')).toBeNull();
    expect(await s.get('a')).not.toBeNull();
  });

  it('removes entries unused for more than 3 days when the store opens', async () => {
    const dir = fakeDir();
    const t = { now: 1e9 };
    const s = await open(dir, t);
    await s.put('old', set(10));
    t.now += 2 * DAY;
    await s.put('new', set(10, 2));
    t.now += DAY + 1; // old: 3 days + 1 ms unused, new: 1 day + 1 ms
    const reopened = await open(dir, t);
    expect(bins(dir)).toHaveLength(1);
    expect(await reopened.get('old')).toBeNull();
    expect(await reopened.get('new')).not.toBeNull();
  });

  it('skips an entry bigger than the cap', async () => {
    const dir = fakeDir();
    const s = await open(dir, { now: 1e9 }, { maxBytes: 1000 });
    expect(await s.put('big', set(100))).toBe(false);
    expect(await s.get('big')).toBeNull();
    expect(bins(dir)).toHaveLength(0);
  });

  it('a failed write returns false and leaves no partial entry', async () => {
    const dir = fakeDir({ failAfter: 1 }); // the entry file is write #1, the index write fails
    const s = await open(dir, { now: 1e9 });
    expect(await s.put('k', set(10))).toBe(false);
    expect(bins(dir)).toHaveLength(0);
    expect(await s.get('k')).toBeNull();
  });

  it('deletes e-*.bin files missing from the index when the store opens', async () => {
    const dir = fakeDir();
    const t = { now: 1e9 };
    const s = await open(dir, t);
    await s.put('kept', set(10));
    dir.files.set('e-orphan.bin', new Uint8Array(500)); // crash between the entry write and the index write
    dir.files.set('other.txt', new Uint8Array(1)); // not ours: stays
    const reopened = await open(dir, t);
    expect([...dir.files.keys()].sort()).toEqual(['e-kept.bin', 'index.json', 'other.txt']);
    expect(await reopened.get('kept')).not.toBeNull();
  });
});
