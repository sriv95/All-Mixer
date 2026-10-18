// ML worker (runs inside the ml.html iframe, which gets a real WebGPU adapter): receives block
// buffers from the separator worklet on a MessagePort, runs MDX-Net 9482 (vocal) and the Spleeter vocals
// model (Karaoke mask) with onnxruntime-web (webgpu EP only, one run in flight at a time) and sends the
// same buffers back with the Vk and vocal blocks (src/ml/pipeline.ts). With model 'roformer' it runs the
// Mel-Band RoFormer core instead (src/ml/roformer.ts): the vocal block is both Vk and the A cappella.
import {
  GEOMETRY,
  ML_BLOCK,
  ML_HEADER_BYTES,
  ML_SAMPLE_RATE,
  ML_WARMUP_P90_MS,
  ML_RESULT_OFFSET,
  bufferBytes,
  type FromMlWorker,
  type MlGeometry,
  type MlWorkerInit,
} from '../worklet/protocol';
import { CTX, BINS } from './stream';
import { MDX_BINS, MDX_T } from './mdx';
import { MlPipeline, type Models } from './pipeline';
import { warmUp, warmUpGated, type WarmUpResult } from './warmup';
import { makeStall, type StallOpts } from './stall';
import { MlTiming } from './timing';
import { opfsFiles, readModelFile } from '../shared/model-files';
import { MODEL_FORMAT, MODEL_LABEL, modelFileNames, type ModelId } from '../shared/model-store';
import { RoformerStream, DEFAULT_ROF_GEOMETRY, type RoformerMeta } from './roformer';
import { MAX_DELAY_S, gateMs, planAuto, planRof, stepMs, type RofGeometry } from './rof-plan';

type Ort = typeof import('onnxruntime-web/webgpu');
type Session = Awaited<ReturnType<Ort['InferenceSession']['create']>>;

const ctx = self as unknown as { postMessage(m: FromMlWorker): void; onmessage: ((e: MessageEvent<MlWorkerInit>) => void) | null };

const unavailable = (reason: string): void => ctx.postMessage({ type: 'unavailable', reason });

