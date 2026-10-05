// AudioWorklet: vocal / instrumental separation with per-stem gain.
//   out = vocalGain · vocal + instrumentalGain · instrumental   (stereo)
// The separation (DSP or ML engine) lives in SeparatorCore; vocal + instrumental = input delayed
// by the engine's latency, so 100 % / 100 % is the original.
// process() allocates nothing; every buffer is created in the constructor.
import { QUANTUM, SeparatorCore } from './core';
import { PARAM_INSTRUMENTAL, PARAM_VOCAL, SEPARATOR_PROCESSOR, type FromWorklet, type ToWorklet } from './protocol';

// AudioWorkletGlobalScope is not in TypeScript's DOM lib.
declare const sampleRate: number;
declare const currentTime: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessor): void;

class SeparatorProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: PARAM_VOCAL, defaultValue: 1, minValue: 0, maxValue: 6, automationRate: 'k-rate' },
      { name: PARAM_INSTRUMENTAL, defaultValue: 1, minValue: 0, maxValue: 6, automationRate: 'k-rate' },
    ];
  }

  private readonly core = new SeparatorCore(sampleRate, (m: FromWorklet) => this.port.postMessage(m));
  private readonly zero = new Float32Array(QUANTUM);
  private readonly vL = new Float32Array(QUANTUM);
  private readonly vR = new Float32Array(QUANTUM);
  private readonly iL = new Float32Array(QUANTUM);
  private readonly iR = new Float32Array(QUANTUM);
  private active = false;
  // Gains applied at the end of the previous quantum; each quantum ramps linearly from these.
  private vg = 1;
  private ig = 1;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<ToWorklet>) => {
      const msg = e.data;
      if (msg.type === 'active') {
        if (msg.on && !this.active) this.core.setActive(true, msg.engine, msg.reason);
        else if (!msg.on) this.core.setActive(false);
        this.active = msg.on;
      } else if (msg.type === 'flush') {
        this.core.flush();
      } else if (msg.type === 'ml-port') {
        this.core.setPort(msg.port);
      } else if (msg.type === 'engine') {
        this.core.requestEngine(msg.engine, msg.reason);
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
    if (len !== QUANTUM) {
      // SeparatorCore is built for 128-frame quanta; another render size is not supported.
      oL.fill(0);
      oR.fill(0);
      return true;
    }
    const { vL, vR, iL, iR } = this;
    this.core.setSharpen(parameters[PARAM_INSTRUMENTAL][0]);
    this.core.process(inL, inR, vL, vR, iL, iR, currentTime);

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
}

registerProcessor(SEPARATOR_PROCESSOR, SeparatorProcessor);
