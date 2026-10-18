import { describe, expect, it } from 'vitest';
import type { ModelFiles } from '../shared/model-files';
import { CHUNK, MODEL_FORMAT, chunkName, keyInstalled, keyProgress, keyRemote } from '../shared/model-store';
import { ModelManager } from './model-manager';

function memArea() {
  const d: Record<string, unknown> = {};
  return {
    d,
    get: async (k: string) => (k in d ? { [k]: d[k] } : {}),
    set: async (o: Record<string, unknown>) => void Object.assign(d, o),
    remove: async (k: string) => void delete d[k],
  };
}
function memFiles() {
  const m = new Map<string, Uint8Array>();
  const files: ModelFiles = {
    size: async (n) => m.get(n)?.length ?? -1,
    put: async (n, b) => void m.set(n, b),
    remove: async (n) => void m.delete(n),
    list: async () => [...m.keys()],
    blob: async (ns) => new Blob(ns.map((n) => m.get(n)! as BlobPart)),
  };
  return { m, files };
}

/** Building 16 MiB per request made this suite time out on a slow CI runner: build each file once. */
const cache = new Map<string, Uint8Array>();
const bytes = (len: number, v: number): Uint8Array => {
  const k = `${len}/${v}`;
  if (!cache.has(k)) cache.set(k, Uint8Array.from({ length: len }, (_, i) => (i + v) & 255));
  return cache.get(k)!;
};

const ONNX = 2 * CHUNK + 100; // 3 chunks, the last one short
const META = 50;
/** A fake HF repo: the manifest (roformer at `version`, deux at v1 unless `over.noDeux`), and Range requests on v<version>/<file>. */
function server(version: number, over: { format?: number; noDeux?: boolean; fail?: (url: string, from: number) => boolean } = {}) {
  const reqs: string[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    reqs.push(url + ' ' + ((init?.headers as Record<string, string> | undefined)?.Range ?? ''));
    if (url.endsWith('/manifest.json')) {
      const models = {
        roformer: { version, files: { 'roformer.onnx': ONNX, 'roformer-meta.json': META } },
        ...(over.noDeux ? {} : { deux: { version: 1, files: { 'deux.onnx': ONNX, 'deux-meta.json': META } } }),
      };
      return new Response(JSON.stringify({ format: over.format ?? MODEL_FORMAT, models }));
    }
    const m = /bytes=(\d+)-(\d+)/.exec((init?.headers as Record<string, string>).Range)!;
    const from = +m[1], to = +m[2];
    if (over.fail?.(url, from)) return new Response('no', { status: 503 });
    const all = bytes(url.endsWith('.onnx') ? ONNX : META, version);
    return new Response(all.slice(from, to + 1), { status: 206 });
  }) as typeof fetch;
  return { fetchFn, reqs };
}

