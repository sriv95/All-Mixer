// Improved DSP vocal / instrumental separator (F3 fallback, F5-safe).
//
// Per STFT bin we estimate a soft vocal mask:
//   mask = center(k) * band(f) * (1 - percussive(k))
//   center     : phase-coherent L/R similarity, 1 for a centre-panned source
//   band       : 0 below lowCutHz (bass and kick fundamentals are never touched),
//                ramps to 1 by lowFullHz, rolls off above highFullHz
//   percussive : causal HPSS score (spectral flatness across frequency vs. median over
//                past frames). Transients (kick click, snare, hats) stay in the instrumental.
// vocal = mask * X, instrumental = delayed input - vocal, so vocal + instrumental equals
// the original exactly (apart from the fixed STFT delay).
//
// Real-time safety: every buffer is allocated in the constructor. process() allocates
// nothing and does a fixed amount of work per hop, so it can run inside an AudioWorklet.
import { FFT } from '../../dsp/fft.js';

export const DEFAULTS = {
  fftSize: 2048,
  hop: 512,
  lowCutHz: 120,
  lowFullHz: 220,
  highFullHz: 8000,
  highCutHz: 14000,
  centerFloor: 0.3,     // coherence below this counts as "not centre" (tuned on MUSDB, see spike-report)
  centerPower: 1,
  hpssTimeFrames: 9,    // past frames for the harmonic (time) median
  hpssFreqBins: 17,     // bins for the percussive (frequency) median
  percPower: 0.5,
  maskRelease: 0.6,     // one-pole smoothing for falling mask values (0 = none)
  useCenter: true,
  useBand: true,
  usePerc: true,
};

