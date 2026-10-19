// ML worker (runs inside the ml.html iframe, which gets a real WebGPU adapter): receives block
// buffers from the separator worklet on a MessagePort, runs MDX-Net 9482 (vocal) and the Spleeter vocals
// model (Karaoke mask) with onnxruntime-web (webgpu EP only, one run in flight at a time) and sends the
// same buffers back with the Vk and vocal blocks (src/ml/pipeline.ts). With model 'roformer' it runs the
// Mel-Band RoFormer core instead (src/ml/roformer.ts): the vocal block is both Vk and the A cappella. With `drums`
// either engine is wrapped by the drum stage (src/ml/drum-engine.ts): SCNet Tran Small takes the drums out of the
// instrumental and the reply carries them as two more planes.
import {
  ML_BLOCK,
  ML_HEADER_BYTES,
  ML_SAMPLE_RATE,
  ML_WARMUP_P90_MS,
  ML_RESULT_OFFSET,
  type FromMlWorker,
  type MlGeometry,
  type MlWorkerInit,
} from '../worklet/protocol';
import { CTX, BINS } from './stream';
import { MDX_BINS } from './mdx';
import { MDX_T_MIN, planMdx } from './mdx-plan';
import { MlPipeline, type Models } from './pipeline';
import { warmUp, warmUpGated, type WarmUpResult } from './warmup';
import { makeStall, type StallOpts } from './stall';
import { MlTiming } from './timing';
import { adapterName as nameOfAdapter } from '../shared/gpu';
import { opfsFiles, readModelFile } from '../shared/model-files';
import { MODEL_FORMAT, MODEL_LABEL, modelFileNames, type InstalledModel, type ModelId } from '../shared/model-store';
import { RoformerStream, DEFAULT_ROF_GEOMETRY, type RoformerMeta } from './roformer';
import { DRUM_STAGE, MAX_DELAY_S, MIN_DELAY_S, drumRuns, gateMs, planMdxDrums, planRof, poolFor, stepMs, type RofGeometry, type StageCost, type StageShape } from './rof-plan';
import { withStages, type BlockEngine, type SplitStage } from './drum-engine';
import { GuitarStage, guitarGeometry, stageShape } from './guitar-stage';
import { lookupSpeed, speedKey } from './plan-cache';
import { DrumStage, SC_BINS, SC_FRAMES, SC_INPUT, type ScnetModelFn } from './scnet';

type Ort = typeof import('onnxruntime-web/webgpu');
type Session = Awaited<ReturnType<Ort['InferenceSession']['create']>>;
const costOf = (s: Split): StageCost => ({ ...s.shape, ms: s.ms });
const runsMs = (stages: readonly Split[]): number => stages.reduce((sum, s) => sum + s.ms, 0);

/** A split stage (the drum model, or the guitar model): its model call, the p90 of one run (ms) and what the planners need to know. */
interface Split {
  id: 'drums' | 'guitar';
  run: ScnetModelFn;
  ms: number;
  stage: SplitStage;
  shape: StageShape;
}

const ctx = self as unknown as { postMessage(m: FromMlWorker): void; onmessage: ((e: MessageEvent<MlWorkerInit>) => void) | null };

const unavailable = (reason: string): void => ctx.postMessage({ type: 'unavailable', reason });

