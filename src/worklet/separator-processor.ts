// AudioWorklet: DSP vocal / instrumental separation with per-stem gain.
//   out = vocalGain · vocal + instrumentalGain · instrumental   (stereo)
// vocal + instrumental = input delayed by DSP_LATENCY_SAMPLES, so 100 % / 100 % is the original.
// process() allocates nothing; every buffer is created in the constructor.
import { DspSeparator } from './dsp/separator.js';
import { DSP_LATENCY_SAMPLES, PARAM_INSTRUMENTAL, PARAM_VOCAL, SEPARATOR_PROCESSOR, type ToWorklet } from './protocol';

// AudioWorkletGlobalScope is not in TypeScript's DOM lib.
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessor): void;

const QUANTUM = 128;

class SeparatorProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: PARAM_VOCAL, defaultValue: 1, minValue: 0, maxValue: 6, automationRate: 'k-rate' },
      { name: PARAM_INSTRUMENTAL, defaultValue: 1, minValue: 0, maxValue: 6, automationRate: 'k-rate' },
    ];
  }

  private readonly sep = new DspSeparator(sampleRate);
  private readonly zero = new Float32Array(QUANTUM);
  private vL = new Float32Array(QUANTUM);
  private vR = new Float32Array(QUANTUM);
  private iL = new Float32Array(QUANTUM);
  private iR = new Float32Array(QUANTUM);
  private active = false;
  // Gains applied at the end of the previous quantum; each quantum ramps linearly from these.
  private vg = 1;
  private ig = 1;

  constructor() {
    super();
    if (this.sep.latency !== DSP_LATENCY_SAMPLES) throw new Error('separator latency changed; update DSP_LATENCY_SAMPLES');
    this.port.onmessage = (e: MessageEvent<ToWorklet>) => {
      const msg = e.data;
      if (msg.type === 'active') {
        if (msg.on && !this.active) this.sep.reset();
        this.active = msg.on;
      } else if (msg.type === 'flush') {
        this.sep.reset();
      }
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean {
    const out = outputs[0];
    const oL = out[0];
    const oR = out.length > 1 ? out[1] : oL;
    if (!this.active) {
      oL.fill(0);
      oR.fill(0);
      return true;
    }
    const inp = inputs[0];
    const inL = inp.length > 0 ? inp[0] : this.zero;
    const inR = inp.length > 1 ? inp[1] : inL;
    const len = oL.length;
    if (this.vL.length !== len) this.resize(len);
    const { vL, vR, iL, iR } = this;
    this.sep.process(inL, inR, vL, vR, iL, iR);

    const vg1 = parameters[PARAM_VOCAL][0];
    const ig1 = parameters[PARAM_INSTRUMENTAL][0];
    const vg0 = this.vg;
    const ig0 = this.ig;
    if (vg0 === vg1 && ig0 === ig1) {
      for (let i = 0; i < len; i++) {
        oL[i] = vg1 * vL[i] + ig1 * iL[i];
        oR[i] = vg1 * vR[i] + ig1 * iR[i];
      }
    } else {
      // Per-sample ramp so k-rate steps do not zipper.
      const dv = (vg1 - vg0) / len;
      const di = (ig1 - ig0) / len;
      for (let i = 0; i < len; i++) {
        const v = vg0 + dv * (i + 1);
        const g = ig0 + di * (i + 1);
        oL[i] = v * vL[i] + g * iL[i];
        oR[i] = v * vR[i] + g * iR[i];
      }
      this.vg = vg1;
      this.ig = ig1;
    }
    return true;
  }

  // Render quanta are 128 frames today; a future renderSizeHint could change that once.
  private resize(len: number): void {
    this.vL = new Float32Array(len);
    this.vR = new Float32Array(len);
    this.iL = new Float32Array(len);
    this.iR = new Float32Array(len);
  }
}

registerProcessor(SEPARATOR_PROCESSOR, SeparatorProcessor);
