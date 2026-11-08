// Persistent cache of processed (separated) stems in OPFS, shared by Preload and Export. No imports: it runs in the ml.html iframe (src/shared/stem-cache.ts is the content-side client and the key).

export const STEM_CACHE_MAX_BYTES = 1e9;
export const STEM_CACHE_MAX_AGE_MS = 3 * 24 * 3600e3;

/** Stems of one video: every stem has the same number of channels, each `length` samples long. */
export interface StemSet {
  sampleRate: number;
  length: number;
  stems: Record<string, Float32Array[]>;
}

interface IndexEntry {
  key: string;
  bytes: number;
  lastUsed: number;
  created: number;
}

export interface StemStore {
  /** The stems of `key` (and marks it used now), null when missing or unreadable. */
  get(key: string): Promise<StemSet | null>;
  /** Stores `key`; false (nothing left behind, never throws) when too big for the cap or the write failed. */
  put(key: string, set: StemSet): Promise<boolean>;
  /** Drops entries unused for the max age, then the least recently used ones until under the cap. */
  evict(now?: number): Promise<void>;
}

export interface StemStoreOptions {
  dir?: FileSystemDirectoryHandle;
  now?: () => number;
  maxBytes?: number;
  maxAgeMs?: number;
}

const INDEX = 'index.json';
// Key characters like "|" and ":" are not safe in every file system.
const fileOf = (key: string) => `e-${encodeURIComponent(key)}.bin`;

/** Entry file: u32 header length, JSON header (space padded), then the raw Float32 channels stem by stem. */
function encode(set: StemSet): Uint8Array {
  const names = Object.keys(set.stems);
  const channels = names.length ? set.stems[names[0]].length : 0;
  const json = JSON.stringify({ sampleRate: set.sampleRate, length: set.length, channels, names });
  const headLen = Math.ceil(json.length / 4) * 4;
  const head = new TextEncoder().encode(json.padEnd(headLen));
  const out = new Uint8Array(4 + head.length + names.length * channels * set.length * 4);
  new DataView(out.buffer).setUint32(0, head.length, true);
  out.set(head, 4);
  let at = 4 + head.length;
  for (const n of names) {
    for (const ch of set.stems[n]) {
      out.set(new Uint8Array(ch.buffer, ch.byteOffset, set.length * 4), at);
      at += set.length * 4;
    }
  }
  return out;
}

function decode(buf: ArrayBuffer): StemSet {
  const headLen = new DataView(buf).getUint32(0, true);
  const { sampleRate, length, channels, names } = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, headLen)));
  let at = 4 + headLen;
  const stems: Record<string, Float32Array[]> = {};
  for (const n of names as string[]) {
    stems[n] = Array.from({ length: channels }, () => new Float32Array(buf.slice(at, (at += length * 4))));
  }
  return { sampleRate, length, stems };
}

async function writeFile(dir: FileSystemDirectoryHandle, name: string, data: Uint8Array | string): Promise<void> {
  const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await w.write(data as FileSystemWriteChunkType);
  await w.close();
}

/** Opens the cache (OPFS `stem-cache/` of the extension origin unless `dir` is given) and evicts what is due. */
export async function openStemStore(opts: StemStoreOptions = {}): Promise<StemStore> {
  const dir = opts.dir ?? (await (await navigator.storage.getDirectory()).getDirectoryHandle('stem-cache', { create: true }));
  const clock = opts.now ?? Date.now;
  const maxBytes = opts.maxBytes ?? STEM_CACHE_MAX_BYTES;
  const maxAge = opts.maxAgeMs ?? STEM_CACHE_MAX_AGE_MS;

  // Every call re-reads the index (another context may have changed it) and calls run one at a time.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  const readIndex = async (): Promise<IndexEntry[]> => {
    try {
      return JSON.parse(await (await (await dir.getFileHandle(INDEX)).getFile()).text());
    } catch {
      return [];
    }
  };
  const remove = (key: string) => dir.removeEntry(fileOf(key)).catch(() => {});

  const evictIn = async (index: IndexEntry[], now: number): Promise<void> => {
    const keep = index.filter((e) => now - e.lastUsed <= maxAge).sort((a, b) => a.lastUsed - b.lastUsed);
    let total = keep.reduce((s, e) => s + e.bytes, 0);
    while (total > maxBytes && keep.length) total -= keep.shift()!.bytes;
    for (const e of index) if (!keep.includes(e)) await remove(e.key);
    if (keep.length !== index.length) await writeFile(dir, INDEX, JSON.stringify(keep));
  };

  // A crash between the entry write and the index write leaves an e-*.bin the index does not know: it would count against nothing and never go.
  const sweepOrphans = () =>
    serial(async () => {
      const known = new Set((await readIndex()).map((e) => fileOf(e.key)));
      const names: string[] = [];
      for await (const n of dir.keys()) if (/^e-.*\.bin$/.test(n) && !known.has(n)) names.push(n);
      for (const n of names) await dir.removeEntry(n).catch(() => {});
    }).catch((e) => console.warn('[stem-store] orphan sweep failed', e));

  const store: StemStore = {
    evict: (now) =>
      serial(async () => evictIn(await readIndex(), now ?? clock())).catch((e) => console.warn('[stem-store] evict failed', e)),
    get: (key) =>
      serial(async () => {
        try {
          const index = await readIndex();
          const entry = index.find((e) => e.key === key);
          if (!entry) return null;
          const set = decode(await (await (await dir.getFileHandle(fileOf(key))).getFile()).arrayBuffer());
          entry.lastUsed = clock();
          await writeFile(dir, INDEX, JSON.stringify(index));
          return set;
        } catch (e) {
          console.warn('[stem-store] get failed', e);
          return null;
        }
      }),
    put: (key, set) =>
      serial(async () => {
        try {
          const data = encode(set);
          if (data.byteLength > maxBytes) return false;
          const now = clock();
          await writeFile(dir, fileOf(key), data);
          const index = (await readIndex()).filter((e) => e.key !== key);
          index.push({ key, bytes: data.byteLength, lastUsed: now, created: now });
          await writeFile(dir, INDEX, JSON.stringify(index));
          await evictIn(index, now);
          return true;
        } catch (e) {
          console.warn('[stem-store] put failed', e);
          await remove(key);
          return false;
        }
      }),
  };
  await sweepOrphans();
  await store.evict();
  return store;
}
