// ML worker (runs inside the ml.html iframe, which gets a real WebGPU adapter): receives block
// buffers from the separator worklet on a MessagePort, runs the streaming Spleeter vocals model
// with onnxruntime-web (webgpu EP only) and sends the same buffers back with the vocal block.
import {
  ML_BLOCK,
  ML_BUFFER_BYTES,
  ML_HEADER_BYTES,
  ML_RESULT_OFFSET,
  type FromMlWorker,
  type MlWorkerInit,
} from '../worklet/protocol';
import { CTX, BINS, SpleeterStream } from './stream';
import { warmUp } from './warmup';
import { makeStall, type StallOpts } from './stall';

type Ort = typeof import('onnxruntime-web/webgpu');

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

  // 2. ORT + model.
  let ort: Ort, session: Awaited<ReturnType<Ort['InferenceSession']['create']>>;
  const t0 = performance.now();
  try {
    ort = await import('onnxruntime-web/webgpu');
    ort.env.wasm.wasmPaths = init.wasmBase;
    ort.env.wasm.numThreads = 1; // no SharedArrayBuffer; the webgpu EP does the work
    ort.env.wasm.proxy = false;
    const model = await (await fetch(init.modelUrl)).arrayBuffer();
    ort.env.logLevel = 'error'; // model declares a dynamic output dim; ORT warns VerifyOutputSizes per run
    session = await ort.InferenceSession.create(model, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all', logSeverityLevel: 3 });
  } catch (e) {
    return unavailable(`model: ${String(e)}`);
  }
  const createMs = performance.now() - t0;

  const stream = new SpleeterStream();
  const input = new ort.Tensor('float32', stream.x, [2, 1, CTX, BINS]);
  const name = session.inputNames[0];
  const outName = session.outputNames[0];
  const model = async (x: Float32Array): Promise<Float32Array> => {
    // `x` is the tensor's own buffer: refreshed in place, so one feed object is reused.
    void x;
    const out = await session.run({ [name]: input });
    const t = out[outName];
    const data = (await t.getData()) as Float32Array;
    t.dispose();
    return data;
  };

  // 3. Warm-up on noise: 2 untimed runs (shader compile, first upload; their time is added to
  // createMs), then 10 timed runs of the whole block step (analyze + model + synthesize), which is
  // what has to meet the block deadline.
  const nl = new Float32Array(ML_BLOCK), nr = new Float32Array(ML_BLOCK);
  const ol = new Float32Array(ML_BLOCK), or = new Float32Array(ML_BLOCK);
  let wu: Awaited<ReturnType<typeof warmUp>>;
  try {
    for (let i = 0; i < ML_BLOCK; i++) {
      nl[i] = Math.random() * 2 - 1;
      nr[i] = Math.random() * 2 - 1;
    }
    wu = await warmUp(() => stream.process(nl, nr, model, ol, or), { skip: 2, n: 10 });
  } catch (e) {
    return unavailable(`warm-up: ${String(e)}`);
  }
  stream.reset();
  ctx.postMessage({ type: 'ready', p50: wu.p50, p95: wu.p95, createMs: createMs + wu.firstMs, adapter: adapterName });

  serve(init.port, stream, model, { stallMs: init.stallMs ?? 0, stallAfterMs: init.stallAfterMs ?? 5000 });
}

/** Block loop. Blocks are handled one at a time, in order; stale ones are returned unprocessed. */
function serve(port: MessagePort, stream: SpleeterStream, model: (x: Float32Array) => Promise<Float32Array>, dbg: StallOpts): void {
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
      const head = new Float64Array(buf, 0, 3);
      const data = new Float32Array(buf, ML_HEADER_BYTES, 4 * ML_BLOCK);
      const e = head[0], start = head[1];
      if (e < latestEpoch) {
        back(buf, head, -1); // stale: not worth an inference
        continue;
      }
      if (e !== epoch || start !== expected) {
        stream.reset(); // new stream (play, seek) or a block was lost
        epoch = e;
      }
      expected = start + ML_BLOCK;
      try {
        const l = data.subarray(0, ML_BLOCK), r = data.subarray(ML_BLOCK, 2 * ML_BLOCK);
        stream.setSharpen(head[2]);
        // soft vocal in place over the input; the sharpened vocal in the second half of the buffer
        await stream.process(l, r, model, l, r, data.subarray(2 * ML_BLOCK, 3 * ML_BLOCK), data.subarray(3 * ML_BLOCK));
        if (stall) await stall();
        back(buf, head, start - ML_RESULT_OFFSET);
      } catch {
        stream.reset();
        epoch = -1;
        back(buf, head, -1);
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
