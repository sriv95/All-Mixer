import { describe, expect, it } from 'vitest';
import { ML_HEADER_BYTES, bufferBytes, type MlGeometry } from '../worklet/protocol';
import { EXPORT_SAMPLE_RATE, MAX_CHUNK_S } from '../shared/export';
import { OfflineSeparator } from './separator';

const geometry = (over: Partial<MlGeometry> = {}): MlGeometry => ({ block: 1000, resultOffset: 1500, latency: 4000, warmupP90Ms: 0, ...over });

/** A worker that answers like the real one: block at `start` returns the region [start − resultOffset, + block) of what it was fed. */
function fakeWorker(port: MessagePort, g: MlGeometry, opts: { failAt?: number } = {}): { seen: number[] } {
  const seen: number[] = [];
  const hist: number[][] = [[], []];
  const planes = 4 + 2 * (['drums', 'guitar', 'bass', 'piano'] as const).filter((p) => g[p]).length;
  port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
    const buf = e.data;
    const head = new Float64Array(buf, 0, 2);
    const start = head[1];
    seen.push(start);
    const d = new Float32Array(buf, ML_HEADER_BYTES, planes * g.block);
    for (let c = 0; c < 2; c++) for (let i = 0; i < g.block; i++) hist[c][start + i] = d[c * g.block + i];
    const at = (c: number, i: number) => (i < 0 ? 0 : hist[c][i] ?? 0);
    for (let c = 0; c < 2; c++) {
      for (let i = 0; i < g.block; i++) {
        const x = at(c, start - g.resultOffset + i);
        d[(0 + c) * g.block + i] = 0.5 * x; // vk
        d[(2 + c) * g.block + i] = 0.25 * x; // vocal
        for (let p = 0; p < (planes - 4) / 2; p++) d[(4 + 2 * p + c) * g.block + i] = 0.1 * (p + 1) * x;
      }
    }
    head[1] = start === opts.failAt ? -1 : start - g.resultOffset;
    port.postMessage(buf, [buf]);
  };
  port.start();
  return { seen };
}

const signal = (n: number, from = 0): [Float32Array, Float32Array] => [
  Float32Array.from({ length: n }, (_, i) => Math.sin((from + i) * 0.01)),
  Float32Array.from({ length: n }, (_, i) => Math.cos((from + i) * 0.013)),
];

async function run(g: MlGeometry, pieces: number[]) {
  const { port1, port2 } = new MessageChannel();
  const w = fakeWorker(port2, g);
  const sep = new OfflineSeparator(port1, g);
  const slices = [] as NonNullable<Awaited<ReturnType<OfflineSeparator['push']>>>[];
  let at = 0;
  for (const n of pieces) {
    const [l, r] = signal(n, at);
    at += n;
    const s = await sep.push(l, r);
    if (s) slices.push(s);
  }
  const last = await sep.finish();
  if (last) slices.push(last);
  sep.dispose();
  return { slices, total: at, seen: w.seen };
}

describe('OfflineSeparator', () => {
  it('returns every input sample once, in order, with the stems of that sample (no delay)', async () => {
    const { slices, total } = await run(geometry(), [2500, 777, 4100, 13]);
    expect(slices.reduce((n, s) => n + s.length, 0)).toBe(total);
    let at = 0;
    const [l] = signal(total);
    for (const s of slices) {
      expect(s.start).toBe(at);
      for (let i = 0; i < s.length; i++) {
        expect(s.dry[0][i]).toBeCloseTo(l[at + i], 6);
        expect(s.vk![0][i]).toBeCloseTo(0.5 * l[at + i], 6);
        expect(s.vocal![0][i]).toBeCloseTo(0.25 * l[at + i], 6);
      }
      at += s.length;
    }
  });

  it('sends the blocks of the whole recording as one stream (no restart at a chunk border)', async () => {
    const { seen, total } = await run(geometry(), [1200, 1200, 1200]);
    expect(seen.slice(0, 3)).toEqual([0, 1000, 2000]);
    expect(seen.every((s, i) => s === i * 1000)).toBe(true);
    expect(seen.length * 1000 - 1500).toBeGreaterThanOrEqual(total);
  });

  it('carries the parts of the instrumental when the geometry has them', async () => {
    const { slices } = await run(geometry({ drums: true, guitar: true }), [3000]);
    const s = slices[0];
    expect(Object.keys(s.parts!)).toEqual(['drums', 'guitar']);
    expect(s.parts!.guitar![0][10]).toBeCloseTo(0.2 * s.dry[0][10], 6);
  });

  it('refuses a piece longer than the maximum chunk', async () => {
    const { port1, port2 } = new MessageChannel();
    fakeWorker(port2, geometry());
    const sep = new OfflineSeparator(port1, geometry());
    const n = MAX_CHUNK_S * EXPORT_SAMPLE_RATE + 1;
    await expect(sep.push(new Float32Array(n), new Float32Array(n))).rejects.toThrow(/longer than 15 s/);
    sep.dispose();
  });

  it('fails when the worker returns a block without a result', async () => {
    const { port1, port2 } = new MessageChannel();
    fakeWorker(port2, geometry(), { failAt: 1000 });
    const sep = new OfflineSeparator(port1, geometry());
    const [l, r] = signal(3000);
    await expect(sep.push(l, r)).rejects.toThrow(/failed on a block/);
    sep.dispose();
  });

  it('uses a buffer size the worker accepts', () => {
    expect(bufferBytes(geometry())).toBe(ML_HEADER_BYTES + 4 * 1000 * 4);
  });
});