async function start(init: MlWorkerInit): Promise<void> {
  // 1. WebGPU probe first: without a real adapter ORT is not even loaded.
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<GPUAdapterLike | null> } }).gpu;
  if (!gpu) return unavailable('no navigator.gpu in the worker');
  let adapter: GPUAdapterLike | null;
  try {
    adapter = await gpu.requestAdapter();
  } catch (e) {
    return unavailable(`requestAdapter failed: ${String(e)}`);
  }
  if (!adapter) return unavailable('no WebGPU adapter');
  if (adapter.isFallbackAdapter) return unavailable('only a fallback (software) WebGPU adapter');
  const info = adapter.info ?? {};
  const adapterName = [info.vendor, info.architecture, info.description].filter(Boolean).join(' ') || 'unknown';
  if (init.model !== 'mdx') return startRoformer(init, adapterName);

  // 2. ORT + models.
  let ort: Ort, session: Session, mdxSession: Session;
  const t0 = performance.now();
  try {
    ort = await import('onnxruntime-web/webgpu');
    ort.env.wasm.wasmPaths = init.wasmBase;
    ort.env.wasm.numThreads = 1; // no SharedArrayBuffer; the webgpu EP does the work
    ort.env.wasm.proxy = false;
    ort.env.logLevel = 'error'; // models declare a dynamic dim; ORT warns VerifyOutputSizes per run
    const opts = { executionProviders: ['webgpu'], graphOptimizationLevel: 'all', logSeverityLevel: 3 } as const;
    const [mdxBuf, splBuf] = await Promise.all([init.mdxUrl, init.modelUrl].map(async (u) => (await fetch(u)).arrayBuffer()));
    mdxSession = await ort.InferenceSession.create(mdxBuf, opts);
    session = await ort.InferenceSession.create(splBuf, opts);
  } catch (e) {
    return unavailable(`model: ${String(e)}`);
  }
  const createMs = performance.now() - t0;

  const pipeline = new MlPipeline();
  const mdxInput = new ort.Tensor('float32', pipeline.mdx.x, [1, 4, MDX_BINS, MDX_T]);
  const splInput = new ort.Tensor('float32', pipeline.spl.x, [2, 1, CTX, BINS]);
  const run = (s: Session, input: unknown) => async (): Promise<Float32Array> => {
    // The input tensor owns the stream's buffer: refreshed in place, so one feed object is reused.
    const out = await s.run({ [s.inputNames[0]]: input as never });
    const t = out[s.outputNames[0]];
    const data = (await t.getData()) as Float32Array;
    t.dispose();
    return data;
  };
  const runMdx = run(mdxSession, mdxInput), runSpl = run(session, splInput);
  const models: Models = { mdx: runMdx, spleeter: runSpl };

  // 3. Warm-up on noise: 3 untimed runs (shader compile, first upload; their time is added to
  // createMs), then 20 timed MDX block steps (analyze + model + synthesize), which is what has to
  // meet the block deadline. The gate uses p90 of n=20 (ignores the two slowest), so a cold-cache outlier is tolerated.
  // If p90 is still over the gate, one more attempt (skip 0, n 20, caches are warm) runs here, before
  // `ready`, and the attempt with the lower p90 wins. Worst case ~2 x 23 steps (~2.8 s each at ~140 ms).
  // The Spleeter model gets 3 untimed runs (shader compile).
  const nl = new Float32Array(ML_BLOCK), nr = new Float32Array(ML_BLOCK);
  const ol = new Float32Array(ML_BLOCK), or = new Float32Array(ML_BLOCK);
  let wu: WarmUpResult & { attempts: number };
  try {
    for (let i = 0; i < ML_BLOCK; i++) {
      nl[i] = Math.random() * 2 - 1;
      nr[i] = Math.random() * 2 - 1;
    }
    const step = () => pipeline.mdx.process(nl, nr, runMdx, ol, or);
    wu = await warmUpGated((retry) => warmUp(step, retry ? { skip: 0, n: 20 } : { skip: 3, n: 20 }), ML_WARMUP_P90_MS);
    const s0 = performance.now();
    for (let i = 0; i < 3; i++) await runSpl();
    wu.firstMs += performance.now() - s0;
  } catch (e) {
    return unavailable(`warm-up: ${String(e)}`);
  }
  pipeline.reset();
  if (init.timing) console.info(`[all-mixer ml] warm-up p50 ${wu.p50.toFixed(1)} p90 ${wu.p90.toFixed(1)} p95 ${wu.p95.toFixed(1)} (gate ${ML_WARMUP_P90_MS.toFixed(1)}), create ${(createMs + wu.firstMs).toFixed(0)} ms, ${adapterName}, ${wu.attempts > 1 ? 'retry' : 'first try'}`);
  ctx.postMessage({ type: 'ready', p50: wu.p50, p90: wu.p90, p95: wu.p95, createMs: createMs + wu.firstMs, adapter: adapterName });

  const engine: BlockEngine = {
    block: ML_BLOCK,
    resultOffset: ML_RESULT_OFFSET,
    reset: () => pipeline.reset(),
    // Vk in place over the input; the MDX vocal in the second half of the buffer
    process: (d) => pipeline.process(d.subarray(0, ML_BLOCK), d.subarray(ML_BLOCK, 2 * ML_BLOCK), models, d.subarray(0, ML_BLOCK), d.subarray(ML_BLOCK, 2 * ML_BLOCK), d.subarray(2 * ML_BLOCK, 3 * ML_BLOCK), d.subarray(3 * ML_BLOCK)),
    afterReply: () => pipeline.catchUp(models.spleeter),
    misses: () => pipeline.splMisses,
  };
  serve(init.port, engine, { stallMs: init.stallMs ?? 0, stallAfterMs: init.stallAfterMs ?? 5000 }, init.timing ? new MlTiming() : null);
}