export class DspSeparator {
  constructor(sampleRate, opts = {}) {
    const o = (this.opts = { ...DEFAULTS, ...opts });
    const N = o.fftSize, H = o.hop, B = N / 2 + 1;
    this.N = N; this.H = H; this.B = B; this.sr = sampleRate;
    this.fft = new FFT(N);
    // Hann analysis + synthesis; overlap-add gain for 75 % overlap is 1.5.
    this.win = new Float32Array(N);
    for (let i = 0; i < N; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
    let wsum = 0;
    for (let j = 0; j < N; j += H) wsum += this.win[j] ** 2;
    this.olaGain = 1 / wsum;

    this.band = new Float32Array(B);
    for (let k = 0; k < B; k++) {
      const f = (k * sampleRate) / N;
      let w;
      if (f <= o.lowCutHz) w = 0;
      else if (f < o.lowFullHz) w = (f - o.lowCutHz) / (o.lowFullHz - o.lowCutHz);
      else if (f <= o.highFullHz) w = 1;
      else if (f < o.highCutHz) w = 1 - (f - o.highFullHz) / (o.highCutHz - o.highFullHz);
      else w = 0;
      this.band[k] = o.useBand ? w : 1;
    }

    // Input ring (last N samples), output accumulators (vocal only; instrumental is derived).
    this.inL = new Float32Array(N); this.inR = new Float32Array(N);
    this.accL = new Float32Array(N); this.accR = new Float32Array(N);
    this.dlyL = new Float32Array(N); this.dlyR = new Float32Array(N); // dry delay line
    this.fill = 0; this.outPos = 0;
    this.re = new Float64Array(N); this.im = new Float64Array(N);
    this.Lr = new Float32Array(B); this.Li = new Float32Array(B);
    this.Rr = new Float32Array(B); this.Ri = new Float32Array(B);
    this.mag = new Float32Array(B);
    this.mask = new Float32Array(B);
    this.hist = new Float32Array(o.hpssTimeFrames * B); this.histPos = 0;
    this.scratch = new Float32Array(Math.max(o.hpssTimeFrames, o.hpssFreqBins));
    this.pFreq = new Float32Array(B);
    this.ready = new Float32Array(2 * H); // vocal L/R produced by the last hop
    this.readyPos = H;
  }

  // Latency in samples between input and output (both vocal and instrumental).
  get latency() { return this.N; }

  static median(buf, n) {
    for (let i = 1; i < n; i++) {
      const v = buf[i]; let j = i - 1;
      while (j >= 0 && buf[j] > v) { buf[j + 1] = buf[j]; j--; }
      buf[j + 1] = v;
    }
    return n & 1 ? buf[n >> 1] : 0.5 * (buf[(n >> 1) - 1] + buf[n >> 1]);
  }

  // Processes one block. Arrays may be any length; outputs must be the same length.
  process(inL, inR, vocL, vocR, insL, insR) {
    const N = this.N, H = this.H;
    for (let i = 0; i < inL.length; i++) {
      // Shift-free ring: write at fill, analyse when a hop is complete.
      this.inL[this.fill] = inL[i]; this.inR[this.fill] = inR[i];
      // Dry delay line of N samples aligned with the STFT output.
      const dL = this.dlyL[this.fill], dR = this.dlyR[this.fill];
      this.dlyL[this.fill] = inL[i]; this.dlyR[this.fill] = inR[i];
      const vL = this.ready[this.readyPos - H] ?? 0;
      const vR = this.ready[this.readyPos] ?? 0;
      vocL[i] = vL; vocR[i] = vR;
      insL[i] = dL - vL; insR[i] = dR - vR;
      this.readyPos++;
      this.fill = (this.fill + 1) % N;
      this.outPos++;
      if (this.outPos === H) { this.outPos = 0; this.hopFrame(); }
    }
  }

  hopFrame() {
    const { N, H, B, re, im, win, fft } = this, o = this.opts;
    const start = this.fill; // oldest sample in the ring
    for (let n = 0; n < N; n++) {
      const j = (start + n) % N;
      re[n] = this.inL[j] * win[n];
      im[n] = this.inR[j] * win[n];
    }
    fft.transform(re, im);
    const { Lr, Li, Rr, Ri, mag } = this;
    for (let k = 0; k < B; k++) {
      const nk = (N - k) % N;
      Lr[k] = 0.5 * (re[k] + re[nk]); Li[k] = 0.5 * (im[k] - im[nk]);
      Rr[k] = 0.5 * (im[k] + im[nk]); Ri[k] = -0.5 * (re[k] - re[nk]);
      mag[k] = Math.hypot(Lr[k] + Rr[k], Li[k] + Ri[k]) * 0.5; // mid magnitude
    }
    // Percussive (frequency median) and harmonic (time median over past frames).
    const T = o.hpssTimeFrames, F = o.hpssFreqBins, hf = F >> 1, sc = this.scratch;
    this.hist.set(mag, this.histPos * B);
    this.histPos = (this.histPos + 1) % T;
    for (let k = 0; k < B; k++) {
      let c = 0;
      for (let j = k - hf; j <= k + hf; j++) if (j >= 0 && j < B) sc[c++] = mag[j];
      this.pFreq[k] = DspSeparator.median(sc, c);
    }
    const mask = this.mask, band = this.band, rel = o.maskRelease;
    for (let k = 0; k < B; k++) {
      let m = band[k];
      if (m > 0 && o.useCenter) {
        const pl = Lr[k] * Lr[k] + Li[k] * Li[k], pr = Rr[k] * Rr[k] + Ri[k] * Ri[k];
        const cross = Lr[k] * Rr[k] + Li[k] * Ri[k];
        const coh = (2 * cross) / (pl + pr + 1e-12);
        const c = Math.max(0, (coh - o.centerFloor) / (1 - o.centerFloor));
        m *= c ** o.centerPower;
      }
      if (m > 0 && o.usePerc) {
        for (let t = 0; t < T; t++) sc[t] = this.hist[t * B + k];
        const h = DspSeparator.median(sc, T), p = this.pFreq[k];
        const perc = (p * p) / (h * h + p * p + 1e-12);
        m *= (1 - perc) ** o.percPower;
      }
      // Fast attack, slower release to reduce musical noise.
      mask[k] = m >= mask[k] ? m : rel * mask[k] + (1 - rel) * m;
    }
    // Vocal spectrum, packed as VL + i*VR for one inverse FFT.
    for (let k = 0; k < B; k++) {
      const m = mask[k];
      const vlr = m * Lr[k], vli = m * Li[k], vrr = m * Rr[k], vri = m * Ri[k];
      re[k] = vlr - vri; im[k] = vli + vrr;
      if (k > 0 && k < N / 2) { re[N - k] = vlr + vri; im[N - k] = -vli + vrr; }
    }
    fft.transform(re, im, true);
    const g = this.olaGain / N, acc = this.accL, accR = this.accR;
    // Overlap-add into a linear accumulator, emit the first H samples.
    for (let n = 0; n < N; n++) { acc[n] += re[n] * win[n] * g; accR[n] += im[n] * win[n] * g; }
    for (let n = 0; n < H; n++) { this.ready[n] = acc[n]; this.ready[H + n] = accR[n]; }
    acc.copyWithin(0, H); acc.fill(0, N - H);
    accR.copyWithin(0, H); accR.fill(0, N - H);
    this.readyPos = H;
  }
}

// Phase-cancellation baseline ("centre channel removal") for comparison only.
export function phaseCancel(inL, inR, vocL, vocR, insL, insR) {
  for (let i = 0; i < inL.length; i++) {
    const side = 0.5 * (inL[i] - inR[i]), mid = 0.5 * (inL[i] + inR[i]);
    insL[i] = side; insR[i] = -side; vocL[i] = mid; vocR[i] = mid;
  }
}
