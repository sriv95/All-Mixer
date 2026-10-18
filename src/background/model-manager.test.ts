import { describe, expect, it } from 'vitest';
import type { ModelFiles } from '../shared/model-files';
import { CHUNK, KEY_INSTALLED, KEY_PROGRESS, KEY_REMOTE, chunkName } from '../shared/model-store';
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

const ONNX = 2 * CHUNK + 100; // 3 chunks, the last one short
const META = 50;
/** A fake HF repo: the manifest, and Range requests on v<version>/<file>. */
function server(version: number, over: { format?: number; fail?: (url: string, from: number) => boolean } = {}) {
  const reqs: string[] = [];
  const bytes = (len: number, v: number) => Uint8Array.from({ length: len }, (_, i) => (i + v) & 255);
  const fetchFn = (async (url: string, init?: RequestInit) => {
    reqs.push(url + ' ' + ((init?.headers as Record<string, string> | undefined)?.Range ?? ''));
    if (url.endsWith('/manifest.json')) {
      return new Response(JSON.stringify({ format: over.format ?? 1, version, files: { 'roformer.onnx': ONNX, 'roformer-meta.json': META } }));
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
    expect(await mgr.check()).toMatchObject({ version: 3, checkedAt: 1000 });
    expect(area.d[KEY_REMOTE]).toMatchObject({ version: 3 });
    const bad = new ModelManager(area as never, files, (async () => new Response('{"version":"x"}')) as typeof fetch);
    expect(await bad.check()).toBeNull();
    const off = new ModelManager(area as never, files, (async () => { throw new Error('offline'); }) as typeof fetch);
    expect(await off.check()).toBeNull();
    expect(area.d[KEY_REMOTE]).toMatchObject({ version: 3 });
  });

  it('install downloads every chunk, records the version and removes the progress record', async () => {
    const area = memArea();
    const { m, files } = memFiles();
    await new ModelManager(area as never, files, server(1).fetchFn).install();
    expect(area.d[KEY_INSTALLED]).toEqual({ version: 1, files: { 'roformer.onnx': ONNX, 'roformer-meta.json': META } });
    expect(KEY_PROGRESS in area.d).toBe(false);
    expect([...m.keys()].sort()).toEqual(['v1-roformer-meta.json.0000', 'v1-roformer.onnx.0000', 'v1-roformer.onnx.0001', 'v1-roformer.onnx.0002']);
    expect(m.get(chunkName(1, 'roformer.onnx', 2))!.length).toBe(100);
  });

  it('resumes: chunks already on disk are not requested again', async () => {
    const area = memArea();
    const { m, files } = memFiles();
    const s1 = server(1, { fail: (url, from) => url.endsWith('.onnx') && from === CHUNK });
    await new ModelManager(area as never, files, s1.fetchFn).install();
    expect(area.d[KEY_PROGRESS]).toMatchObject({ phase: 'error', error: expect.stringContaining('HTTP 503') });
    expect(KEY_INSTALLED in area.d).toBe(false);
    expect(m.has(chunkName(1, 'roformer.onnx', 0))).toBe(true);
    const s2 = server(1);
    await new ModelManager(area as never, files, s2.fetchFn).install();
    expect(s2.reqs.filter((r) => r.includes('bytes=')).map((r) => r.split(' ')[1])).toEqual([`bytes=${CHUNK}-${2 * CHUNK - 1}`, `bytes=${2 * CHUNK}-${2 * CHUNK + 99}`]);
    expect(area.d[KEY_INSTALLED]).toMatchObject({ version: 1 });
  });

  it('a short chunk is an error, not an install', async () => {
    const area = memArea();
    const { files } = memFiles();
    const f = (async (url: string) => (url.endsWith('manifest.json') ? server(1).fetchFn(url) : new Response(new Uint8Array(10), { status: 206 }))) as typeof fetch;
    await new ModelManager(area as never, files, f).install();
    expect(area.d[KEY_PROGRESS]).toMatchObject({ phase: 'error' });
    expect(KEY_INSTALLED in area.d).toBe(false);
  });

  it('an update keeps the old version installed until it is complete, then prunes it', async () => {
    const area = memArea();
    const { m, files } = memFiles();
    await new ModelManager(area as never, files, server(1).fetchFn).install();
    await new ModelManager(area as never, files, server(2, { fail: (u, from) => u.endsWith('.onnx') && from === 2 * CHUNK }).fetchFn).install();
    expect(area.d[KEY_INSTALLED]).toMatchObject({ version: 1 });
    expect(m.has(chunkName(1, 'roformer.onnx', 0))).toBe(true);
    await new ModelManager(area as never, files, server(2).fetchFn).install();
    expect(area.d[KEY_INSTALLED]).toMatchObject({ version: 2 });
    expect([...m.keys()].every((k) => k.startsWith('v2-'))).toBe(true);
  });

  it('refuses a manifest of another format', async () => {
    const area = memArea();
    const { files } = memFiles();
    await new ModelManager(area as never, files, server(1, { format: 2 }).fetchFn).install();
    expect(area.d[KEY_PROGRESS]).toMatchObject({ phase: 'error', error: expect.stringContaining('newer version') });
  });

  it('simultaneous installs share one download', async () => {
    const area = memArea();
    const { files } = memFiles();
    const s = server(1);
    const mgr = new ModelManager(area as never, files, s.fetchFn);
    await Promise.all([mgr.install(), mgr.install()]);
    expect(s.reqs.filter((r) => r.endsWith('manifest.json '))).toHaveLength(1);
  });
});
