// Contract between the content-script audio engine and the separator AudioWorklet.
// Imported by both sides, so it must not touch DOM or worklet globals.

export const SEPARATOR_PROCESSOR = 'all-mixer-separator';
/** Path of the bundled worklet module inside the extension (web-accessible). */
export const SEPARATOR_MODULE_PATH = 'worklet/separator-worklet.js';

/** STFT size of the DSP engine. The worklet adds no extra quantum: output n = input n − this. */
export const DSP_LATENCY_SAMPLES = 2048;

/** Gain AudioParams (linear, 0–6 = 0–600 %). */
export const PARAM_VOCAL = 'vocalGain';
export const PARAM_INSTRUMENTAL = 'instrumentalGain';

export type ToWorklet =
  /** Start (reset + run the separator) or stop (output silence, no CPU). */
  | { type: 'active'; on: boolean }
  /** Drop buffered audio, e.g. after a seek. */
  | { type: 'flush' };
