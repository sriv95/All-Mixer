// AudioWorkletProcessor wrapping DspSeparator.
// Output = vocalGain * vocal + instGain * instrumental (stereo).
// process() allocates nothing. Timing: AudioWorkletGlobalScope has no performance.now(), so the
// main thread passes a SharedArrayBuffer clock (a Worker keeps clock[0] = performance.now() in ms).
// Per-quantum durations go into a preallocated 1 µs histogram; every 1000 quanta one stats message
// is posted (that postMessage allocates once per ~23 ms of audio, outside the timed region).
import { DspSeparator } from '../dsp/separator.js';

const WINDOW = 1000;
const HIST_BINS = 16384; // 1 µs bins; last bin is overflow

class SeparatorProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'vocalGain', defaultValue: 1, minValue: 0, maxValue: 6, automationRate: 'k-rate' },
      { name: 'instGain', defaultValue: 1, minValue: 0, maxValue: 6, automationRate: 'k-rate' },
    ];
  }

  constructor(options) {
    super();
    const po = options.processorOptions || {};
    this.sep = new DspSeparator(sampleRate);
    this.clock = po.clockBuffer ? new Float64Array(po.clockBuffer) : null;
    this.bypass = !!po.bypass; // true = measure the empty worklet (timer overhead + copy)
    this.zero = new Float32Array(128);
    this.vL = new Float32Array(128); this.vR = new Float32Array(128);
    this.iL = new Float32Array(128); this.iR = new Float32Array(128);
    this.hist = new Uint32Array(HIST_BINS);
    this.n = 0; this.sum = 0; this.max = 0; this.total = 0;
    this.budgetUs = 128 / sampleRate * 1e6; this.lag = 0; this.maxLag = 0; this.over = 0;
  }

  process(inputs, outputs, parameters) {
    const clock = this.clock;
    const t0 = clock ? clock[0] : 0;
    const out = outputs[0];
    const inp = inputs[0];
    const inL = inp.length > 0 ? inp[0] : this.zero;
    const inR = inp.length > 1 ? inp[1] : inL;
    const vg = parameters.vocalGain[0], ig = parameters.instGain[0];
    const oL = out[0], oR = out.length > 1 ? out[1] : out[0];
    const len = oL.length;
    if (this.bypass) {
      for (let i = 0; i < len; i++) { oL[i] = inL[i]; oR[i] = inR[i]; }
    } else {
      const { vL, vR, iL, iR } = this;
      this.sep.process(inL, inR, vL, vR, iL, iR);
      for (let i = 0; i < len; i++) {
        oL[i] = vg * vL[i] + ig * iL[i];
        oR[i] = vg * vR[i] + ig * iR[i];
      }
    }
    if (clock) {
      const us = (clock[0] - t0) * 1000;
      const b = us < 0 ? 0 : us >= HIST_BINS - 1 ? HIST_BINS - 1 : us | 0;
      this.hist[b]++;
      // Deadline model: lag grows by (cost - budget) and drains when quanta are cheap.
      this.lag += us - this.budgetUs; if (this.lag < 0) this.lag = 0; if (this.lag > this.maxLag) this.maxLag = this.lag;
      if (us > this.budgetUs) this.over++;
      this.sum += us; if (us > this.max) this.max = us;
      if (++this.n === WINDOW) this.flush();
    }
    return true;
  }

  sparse() { // [bin, count, bin, count, ...] of non-empty bins
    const h = this.hist, o = [];
    for (let b = 0; b < h.length; b++) if (h[b]) o.push(b, h[b]);
    return o;
  }

  flush() {
    const h = this.hist, N = this.n;
    let acc = 0, p50 = -1, p99 = -1;
    for (let b = 0; b < h.length; b++) {
      acc += h[b];
      if (p50 < 0 && acc >= 0.5 * N) p50 = b;
      if (p99 < 0 && acc >= 0.99 * N) { p99 = b; break; }
    }
    this.port.postMessage({ type: 'stats', quanta: this.total += N, n: N, mean: this.sum / N, max: this.max, maxLag: this.maxLag, over: this.over, p50, p99, hist: this.sparse() });
    h.fill(0); this.maxLag = 0; this.over = 0; this.n = 0; this.sum = 0; this.max = 0;
  }
}
registerProcessor('separator', SeparatorProcessor);
