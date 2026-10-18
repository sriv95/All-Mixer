// AudioWorklet: vocal / instrumental separation with per-stem gain.
//   out = (1 − b)·(vocalGain · vocal + instrumentalGain · (drumsGain · drums + othersGain · (instrumental − drums))) + b·(vocal + instrumental)
// with b the core's bypass weight (1 = original mix). Without the drum stage `drums` is 0 and othersGain scales the instrumental.
// The separation (ML engine, or the bypass path that plays the original mix) lives in SeparatorCore; vocal + instrumental = input delayed
// by the engine's latency, so 100 % / 100 % is the original.
// process() allocates nothing; every buffer is created in the constructor.
import { QUANTUM, SeparatorCore } from './core';
import { PARAM_DRUMS, PARAM_INSTRUMENTAL, PARAM_OTHERS, PARAM_VOCAL, SEPARATOR_PROCESSOR, type FromWorklet, type ToWorklet } from './protocol';

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
      { name: PARAM_DRUMS, defaultValue: 1, minValue: 0, maxValue: 6, automationRate: 'k-rate' },
      { name: PARAM_OTHERS, defaultValue: 1, minValue: 0, maxValue: 6, automationRate: 'k-rate' },
    ];
  }

  private readonly core = new SeparatorCore(sampleRate, (m: FromWorklet) => this.port.postMessage(m));
  private readonly zero = new Float32Array(QUANTUM);
  private readonly vL = new Float32Array(QUANTUM);
  private readonly vR = new Float32Array(QUANTUM);
  private readonly iL = new Float32Array(QUANTUM);
  private readonly iR = new Float32Array(QUANTUM);
  private readonly dL = new Float32Array(QUANTUM);
  private readonly dR = new Float32Array(QUANTUM);
  private readonly bw = new Float32Array(QUANTUM);
  private active = false;
  // Gains applied at the end of the previous quantum; each quantum ramps linearly from these.
  private vg = 1;
  private ig = 1;
  private dg = 1;
  private og = 1;

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
      } else if (msg.type === 'expect-audio') {
        this.core.expectAudio();
      } else if (msg.type === 'hold') {
        this.core.setHeld(true);
      } else if (msg.type === 'release') {
        this.core.setHeld(false);
      } else if (msg.type === 'ml-port') {
        this.core.setPort(msg.port);
      } else if (msg.type === 'engine') {
        this.core.requestEngine(msg.engine, msg.reason);
      } else if (msg.type === 'model') {
        this.core.setModel(msg.model);
      } else if (msg.type === 'geometry') {
        this.core.setGeometry(msg.geometry);
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
    const { vL, vR, iL, iR, dL, dR, bw } = this;
    this.core.process(inL, inR, vL, vR, iL, iR, bw, currentTime, dL, dR);

    // Per-sample ramp from last quantum's gains so k-rate steps do not zipper. The drums are a part of the
    // instrumental: the instrumental gain scales both, the drums / others gains split it.
    const vg1 = parameters[PARAM_VOCAL][0];
    const ig1 = parameters[PARAM_INSTRUMENTAL][0];
    const dg1 = parameters[PARAM_DRUMS][0];
    const og1 = parameters[PARAM_OTHERS][0];
    const { vg: vg0, ig: ig0, dg: dg0, og: og0 } = this;
    for (let i = 0; i < len; i++) {
      const k = (i + 1) / len;
      const v = vg0 + (vg1 - vg0) * k;
      const g = ig0 + (ig1 - ig0) * k;
      const d = dg0 + (dg1 - dg0) * k;
      const o = og0 + (og1 - og0) * k;
      const b = bw[i];
      oL[i] = (1 - b) * (v * vL[i] + g * (d * dL[i] + o * (iL[i] - dL[i]))) + b * (vL[i] + iL[i]);
      oR[i] = (1 - b) * (v * vR[i] + g * (d * dR[i] + o * (iR[i] - dR[i]))) + b * (vR[i] + iR[i]);
    }
    this.vg = vg1;
    this.ig = ig1;
    this.dg = dg1;
    this.og = og1;
    return true;
  }
}

registerProcessor(SEPARATOR_PROCESSOR, SeparatorProcessor);
