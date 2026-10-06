// ML worker (runs inside the ml.html iframe, which gets a real WebGPU adapter): receives block
// buffers from the separator worklet on a MessagePort, runs MDX-Net 9482 (vocal) and the Spleeter vocals
// model (Karaoke mask) with onnxruntime-web (webgpu EP only, one run in flight at a time) and sends the
// same buffers back with the Vk and vocal blocks (src/ml/pipeline.ts).
import {
  ML_BLOCK,
  ML_BUFFER_BYTES,
  ML_HEADER_BYTES,
  ML_RESULT_OFFSET,
  type FromMlWorker,
  type MlWorkerInit,
} from '../worklet/protocol';
import { CTX, BINS } from './stream';
import { MDX_BINS, MDX_T } from './mdx';
import { MlPipeline, type Models } from './pipeline';
import { warmUp } from './warmup';
import { makeStall, type StallOpts } from './stall';
import { MlTiming } from './timing';

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

  // 3. Warm-up on noise: 2 untimed runs (shader compile, first upload; their time is added to
  // createMs), then 10 timed MDX block steps (analyze + model + synthesize), which is what has to
  // meet the block deadline. The Spleeter model gets 3 untimed runs (shader compile).
  const nl = new Float32Array(ML_BLOCK), nr = new Float32Array(ML_BLOCK);
  const ol = new Float32Array(ML_BLOCK), or = new Float32Array(ML_BLOCK);
  let wu: Awaited<ReturnType<typeof warmUp>>;
  try {
    for (let i = 0; i < ML_BLOCK; i++) {
      nl[i] = Math.random() * 2 - 1;
      nr[i] = Math.random() * 2 - 1;
    }
    wu = await warmUp(() => pipeline.mdx.process(nl, nr, runMdx, ol, or), { skip: 2, n: 10 });
    const s0 = performance.now();
    for (let i = 0; i < 3; i++) await runSpl();
    wu.firstMs += performance.now() - s0;
  } catch (e) {
    return unavailable(`warm-up: ${String(e)}`);
  }
  pipeline.reset();
  ctx.postMessage({ type: 'ready', p50: wu.p50, p95: wu.p95, createMs: createMs + wu.firstMs, adapter: adapterName });

  serve(init.port, pipeline, models, { stallMs: init.stallMs ?? 0, stallAfterMs: init.stallAfterMs ?? 5000 }, init.timing ? new MlTiming() : null);
}

/** Block loop. Blocks are handled one at a time, in order; stale ones are returned unprocessed. */
function serve(port: MessagePort, pipeline: MlPipeline, models: Models, dbg: StallOpts, timing: MlTiming | null): void {
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
      const data = new Float32Array(buf, ML_HEADER_BYTES, 4 * ML_BLOCK);
      const e = head[0], start = head[1];
      if (e < latestEpoch) {
        back(buf, head, -1); // stale: not worth an inference
        continue;
      }
      if (e !== epoch || start !== expected) {
        pipeline.reset(); // new stream (play, seek) or a block was lost
        epoch = e;
      }
      expected = start + ML_BLOCK;
      const tIn = timing ? performance.now() : 0; // the block is at the worker
      let sent = false;
      try {
        const l = data.subarray(0, ML_BLOCK), r = data.subarray(ML_BLOCK, 2 * ML_BLOCK);
        // Vk in place over the input; the MDX vocal in the second half of the buffer
        await pipeline.process(l, r, models, l, r, data.subarray(2 * ML_BLOCK, 3 * ML_BLOCK), data.subarray(3 * ML_BLOCK));
        if (stall) await stall();
        back(buf, head, start - ML_RESULT_OFFSET);
        sent = true;
        const tBack = timing ? performance.now() : 0;
        const line = timing?.block(tBack - tIn, pipeline.splMisses);
        if (line) console.log(line);
        await pipeline.catchUp(models.spleeter); // after the reply, so MDX results never wait for it
        timing?.catchUp(performance.now() - tBack);
      } catch {
        pipeline.reset();
        epoch = -1;
        if (!sent) back(buf, head, -1);
      }
    }
    busy = false;
  };

  port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
    const buf = ev.data;
    if (!(buf instanceof ArrayBuffer) || buf.byteLength !== ML_BUFFER_BYTES) return;
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