describe('ModelManager', () => {
  it('check stores the manifest; a broken or offline manifest changes nothing', async () => {
    const area = memArea();
    const { files } = memFiles();
    const mgr = new ModelManager(area as never, files, server(3).fetchFn, () => 1000);
    expect(await mgr.check()).toMatchObject({ roformer: { version: 3, checkedAt: 1000 }, deux: { version: 1 } });
    expect(area.d[keyRemote('roformer')]).toMatchObject({ version: 3 });
    expect(area.d[keyRemote('deux')]).toMatchObject({ version: 1 });
    const bad = new ModelManager(area as never, files, (async () => new Response('{"version":"x"}')) as typeof fetch);
    expect(await bad.check()).toBeNull();
    const off = new ModelManager(area as never, files, (async () => { throw new Error('offline'); }) as typeof fetch);
    expect(await off.check()).toBeNull();
    expect(area.d[keyRemote('roformer')]).toMatchObject({ version: 3 });
  });

  it('install downloads every chunk, records the version and removes the progress record', async () => {
    const area = memArea();
    const { m, files } = memFiles();
    await new ModelManager(area as never, files, server(1).fetchFn).install('roformer');
    expect(area.d[keyInstalled('roformer')]).toEqual({ format: MODEL_FORMAT, version: 1, files: { 'roformer.onnx': ONNX, 'roformer-meta.json': META } });
    expect(keyProgress('roformer') in area.d).toBe(false);
    expect([...m.keys()].sort()).toEqual(['v1-roformer-meta.json.0000', 'v1-roformer.onnx.0000', 'v1-roformer.onnx.0001', 'v1-roformer.onnx.0002']);
    expect(m.get(chunkName(1, 'roformer.onnx', 2))!.length).toBe(100);
  });

  it('resumes: chunks already on disk are not requested again', async () => {
    const area = memArea();
    const { m, files } = memFiles();
    const s1 = server(1, { fail: (url, from) => url.endsWith('.onnx') && from === CHUNK });
    await new ModelManager(area as never, files, s1.fetchFn).install('roformer');
    expect(area.d[keyProgress('roformer')]).toMatchObject({ phase: 'error', error: expect.stringContaining('HTTP 503') });
    expect(keyInstalled('roformer') in area.d).toBe(false);
    expect(m.has(chunkName(1, 'roformer.onnx', 0))).toBe(true);
    const s2 = server(1);
    await new ModelManager(area as never, files, s2.fetchFn).install('roformer');
    expect(s2.reqs.filter((r) => r.includes('bytes=')).map((r) => r.split(' ')[1])).toEqual([`bytes=${CHUNK}-${2 * CHUNK - 1}`, `bytes=${2 * CHUNK}-${2 * CHUNK + 99}`]);
    expect(area.d[keyInstalled('roformer')]).toMatchObject({ version: 1 });
  });

  it('a short chunk is an error, not an install', async () => {
    const area = memArea();
    const { files } = memFiles();
    const f = (async (url: string) => (url.endsWith('manifest.json') ? server(1).fetchFn(url) : new Response(new Uint8Array(10), { status: 206 }))) as typeof fetch;
    await new ModelManager(area as never, files, f).install('roformer');
    expect(area.d[keyProgress('roformer')]).toMatchObject({ phase: 'error' });
    expect(keyInstalled('roformer') in area.d).toBe(false);
  });

  it('an update keeps the old version installed until it is complete, then prunes it', async () => {
    const area = memArea();
    const { m, files } = memFiles();
    await new ModelManager(area as never, files, server(1).fetchFn).install('roformer');
    await new ModelManager(area as never, files, server(2, { fail: (u, from) => u.endsWith('.onnx') && from === 2 * CHUNK }).fetchFn).install('roformer');
    expect(area.d[keyInstalled('roformer')]).toMatchObject({ version: 1 });
    expect(m.has(chunkName(1, 'roformer.onnx', 0))).toBe(true);
    await new ModelManager(area as never, files, server(2).fetchFn).install('roformer');
    expect(area.d[keyInstalled('roformer')]).toMatchObject({ version: 2 });
    expect([...m.keys()].every((k) => k.startsWith('v2-'))).toBe(true);
  });

  it('refuses a manifest of another format', async () => {
    const area = memArea();
    const { files } = memFiles();
    await new ModelManager(area as never, files, server(1, { format: MODEL_FORMAT + 1 }).fetchFn).install('roformer');
    expect(area.d[keyProgress('roformer')]).toMatchObject({ phase: 'error', error: expect.stringContaining('newer version') });
  });

  it('simultaneous installs share one download', async () => {
    const area = memArea();
    const { files } = memFiles();
    const s = server(1);
    const mgr = new ModelManager(area as never, files, s.fetchFn);
    await Promise.all([mgr.install('roformer'), mgr.install('roformer')]);
    expect(s.reqs.filter((r) => r.endsWith('manifest.json '))).toHaveLength(1);
  });

  it('installs each model on its own and a new roformer version keeps the deux chunks', async () => {
    const area = memArea();
    const { m, files } = memFiles();
    await new ModelManager(area as never, files, server(1).fetchFn).install('roformer');
    await new ModelManager(area as never, files, server(1).fetchFn).install('deux');
    expect(area.d[keyInstalled('deux')]).toEqual({ format: MODEL_FORMAT, version: 1, files: { 'deux.onnx': ONNX, 'deux-meta.json': META } });
    expect(m.has(chunkName(1, 'deux.onnx', 0))).toBe(true);
    await new ModelManager(area as never, files, server(2).fetchFn).install('roformer');
    expect(area.d[keyInstalled('roformer')]).toMatchObject({ version: 2 });
    expect([...m.keys()].filter((k) => k.includes('roformer')).every((k) => k.startsWith('v2-'))).toBe(true);
    expect([...m.keys()].filter((k) => k.includes('deux')).length).toBe(4);
  });

  it('a model missing from the manifest is an error', async () => {
    const area = memArea();
    const { files } = memFiles();
    await new ModelManager(area as never, files, server(1, { noDeux: true }).fetchFn).install('deux');
    expect(area.d[keyProgress('deux')]).toMatchObject({ phase: 'error', error: expect.stringContaining('not published') });
  });
});