/** RoFormer: one fp16 transformer core on WebGPU, STFT / mask / iSTFT in JS. The chunk length is planned from the speed of this GPU. */
async function startRoformer(init: MlWorkerInit, adapterName: string): Promise<void> {
  const id = init.model as ModelId;
  let ort: Ort, buf: ArrayBuffer, meta: RoformerMeta;
  const t0 = performance.now();
  try {
    ort = await import('onnxruntime-web/webgpu');
    ort.env.wasm.wasmPaths = init.wasmBase;
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.logLevel = 'error';
    const inst = init.installed;
    if (!inst) return unavailable(`the ${MODEL_LABEL[id]} model is not downloaded`);
    if (inst.format !== MODEL_FORMAT) return unavailable(`the ${MODEL_LABEL[id]} model is out of date: download it again`);
    const files = opfsFiles();
    const [onnx, metaFile] = modelFileNames(id);
    const [b, m] = await Promise.all([
      readModelFile(files, inst.version, onnx, inst.files[onnx]).then((x) => x.arrayBuffer()),
      readModelFile(files, inst.version, metaFile, inst.files[metaFile]).then((x) => x.text()),
    ]);
    buf = b;
    meta = JSON.parse(m) as RoformerMeta;
  } catch (e) {
    return unavailable(`model: ${String(e)}`);
  }

  // One session per chunk length: the graph has a dynamic `frames` axis that is fixed per session (faster than a dynamic run).
  interface Run {
    g: RofGeometry;
    session: Session;
    stream: RoformerStream;
    /** One block step in place: analyze + model + synthesize. */
    process: (l: Float32Array, r: Float32Array) => Promise<void>;
    wu: WarmUpResult;
  }
  const measure = async (g: RofGeometry, w: { skip: number; n: number }): Promise<Run> => {
    const session = await ort.InferenceSession.create(buf, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all', logSeverityLevel: 3, freeDimensionOverrides: { frames: g.frames } });
    try {
      const stream = new RoformerStream(meta, g);
      const input = new ort.Tensor('float32', stream.x, [1, g.frames, stream.x.length / g.frames]);
      const run = async (): Promise<Float32Array> => {
        const out = await session.run({ [session.inputNames[0]]: input });
        const t = out[session.outputNames[0]];
        const data = (await t.getData()) as Float32Array;
        t.dispose();
        return data;
      };
      // Noise in, noise out: the time of a step does not depend on the content.
      const nl = new Float32Array(g.block), nr = new Float32Array(g.block);
      const ol = new Float32Array(g.block), or = new Float32Array(g.block);
      for (let i = 0; i < g.block; i++) {
        nl[i] = (Math.random() * 2 - 1) * 0.3;
        nr[i] = (Math.random() * 2 - 1) * 0.3;
      }
      const wu = await warmUp(() => stream.process(nl, nr, run, ol, or), w);
      stream.reset();
      return { g, session, stream, process: (l, r) => stream.process(l, r, run, l, r), wu };
    } catch (e) {
      void session.release();
      throw e;
    }
  };
  // 1. Speed of this GPU: a step at the 2 s geometry. 2. Plan a chunk for the delay budget (or the smallest budget that
  // works, 2 s to 15 s, in auto mode). 3. Time the plan itself; when it is slower than predicted, correct the speed and plan again.
  const wantMs = init.delayMs ?? null;
  let chosen: Run | null = null;
  let note = '';
  try {
    const first = await measure(DEFAULT_ROF_GEOMETRY, { skip: 2, n: 6 });
    let baseMs = first.wu.p90;
    void first.session.release();
    for (let attempt = 0; attempt < 3 && !chosen; attempt++) {
      const g = wantMs === null ? planAuto(baseMs) : planRof((wantMs / 1000) * ML_SAMPLE_RATE, baseMs);
      if (!g) {
        note = wantMs === null ? `too slow on this device (a step takes ${baseMs.toFixed(0)} ms for 1.1 s of audio; even a ${MAX_DELAY_S} s delay is not enough)` : `too slow for a ${Math.round(wantMs / 1000)} s delay (a step takes ${baseMs.toFixed(0)} ms for 1.1 s of audio): use a longer delay or Auto`;
        break;
      }
      try {
        const r = await measure(g, { skip: 1, n: 4 });
        if (r.wu.p90 <= gateMs(g)) chosen = r;
        else {
          baseMs *= r.wu.p90 / stepMs(g.frames, baseMs);
          void r.session.release();
        }
      } catch (e) {
        baseMs *= 1.5; // most likely out of GPU memory at this chunk length
        note = `chunk of ${g.frames} frames failed: ${String(e)}`;
      }
    }
  } catch (e) {
    return unavailable(`warm-up: ${String(e)}`);
  }
  if (!chosen) return unavailable(note || 'too slow on this device');
  const { g, wu } = chosen;
  const geometry: MlGeometry = { block: g.block, resultOffset: g.overlap, latency: g.latency, warmupP90Ms: gateMs(g) };
  const createMs = performance.now() - t0;
  if (init.timing) console.info(`[all-mixer ml] ${id} chunk ${g.frames} frames (${((g.chunk / ML_SAMPLE_RATE)).toFixed(2)} s), block ${(g.block / ML_SAMPLE_RATE).toFixed(2)} s, overlap ${(g.overlap / ML_SAMPLE_RATE).toFixed(2)} s, delay ${(g.latency / ML_SAMPLE_RATE).toFixed(2)} s; warm-up p50 ${wu.p50.toFixed(1)} p90 ${wu.p90.toFixed(1)} p95 ${wu.p95.toFixed(1)} (gate ${geometry.warmupP90Ms.toFixed(1)}), ready after ${createMs.toFixed(0)} ms, ${adapterName}`);
  ctx.postMessage({ type: 'ready', p50: wu.p50, p90: wu.p90, p95: wu.p95, createMs, adapter: adapterName, geometry });

  const engine: BlockEngine = {
    block: g.block,
    resultOffset: g.overlap,
    reset: () => chosen!.stream.reset(),
    process: async (d) => {
      const l = d.subarray(0, g.block), r = d.subarray(g.block, 2 * g.block);
      const rmsIn = init.timing ? rms(l) : 0;
      await chosen!.process(l, r);
      if (init.timing) console.info(`[all-mixer ml] vocal level ${rms(l).toFixed(4)} of input ${rmsIn.toFixed(4)}${Number.isFinite(rms(l)) ? '' : ' (NOT FINITE)'}`);
      d.copyWithin(2 * g.block, 0, 2 * g.block); // the vocal is both Vk and the A cappella
    },
  };
  serve(init.port, engine, { stallMs: init.stallMs ?? 0, stallAfterMs: init.stallAfterMs ?? 5000 }, init.timing ? new MlTiming() : null);
}

const rms = (x: Float32Array): number => {
  let e = 0;
  for (let i = 0; i < x.length; i++) e += x[i] * x[i];
  return Math.sqrt(e / x.length);
};

/** What the block loop needs from a model pipeline. */
interface BlockEngine {
  block: number;
  resultOffset: number;
  reset(): void;
  /** Block buffer data ([in L, in R, …] → [Vk L, R, vocal L, R]) in place. */
  process(data: Float32Array): Promise<void>;
  /** Work that can wait until the block has been sent back. */
  afterReply?(): Promise<void>;
  misses?(): number;
}

/** Block loop. Blocks are handled one at a time, in order; stale ones are returned unprocessed. */
function serve(port: MessagePort, engine: BlockEngine, dbg: StallOpts, timing: MlTiming | null): void {
  const { block } = engine;
  const bytes = bufferBytes({ ...GEOMETRY.mdx, block });
  const stall = makeStall(dbg); // debug flag; null when off
  let latestEpoch = -1; // newest epoch seen on the port
  let epoch = -1; // epoch the stream state belongs to
  let expected = NaN; // `start` of the next block in that epoch
  const queue: ArrayBuffer[] = [];
  let busy = false;

  const back = (buf: ArrayBuffer, head: Float64Array, start: number): void => {
    head[1] = start;
    port.postMessage(buf, [buf]);
  };

  const pump = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    for (let buf = queue.shift(); buf; buf = queue.shift()) {
      const head = new Float64Array(buf, 0, 2);
      const data = new Float32Array(buf, ML_HEADER_BYTES, 4 * block);
      const e = head[0], start = head[1];
      if (e < latestEpoch) {
        back(buf, head, -1); // stale: not worth an inference
        continue;
      }
      if (e !== epoch || start !== expected) {
        engine.reset(); // new stream (play, seek) or a block was lost
        epoch = e;
      }
      expected = start + block;
      const tIn = timing ? performance.now() : 0; // the block is at the worker
      let sent = false;
      try {
        await engine.process(data);
        if (stall) await stall();
        back(buf, head, start - engine.resultOffset);
        sent = true;
        const tBack = timing ? performance.now() : 0;
        const line = timing?.block(tBack - tIn, engine.misses?.() ?? 0);
        if (line) console.log(line);
        if (engine.afterReply) {
          await engine.afterReply(); // after the reply, so MDX results never wait for it
          timing?.catchUp(performance.now() - tBack);
        }
      } catch {
        engine.reset();
        epoch = -1;
        if (!sent) back(buf, head, -1);
      }
    }
    busy = false;
  };

  port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
    const buf = ev.data;
    if (!(buf instanceof ArrayBuffer) || buf.byteLength !== bytes) return;
    latestEpoch = Math.max(latestEpoch, new Float64Array(buf, 0, 1)[0]);
    queue.push(buf);
    void pump();
  };
  port.start();
}

interface GPUAdapterLike {
  isFallbackAdapter?: boolean;
  info?: { vendor?: string; architecture?: string; description?: string };
}

ctx.onmessage = (e) => {
  if (e.data?.type === 'init') void start(e.data);
};
