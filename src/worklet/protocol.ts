// Contract between the content-script audio engine and the separator AudioWorklet.
// Imported by both sides, so it must not touch DOM or worklet globals.

export const SEPARATOR_PROCESSOR = 'all-mixer-separator';
/** Path of the bundled worklet module inside the extension (web-accessible). */
export const SEPARATOR_MODULE_PATH = 'worklet/separator-worklet.js';

/** STFT size of the DSP engine. The worklet adds no extra quantum: output n = input n − this. */
export const DSP_LATENCY_SAMPLES = 2048;

/**
 * ML (Spleeter) engine geometry, at the model rate. The graph runs at this rate
 * so the worklet and the model share one sample clock (no resampler).
 */
export const ML_SAMPLE_RATE = 44100;
/** Samples per block sent to the ML worker (4 STFT hops). */
export const ML_BLOCK = 4096;
/**
 * ML output delay: STFT 4096 + (4 − 1 + lookahead 2) · hop 1024 + one block of
 * compute budget (13312, SRI-5 §3) + one render quantum, so the worklet can
 * decide ML vs DSP for a block one quantum before it starts and crossfade.
 */
export const ML_LATENCY_SAMPLES = 13312 + 128;
/** A returned vocal block covers input samples [blockStart − this, blockStart − this + ML_BLOCK). */
export const ML_RESULT_OFFSET = 5120;

/** Gain AudioParams (linear, 0–6 = 0–600 %). */
export const PARAM_VOCAL = 'vocalGain';
export const PARAM_INSTRUMENTAL = 'instrumentalGain';

export type MlEngine = 'dsp' | 'ml';
export type MlReason = 'auto' | 'deadline-miss' | 'user';

export type ToWorklet =
  /** Start (reset + run the separator, in `engine`, default dsp) or stop (output silence, no CPU). */
  | { type: 'active'; on: boolean; engine?: MlEngine; reason?: MlReason }
  /** Drop buffered audio, e.g. after a seek. */
  | { type: 'flush' }
  /** Direct channel to the ML worker (blocks out, vocal blocks back). */
  | { type: 'ml-port'; port: MessagePort }
  /** Switch engine while running. The worklet answers with an `engine` message. */
  | { type: 'engine'; engine: MlEngine; reason: MlReason };

export type FromWorklet =
  /**
   * The engine changed (requested, or ML → DSP after missed deadlines).
   * `at` is the context time of the first input sample played with the new delay (input time:
   * that sample is heard `newDelay / sampleRate` later).
   */
  | { type: 'engine'; engine: MlEngine; reason: MlReason; at: number };

/**
 * Block buffers on the ML port: [epoch f64, start f64, L f32 × ML_BLOCK, R f32 × ML_BLOCK].
 * The worklet sends input at `start`; the worker sends the same buffer back with the vocal
 * and `start` moved back by ML_RESULT_OFFSET, or `start` = −1 when it has no result.
 * Buffers are transferred both ways, so the pool is reused without allocation.
 */
export const ML_HEADER_BYTES = 16;
export const ML_BUFFER_BYTES = ML_HEADER_BYTES + 2 * ML_BLOCK * 4;

/** Control messages between the content script and the ML worker (via the ml.html iframe). */
export const ML_PAGE_PATH = 'ml/ml.html';
export const ML_INIT = 'all-mixer-ml-init';
/** Warm-up gate: 60 % of a 92.9 ms block (SRI-5 §4). */
export const ML_WARMUP_P95_MS = 56;

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
