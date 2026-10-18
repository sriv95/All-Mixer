import type { InstalledModel } from '../shared/model-store';
// Contract between the content-script audio engine and the separator AudioWorklet.
// Imported by both sides, so it must not touch DOM or worklet globals.

export const SEPARATOR_PROCESSOR = 'all-mixer-separator';
/** Path of the bundled worklet module inside the extension (web-accessible). */
export const SEPARATOR_MODULE_PATH = 'worklet/separator-worklet.js';

/**
 * ML engine geometry, at the model rate. The graph runs at this rate so the worklet and the
 * models share one sample clock (no resampler).
 */
export const ML_SAMPLE_RATE = 44100;
/** MDX-Net 9482 segment: T = 64 STFT frames (n_fft 4096, hop 1024) = (T − 1)·1024 + 4096 samples. */
export const MDX_SEGMENT = 68608;
/** Segment hop (50 % overlap) = samples per block sent to the ML worker. */
export const ML_BLOCK = MDX_SEGMENT / 2;
/**
 * Karaoke tail: the Karaoke combine re-runs an STFT (n_fft 4096) over x − vocal, so output sample n is
 * complete only once the frames that cover it have their whole 4096 input samples. Fixed lag of one frame.
 */
export const KARAOKE_TAIL = 4096;
/** A returned block covers input samples [blockStart − this, blockStart − this + ML_BLOCK). */
export const ML_RESULT_OFFSET = ML_BLOCK + KARAOKE_TAIL;
/** Algorithmic delay: a cross-fade region needs its whole next segment (2·ML_BLOCK), plus the Karaoke tail. */
export const ML_ALGO_SAMPLES = MDX_SEGMENT + KARAOKE_TAIL;
/** Compute slack: 319 ms, ≥ 2× the MDX response p95 (152 ms WebGPU compute, SRI-100/116). */
export const ML_SLACK_SAMPLES = 14080;
/** One render quantum, so the worklet can decide ML vs the original mix for a block one quantum before it starts. */
export const ML_QUANTUM = 128;
/** ML output delay: 72704 + 14080 + 128 = 86912 samples = 1970.9 ms at 44.1 kHz. */
export const ML_LATENCY_SAMPLES = ML_ALGO_SAMPLES + ML_SLACK_SAMPLES + ML_QUANTUM;

/** Gain AudioParams (linear, 0–6 = 0–600 %). */
export const PARAM_VOCAL = 'vocalGain';
export const PARAM_INSTRUMENTAL = 'instrumentalGain';

/** bypass = the original mix, unprocessed, no added delay. */
export type MlEngine = 'bypass' | 'ml';
export type MlReason = 'auto' | 'deadline-miss';

export type ToWorklet =
  /** Start (reset + run the separator, in `engine`, default bypass) or stop (output silence, no CPU). */
  | { type: 'active'; on: boolean; engine?: MlEngine; reason?: MlReason }
  /** Drop buffered audio, e.g. after a seek. */
  | { type: 'flush' }
  /** Pause: fade to silence and freeze the delay line (nothing read, nothing written, no input to the ML stream). */
  | { type: 'hold' }
  /** Play: fade back in and resume from the frozen position. */
  | { type: 'release' }
  /** Direct channel to the ML worker (blocks out, vocal blocks back). */
  | { type: 'ml-port'; port: MessagePort }
  /** Switch engine while running. The worklet answers with an `engine` message. */
  | { type: 'engine'; engine: MlEngine; reason: MlReason }
  /** Block geometry of the ML model that will use the port. Only valid on the original mix; resets the ML stream. */
  | { type: 'model'; model: MlModel }
  /** The same, for a geometry the ML worker chose at run time (RoFormer chunk planning). */
  | { type: 'geometry'; geometry: MlGeometry };

export type FromWorklet =
  /**
   * The engine changed (requested, or ML → bypass after missed deadlines).
   * `at` is the context time of the first input sample played with the new delay (input time:
   * that sample is heard `newDelay / sampleRate` later).
   */
  | { type: 'engine'; engine: MlEngine; reason: MlReason; at: number };

/**
 * Block buffers on the ML port: [epoch f64, start f64, then f32 × ML_BLOCK ×4].
 * The worklet sends input L, R at `start`. The worker sends the same buffer back with
 * "vocal for the instrumental" L, R (the Karaoke instrumental is x − this) followed by the MDX vocal
 * L, R (A cappella), and `start` moved back by ML_RESULT_OFFSET, or `start` = −1 when it has no result.
 * Buffers are transferred both ways, so the pool is reused without allocation.
 */
export const ML_HEADER_BYTES = 16;
export const ML_BUFFER_BYTES = ML_HEADER_BYTES + 4 * ML_BLOCK * 4;