async function start(init: MlWorkerInit): Promise<void> {
  // 1. WebGPU probe first: without a real adapter ORT is not even loaded.
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(options?: { powerPreference: 'high-performance' | 'low-power' }): Promise<GPUAdapterLike | null> } }).gpu;
  if (!gpu) return unavailable('no navigator.gpu in the worker');
  let adapter: GPUAdapterLike | null;
  try {
    adapter = await gpu.requestAdapter(init.gpu && init.gpu !== 'auto' ? { powerPreference: init.gpu } : undefined);
  } catch (e) {
    return unavailable(`requestAdapter failed: ${String(e)}`);
  }
  if (!adapter) return unavailable('no WebGPU adapter');
  if (adapter.isFallbackAdapter) return unavailable('only a fallback (software) WebGPU adapter');
  const info = adapter.info ?? {};
  const adapterName = nameOfAdapter(info);
  if (init.model !== 'mdx') return startRoformer(init, adapterName);

  // 2. ORT + models.
  let ort: Ort, session: Session, mdxSession: Session, mdxBuf: ArrayBuffer;
  const t0 = performance.now();
  try {
    ort = await import('onnxruntime-web/webgpu');
    ort.env.wasm.wasmPaths = init.wasmBase;
    ort.env.wasm.numThreads = 1; // no SharedArrayBuffer; the webgpu EP does the work
    ort.env.wasm.proxy = false;
    if (init.gpu && init.gpu !== 'auto') ort.env.webgpu.powerPreference = init.gpu; // ORT requests its own adapter
    ort.env.logLevel = 'error'; // models declare a dynamic dim; ORT warns VerifyOutputSizes per run
    const opts = { executionProviders: ['webgpu'], graphOptimizationLevel: 'all', logSeverityLevel: 3 } as const;
    const [mdxModel, splBuf] = await Promise.all([init.mdxUrl, init.modelUrl].map(async (u) => (await fetch(u)).arrayBuffer()));
    mdxBuf = mdxModel;
    mdxSession = await ort.InferenceSession.create(mdxBuf, opts);
    session = await ort.InferenceSession.create(splBuf, opts);
  } catch (e) {
    return unavailable(`model: ${String(e)}`);
  }
  const createMs = performance.now() - t0;

  let pipeline = new MlPipeline();
  const mdxInput = new ort.Tensor('float32', pipeline.mdx.x, [1, 4, MDX_BINS, MDX_T_MIN]);
  const splInput = new ort.Tensor('float32', pipeline.spl.x, [2, 1, CTX, BINS]);
  const run = (s: Session, input: unknown) => async (): Promise<Float32Array> => {
    // The input tensor owns the stream's buffer: refreshed in place, so one feed object is reused.
    const out = await s.run({ [s.inputNames[0]]: input as never });
    const t = out[s.outputNames[0]];
    const data = (await t.getData()) as Float32Array;
    t.dispose();
    return data;
  };
  let runMdx = run(mdxSession, mdxInput);
  const runSpl = run(session, splInput);

  // 3. Warm-up on noise: 3 untimed runs (shader compile, first upload; their time is added to
  // createMs), then 20 timed MDX block steps (analyze + model + synthesize), which is what has to
  // meet the block deadline. The gate uses p90 of n=20 (ignores the two slowest), so a cold-cache outlier is tolerated.
  // If p90 is still over the gate, one more attempt (skip 0, n 20, caches are warm) runs here, before
  // `ready`, and the attempt with the lower p90 wins. Worst case ~2 x 23 steps (~2.8 s each at ~140 ms).
  // The Spleeter model gets 3 untimed runs (shader compile).
  const noise = (n: number): Float32Array => Float32Array.from({ length: n }, () => Math.random() * 2 - 1);
  const nl = noise(pipeline.block), nr = noise(pipeline.block);
  const ol = new Float32Array(pipeline.block), or = new Float32Array(pipeline.block);
  let wu: WarmUpResult & { attempts: number };
  try {
    const step = () => pipeline.mdx.process(nl, nr, runMdx, ol, or);
    wu = await warmUpGated((retry) => warmUp(step, retry ? { skip: 0, n: 20 } : { skip: 3, n: 20 }), ML_WARMUP_P90_MS);
    const s0 = performance.now();
    for (let i = 0; i < 3; i++) await runSpl();
    wu.firstMs += performance.now() - s0;
  } catch (e) {
    return unavailable(`warm-up: ${String(e)}`);
  }
  pipeline.reset();
  // Split instrumental: the drum and guitar models join the engine, and the plan (delay, speed check) is the worker's own.
  let stages: Split[] = [];
  let geometry: MlGeometry | undefined;
  if (init.drums || init.guitar) {
    if (wu.p90 >= ML_WARMUP_P90_MS) return unavailable(`too slow on this device (p90 ${wu.p90.toFixed(1)} ms)`);
    const d = await loadStages(ort, init);
    if (typeof d === 'string') return unavailable(d);
    stages = d;
    geometry = planMdxDrums(wu.p90, stages.map(costOf)) ?? undefined;
    if (!geometry) return unavailable(`too slow for the split (the vocal model takes ${wu.p90.toFixed(0)} ms per block, ${stages.map((s) => `the ${s.id} model ${s.ms.toFixed(0)} ms per run`).join(', ')})`);
    geometry.drums = init.drums === true;
    geometry.guitar = init.guitar === true;
    geometry.pool = poolFor(runsMs(stages), (ML_BLOCK / ML_SAMPLE_RATE) * 1000); // stage runs stop the block loop
  }

  // 4. A longer segment for a delay limit above the default one: plan it from the speed measured above (linear in the
  // frames), time it on a session of its own (fixed T is faster than a dynamic run), and keep the default segment
  // when it is slower than predicted or does not fit the GPU.
  let baseMs = wu.p90;
  for (let attempt = 0; attempt < 3 && !stages.length; attempt++) {
    const plan = planMdx(((init.delayMs ?? MIN_DELAY_S * 1000) / 1000) * ML_SAMPLE_RATE, baseMs);
    if (!plan || plan.frames === MDX_T_MIN) break;
    try {
      const s = await ort.InferenceSession.create(mdxBuf, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all', logSeverityLevel: 3, freeDimensionOverrides: { T: plan.frames } });
      const p = new MlPipeline(undefined, undefined, true, plan.frames);
      const r = run(s, new ort.Tensor('float32', p.mdx.x, [1, 4, MDX_BINS, plan.frames]));
      const bl = noise(p.block), br = noise(p.block), bol = new Float32Array(p.block), bor = new Float32Array(p.block);
      const w = await warmUp(() => p.mdx.process(bl, br, r, bol, bor), { skip: 2, n: 8 });
      if (w.p90 <= plan.geometry.warmupP90Ms) {
        void mdxSession.release();
        mdxSession = s;
        pipeline = p;
        runMdx = r;
        geometry = plan.geometry;
        wu = { ...wu, p50: w.p50, p90: w.p90, p95: w.p95, firstMs: wu.firstMs + w.firstMs };
        break;
      }
      baseMs *= w.p90 / (baseMs * (plan.frames / MDX_T_MIN)); // slower than predicted: correct the speed, plan again
      void s.release();
    } catch (e) {
      if (init.timing) console.info(`[all-mixer ml] longer segment failed: ${String(e)}`);
      break; // most likely out of GPU memory
    }
  }
  const models: Models = { mdx: runMdx, spleeter: runSpl };
  const block = pipeline.block;
  if (init.timing && geometry) console.info(`[all-mixer ml] mdx segment ${pipeline.mdx.frames} frames, block ${(block / ML_SAMPLE_RATE).toFixed(2)} s, delay ${(geometry.latency / ML_SAMPLE_RATE).toFixed(2)} s (gate ${geometry.warmupP90Ms.toFixed(1)})`);
  if (init.timing) console.info(`[all-mixer ml] warm-up p50 ${wu.p50.toFixed(1)} p90 ${wu.p90.toFixed(1)} p95 ${wu.p95.toFixed(1)} (gate ${ML_WARMUP_P90_MS.toFixed(1)}), create ${(createMs + wu.firstMs).toFixed(0)} ms, ${adapterName}, ${wu.attempts > 1 ? 'retry' : 'first try'}`);
  ctx.postMessage({ type: 'ready', p50: wu.p50, p90: wu.p90, p95: wu.p95, createMs: createMs + wu.firstMs, adapter: adapterName, geometry });

  const mdxEngine: BlockEngine = {
    block,
    resultOffset: stages.length ? ML_RESULT_OFFSET : (geometry?.resultOffset ?? ML_RESULT_OFFSET), // withStages adds the stage wait itself
    reset: () => pipeline.reset(),
    // Vk in place over the input; the MDX vocal in the second half of the buffer
    process: (d) => pipeline.process(d.subarray(0, block), d.subarray(block, 2 * block), models, d.subarray(0, block), d.subarray(block, 2 * block), d.subarray(2 * block, 3 * block), d.subarray(3 * block)),
    afterReply: () => pipeline.catchUp(models.spleeter),
    misses: () => pipeline.splMisses,
  };
  const engine = stages.length ? withStages(mdxEngine, stages) : mdxEngine;
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
    if (init.gpu && init.gpu !== 'auto') ort.env.webgpu.powerPreference = init.gpu;
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
  // 1. Speed of this GPU: a step at the 2 s geometry (remembered from an earlier warm-up when there is one: the plan is timed and gated below anyway).
  // 2. Plan a chunk for the delay budget. 3. Time the plan itself; when it is slower than predicted, correct the speed and plan again.
  const wantMs = init.delayMs ?? MIN_DELAY_S * 1000;
  let chosen = null as Run | null; // set in `search`
  let stages: Split[] = [];
  let note = '';
  const speedKeyOf = speedKey({ model: id, modelVersion: init.installed?.version ?? 0, appVersion: init.appVersion ?? '', adapter: adapterName });
  const measureSpeed = async (): Promise<number> => {
    const first = await measure(DEFAULT_ROF_GEOMETRY, { skip: 2, n: 6 });
    void first.session.release();
    return first.wu.p90;
  };
  /** The speed the plan that was chosen is based on (after corrections). */
  let planBaseMs = 0;
  const search = async (start: number, w: { skip: number; n: number }): Promise<void> => {
    let baseMs = start;
    for (let attempt = 0; attempt < 3 && !chosen; attempt++) {
      const g = planRof((wantMs / 1000) * ML_SAMPLE_RATE, baseMs, stages.map(costOf));
      if (!g) {
        note = `too slow for a ${Math.round(wantMs / 1000)} s delay (a step takes ${baseMs.toFixed(0)} ms for 1.1 s of audio${stages.map((s) => `, a ${s.id} run ${s.ms.toFixed(0)} ms`).join('')})${wantMs < MAX_DELAY_S * 1000 ? ': try a longer delay limit' : ''}`;
        break;
      }
      try {
        const r = await measure(g, w);
        if (r.wu.p90 + stages.reduce((sum, s) => sum + drumRuns(g.block, s.shape.stride) * s.ms, 0) <= gateMs(g)) {
          chosen = r;
          planBaseMs = baseMs;
        } else {
          baseMs *= r.wu.p90 / stepMs(g.frames, baseMs);
          void r.session.release();
        }
      } catch (e) {
        baseMs *= 1.5; // most likely out of GPU memory at this chunk length
        note = `chunk of ${g.frames} frames failed: ${String(e)}`;
      }
    }
  };
  const remembered = lookupSpeed(init.speeds, speedKeyOf);
  try {
    if (init.drums || init.guitar) {
      const d = await loadStages(ort, init);
      if (typeof d === 'string') return unavailable(d);
      stages = d;
    }
    if (remembered !== null) await search(remembered, { skip: 1, n: 3 });
    // Nothing remembered, or it no longer holds (another load on the GPU): measure now.
    if (!chosen) {
      note = '';
      await search(await measureSpeed(), { skip: 1, n: 4 });
    }
  } catch (e) {
    return unavailable(`warm-up: ${String(e)}`);
  }
  if (!chosen) return unavailable(note || 'too slow on this device');
  const { g, wu } = chosen;
  const geometry: MlGeometry = { block: g.block, resultOffset: g.overlap + g.extra, latency: g.latency, warmupP90Ms: gateMs(g), ...(init.drums ? { drums: true } : {}), ...(init.guitar ? { guitar: true } : {}), ...(stages.length ? { pool: poolFor(runsMs(stages), (g.block / ML_SAMPLE_RATE) * 1000) } : {}) };
  const createMs = performance.now() - t0;
  if (init.timing) console.info(`[all-mixer ml] ${id} chunk ${g.frames} frames (${((g.chunk / ML_SAMPLE_RATE)).toFixed(2)} s), block ${(g.block / ML_SAMPLE_RATE).toFixed(2)} s, overlap ${(g.overlap / ML_SAMPLE_RATE).toFixed(2)} s, delay ${(g.latency / ML_SAMPLE_RATE).toFixed(2)} s; warm-up p50 ${wu.p50.toFixed(1)} p90 ${wu.p90.toFixed(1)} p95 ${wu.p95.toFixed(1)} (gate ${geometry.warmupP90Ms.toFixed(1)}), ready after ${createMs.toFixed(0)} ms, ${adapterName}`);
  ctx.postMessage({ type: 'ready', p50: wu.p50, p90: wu.p90, p95: wu.p95, createMs, adapter: adapterName, geometry, speed: { key: speedKeyOf, baseMs: planBaseMs } });

  const vocalEngine: BlockEngine = {
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
  const engine = stages.length ? withStages(vocalEngine, stages) : vocalEngine;
  serve(init.port, engine, { stallMs: init.stallMs ?? 0, stallAfterMs: init.stallAfterMs ?? 5000 }, init.timing ? new MlTiming() : null);
}

const rms = (x: Float32Array): number => {
  let e = 0;
  for (let i = 0; i < x.length; i++) e += x[i] * x[i];
  return Math.sqrt(e / x.length);
};

/** The stages that are on, drums first (the order of the reply planes). A string is the reason one cannot be used. */
async function loadStages(ort: Ort, init: MlWorkerInit): Promise<Split[] | string> {
  const out: Split[] = [];
  if (init.drums) {
    const d = await loadSplit(ort, init, 'drums', init.drumsInstalled);
    if (typeof d === 'string') return d;
    out.push(d);
  }
  if (init.guitar) {
    const g = await loadSplit(ort, init, 'guitar', init.guitarInstalled);
    if (typeof g === 'string') return g;
    out.push(g);
  }
  return out;
}

/**
 * The model of a split stage from OPFS and the p90 of one run (ms): SCNet Tran Small (one fp32 graph of a fixed
 * shape) for the drums, or becruily's Mel-Band RoFormer guitar model (guitar-stage.ts) at its chunk. A string is the
 * reason it cannot be used.
 */
async function loadSplit(ort: Ort, init: MlWorkerInit, id: 'drums' | 'guitar', inst: InstalledModel | undefined): Promise<Split | string> {
  if (!inst) return `the ${MODEL_LABEL[id]} model is not downloaded`;
  if (inst.format !== MODEL_FORMAT) return `the ${MODEL_LABEL[id]} model is out of date: download it again`;
  try {
    const files = opfsFiles();
    const [onnx, metaFile] = modelFileNames(id);
    const opts = { executionProviders: ['webgpu'], graphOptimizationLevel: 'all', logSeverityLevel: 3 } as const;
    const buf = await readModelFile(files, inst.version, onnx, inst.files[onnx]).then((x) => x.arrayBuffer());
    if (id === 'drums') {
      const session = await ort.InferenceSession.create(buf, opts);
      const run: ScnetModelFn = async (x) => {
        const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', x, [1, 4, SC_BINS, SC_FRAMES]) });
        const t = out[session.outputNames[0]];
        const data = (await t.getData()) as Float32Array;
        t.dispose();
        return data;
      };
      const noise = Float32Array.from({ length: SC_INPUT }, () => (Math.random() * 2 - 1) * 0.1);
      const wu = await warmUp(async () => void (await run(noise)), { skip: 2, n: 5 });
      return { id, run, ms: wu.p90, stage: new DrumStage(), shape: DRUM_STAGE };
    }
    const meta = JSON.parse(await readModelFile(files, inst.version, metaFile, inst.files[metaFile]).then((x) => x.text())) as RoformerMeta;
    const g = guitarGeometry();
    const stage = new GuitarStage(meta, g, { onRun: init.timing ? (ms) => console.info(`[all-mixer ml] ${id} run ${ms.toFixed(0)} ms (${(g.block / ML_SAMPLE_RATE).toFixed(1)} s block)`) : undefined });
    const frames = stage.roformer.frames;
    const session = await ort.InferenceSession.create(buf, { ...opts, freeDimensionOverrides: { frames } });
    const input = new ort.Tensor('float32', stage.roformer.x, [1, frames, stage.roformer.x.length / frames]);
    const run: ScnetModelFn = async () => {
      const out = await session.run({ [session.inputNames[0]]: input });
      const t = out[session.outputNames[0]];
      const data = (await t.getData()) as Float32Array;
      t.dispose();
      return data;
    };
    // A whole step (analyze + model + synthesize) on noise: the time does not depend on the content.
    const n = Float32Array.from({ length: g.block }, () => (Math.random() * 2 - 1) * 0.3);
    const o = new Float32Array(g.block);
    const wu = await warmUp(() => stage.roformer.process(n, n, run, o, o), { skip: 1, n: 3 }); // a long chunk takes seconds
    stage.reset();
    if (init.timing) console.info(`[all-mixer ml] ${id}: chunk ${frames} frames, block ${(g.block / ML_SAMPLE_RATE).toFixed(1)} s, run p90 ${wu.p90.toFixed(0)} ms, lag ${(stage.lag / ML_SAMPLE_RATE).toFixed(1)} s`);
    return { id, run, ms: wu.p90, stage, shape: stageShape(g) };
  } catch (e) {
    return `${id} model: ${String(e)}`;
  }
}

/** Block loop. Blocks are handled one at a time, in order; stale ones are returned unprocessed. */
function serve(port: MessagePort, engine: BlockEngine, dbg: StallOpts, timing: MlTiming | null): void {
  const { block } = engine;
  const planes = engine.planes ?? 4;
  const bytes = ML_HEADER_BYTES + planes * block * 4;
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
      const data = new Float32Array(buf, ML_HEADER_BYTES, planes * block);
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
      } catch (e) {
        if (timing) console.warn(`[all-mixer ml] block failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
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
