// Types for separator.js (kept as plain JS so the spike benches run it directly in Node).

export interface SeparatorOptions {
  fftSize: number;
  hop: number;
  lowCutHz: number;
  lowFullHz: number;
  highFullHz: number;
  highCutHz: number;
  centerFloor: number;
  centerPower: number;
  hpssTimeFrames: number;
  hpssFreqBins: number;
  percPower: number;
  maskRelease: number;
  useCenter: boolean;
  useBand: boolean;
  usePerc: boolean;
}

export const DEFAULTS: Readonly<SeparatorOptions>;

export class DspSeparator {
  constructor(sampleRate: number, opts?: Partial<SeparatorOptions>);
  /** Delay in samples between input and both outputs. */
  readonly latency: number;
  reset(): void;
  /** vocal + instrumental = input delayed by `latency`. All arrays must have the same length. */
  process(
    inL: Float32Array,
    inR: Float32Array,
    vocL: Float32Array,
    vocR: Float32Array,
    insL: Float32Array,
    insR: Float32Array,
  ): void;
}

export function phaseCancel(
  inL: Float32Array,
  inR: Float32Array,
  vocL: Float32Array,
  vocR: Float32Array,
  insL: Float32Array,
  insR: Float32Array,
): void;
