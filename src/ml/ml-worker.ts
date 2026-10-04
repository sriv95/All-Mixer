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
import { CTX, BINS, SpleeterStream, TENSOR_LEN } from './stream';

type Ort = typeof import('onnxruntime-web/webgpu');

const ctx = self as unknown as { postMessage(m: FromMlWorker): void; onmessage: ((e: MessageEvent<MlWorkerInit>) => void) | null };

const pct = (a: number[], p: number): number => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
};

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
    session = await ort.InferenceSession.create(model, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' });
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

  // 3. Warm-up: 10 inferences at T = 64 on noise (first one compiles the shaders).
  const times: number[] = [];
  try {
    for (let i = 0; i < TENSOR_LEN; i++) stream.x[i] = Math.random() * 40;
    for (let i = 0; i < 10; i++) {
      const t = performance.now();
      await model(stream.x);
      times.push(performance.now() - t);
    }
  } catch (e) {
    return unavailable(`warm-up: ${String(e)}`);
  }
  stream.reset();
  ctx.postMessage({ type: 'ready', p50: pct(times, 0.5), p95: pct(times, 0.95), createMs, adapter: adapterName });

  serve(init.port, stream, model);
}

/** Block loop. Blocks are handled one at a time, in order; stale ones are returned unprocessed. */
function serve(port: MessagePort, stream: SpleeterStream, model: (x: Float32Array) => Promise<Float32Array>): void {
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
      const data = new Float32Array(buf, ML_HEADER_BYTES, 2 * ML_BLOCK);
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
        const l = data.subarray(0, ML_BLOCK), r = data.subarray(ML_BLOCK);
        await stream.process(l, r, model, l, r); // in place: the output goes over the input
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