/** Control messages between the content script and the ML worker (via the ml.html iframe). */
export const ML_PAGE_PATH = 'ml/ml.html';
export const ML_INIT = 'all-mixer-ml-init';
/** The ML_INIT message also carries `model: MlModel` and `delayMs` (the delay budget: it sets the RoFormer chunk and the MDX segment; null = the 2 s default). */
/** Warm-up gate: p90 of 20 timed runs (ignores the two slowest) of one MDX block step (analyze + model + synthesize) must leave ≥ 1.5× in the 319 ms compute slack (~213 ms). The runtime deadline-miss fallback is the final guard. */
export const ML_WARMUP_P90_MS = (ML_SLACK_SAMPLES / ML_SAMPLE_RATE) * 1000 / 1.5;

/**
 * ML models the engine can run. 'mdx' is the shipped MDX-Net 9482 + Spleeter pipeline. The others are Mel-Band
 * RoFormers (fp16), downloaded on request (src/shared/model-store.ts ModelId): one big model each, no Spleeter mask,
 * short chunks so they fit the delay. 'roformer' = unwa's mel_band_roformer_kim_ft_unwa (menu: High quality),
 * 'deux' = becruily's 2-stem model, vocal stem (menu: Best quality, needs a good GPU).
 */
export type MlModel = 'mdx' | 'roformer' | 'deux';
export const ML_MODELS: readonly MlModel[] = ['mdx', 'roformer', 'deux'];

/** Block geometry of one model: what the worklet, the worker and the delay math must agree on. */
export interface MlGeometry {
  /** Samples per block sent to the worker. */
  block: number;
  /** A returned block covers input [blockStart − resultOffset, + block). */
  resultOffset: number;
  /** Output delay of the ML engine, samples. */
  latency: number;
  /** Warm-up gate: the p90 of one block step must stay under this (ms). */
  warmupP90Ms: number;
}

/**
 * RoFormer: the model sees a chunk of 111 STFT hops (n_fft 2048, hop 441; 112 frames with centre padding)
 * = 48951 samples = the newest block plus the 9271 samples before it. It runs once per block (MDX's 50 % overlap
 * would double the cost; one 112-frame fp16 run is ~620 ms on an M1 with WebGPU). Block b completes input
 * [bH − R, (b + 1)H − R), R = 8832 (0.2 s): the first R samples cross-fade with the tail of the previous chunk;
 * the first 439 samples of the chunk are context only (the model is worst at its edges).
 * Block, overlap and slack are whole render quanta: the worklet core needs them aligned to its 128-sample grid.
 */
export const ROF_BLOCK = 39680; // 310 quanta
export const ROF_OVERLAP = 8832; // 69 quanta
export const ROF_CHUNK = 48951;
/** Compute slack 885 ms (the model step has to finish inside it); latency stays under 2 s: 87680 = 1.988 s. */
const ROF_SLACK_SAMPLES = 39040; // 305 quanta
export const ROF_LATENCY_SAMPLES = ROF_BLOCK + ROF_OVERLAP + ROF_SLACK_SAMPLES + ML_QUANTUM;

const ROF_GEOMETRY: MlGeometry = {
  block: ROF_BLOCK,
  resultOffset: ROF_OVERLAP,
  latency: ROF_LATENCY_SAMPLES,
  warmupP90Ms: ((ROF_SLACK_SAMPLES / ML_SAMPLE_RATE) * 1000) / 1.15,
};

export const GEOMETRY: Readonly<Record<MlModel, MlGeometry>> = {
  mdx: { block: ML_BLOCK, resultOffset: ML_RESULT_OFFSET, latency: ML_LATENCY_SAMPLES, warmupP90Ms: ML_WARMUP_P90_MS },
  roformer: ROF_GEOMETRY,
  deux: ROF_GEOMETRY,
};

export const bufferBytes = (g: MlGeometry): number => ML_HEADER_BYTES + 4 * g.block * 4;

export type ToMlWorker = { type: 'dispose' };

export type FromMlWorker =
  | {
      type: 'ready';
      /** Warm-up inference times, ms. */
      p50: number;
      p90: number;
      p95: number;
      createMs: number;
      adapter: string;
      /** RoFormer: the block geometry the worker planned and checked (the selector sends it to the worklet); MDX: absent. */
      geometry?: MlGeometry;
    }
  /** No usable WebGPU (none, fallback adapter, or the model failed to load). */
  | { type: 'unavailable'; reason: string };

/** Page → worker init (iframe page forwards the ML port from the content script). */
export type MlWorkerInit = { type: 'init'; model: MlModel; port: MessagePort; modelUrl: string; mdxUrl: string; installed?: InstalledModel; delayMs?: number | null; wasmBase: string; stallMs?: number; stallAfterMs?: number; timing?: boolean };
