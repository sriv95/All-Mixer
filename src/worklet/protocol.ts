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
const ML_QUANTUM = 128;
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
  /** Direct channel to the ML worker (blocks out, vocal blocks back). */
  | { type: 'ml-port'; port: MessagePort }
  /** Switch engine while running. The worklet answers with an `engine` message. */
  | { type: 'engine'; engine: MlEngine; reason: MlReason };

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
/** Warm-up gate: p95 of one MDX block step (analyze + model + synthesize) must leave ≥ 1.5× in the 319 ms compute slack (~213 ms). The runtime deadline-miss fallback is the final guard. */
export const ML_WARMUP_P95_MS = (ML_SLACK_SAMPLES / ML_SAMPLE_RATE) * 1000 / 1.5;

export type ToMlWorker = { type: 'dispose' };

export type FromMlWorker =
  | {
      type: 'ready';
      /** Warm-up inference times, ms. */
      p50: number;
      p95: number;
      createMs: number;
      adapter: string;
    }
  /** No usable WebGPU (none, fallback adapter, or the model failed to load). */
  | { type: 'unavailable'; reason: string };

/** Page → worker init (iframe page forwards the ML port from the content script). */
export type MlWorkerInit = { type: 'init'; port: MessagePort; modelUrl: string; mdxUrl: string; wasmBase: string; stallMs?: number; stallAfterMs?: number; timing?: boolean };
