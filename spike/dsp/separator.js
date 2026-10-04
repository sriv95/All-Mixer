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
import { FFT } from './fft.js';

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

    // pFreq is only read where band > 0, so the sliding median only needs that bin range.
    this.kLo = 0; while (this.kLo < B && !(this.band[this.kLo] > 0)) this.kLo++;
    this.kHi = B - 1; while (this.kHi >= this.kLo && !(this.band[this.kHi] > 0)) this.kHi--;

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
    this.sortWin = new Float32Array(o.hpssFreqBins + 1);
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

  // Exact median of 9 values (Paeth/Smith selection network, 19 compare-exchanges). Same value as
  // sorting, no state, no allocation. Reads from hist at stride B.
  static median9(h, k, B) {
    let a0 = h[k], a1 = h[B + k], a2 = h[2 * B + k], a3 = h[3 * B + k], a4 = h[4 * B + k],
        a5 = h[5 * B + k], a6 = h[6 * B + k], a7 = h[7 * B + k], a8 = h[8 * B + k], t;
    if (a1 > a2) { t = a1; a1 = a2; a2 = t; } if (a4 > a5) { t = a4; a4 = a5; a5 = t; } if (a7 > a8) { t = a7; a7 = a8; a8 = t; }
    if (a0 > a1) { t = a0; a0 = a1; a1 = t; } if (a3 > a4) { t = a3; a3 = a4; a4 = t; } if (a6 > a7) { t = a6; a6 = a7; a7 = t; }
    if (a1 > a2) { t = a1; a1 = a2; a2 = t; } if (a4 > a5) { t = a4; a4 = a5; a5 = t; } if (a7 > a8) { t = a7; a7 = a8; a8 = t; }
    if (a0 > a3) { t = a0; a0 = a3; a3 = t; } if (a5 > a8) { t = a5; a5 = a8; a8 = t; } if (a4 > a7) { t = a4; a4 = a7; a7 = t; }
    if (a3 > a6) { t = a3; a3 = a6; a6 = t; } if (a1 > a4) { t = a1; a1 = a4; a4 = t; } if (a2 > a5) { t = a2; a2 = a5; a5 = t; }
    if (a4 > a7) { t = a4; a4 = a7; a7 = t; } if (a4 > a2) { t = a4; a4 = a2; a2 = t; } if (a6 > a4) { t = a6; a6 = a4; a4 = t; }
    if (a4 > a2) { t = a4; a4 = a2; a2 = t; }
    return a4;
  }

  // Sorted-array helpers for the sliding frequency median (no allocation).
  static insertSorted(a, n, v) {
    let j = n - 1;
    while (j >= 0 && a[j] > v) { a[j + 1] = a[j]; j--; }
    a[j + 1] = v;
    return n + 1;
  }
  // Swap one value for another in a single pass (window size unchanged).
  static replaceSorted(a, n, out, v) {
    let i = 0;
    while (i < n - 1 && a[i] !== out) i++;
    while (i > 0 && a[i - 1] > v) { a[i] = a[i - 1]; i--; }
    while (i < n - 1 && a[i + 1] < v) { a[i] = a[i + 1]; i++; }
    a[i] = v;
  }
  static removeSorted(a, n, v) {
    let lo = 0, hi = n - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < v) lo = m + 1; else hi = m; }
    for (let j = lo; j < n - 1; j++) a[j] = a[j + 1];
    return n - 1;
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
    const { N, H, B, re, im, win, fft, inL, inR } = this, o = this.opts;
    const start = this.fill; // oldest sample in the ring
    // Two linear segments instead of (start + n) % N.
    const seg = N - start;
    for (let n = 0; n < seg; n++) {
      const w = win[n], j = start + n;
      re[n] = inL[j] * w; im[n] = inR[j] * w;
    }
    for (let n = seg, j = 0; n < N; n++, j++) {
      const w = win[n];
      re[n] = inL[j] * w; im[n] = inR[j] * w;
    }
    fft.transform(re, im);
    const { Lr, Li, Rr, Ri, mag } = this;
    for (let k = 0; k < B; k++) {
      const nk = k === 0 ? 0 : N - k;
      Lr[k] = 0.5 * (re[k] + re[nk]); Li[k] = 0.5 * (im[k] - im[nk]);
      Rr[k] = 0.5 * (im[k] + im[nk]); Ri[k] = -0.5 * (re[k] - re[nk]);
      const mr = Lr[k] + Rr[k], mi = Li[k] + Ri[k];
      mag[k] = Math.sqrt(mr * mr + mi * mi) * 0.5; // mid magnitude
    }
    // Percussive (frequency median) and harmonic (time median over past frames).
    const T = o.hpssTimeFrames, F = o.hpssFreqBins, hf = F >> 1, sc = this.scratch;
    const usePerc = o.usePerc, useCenter = o.useCenter, cFloor = o.centerFloor;
    const cPow = o.centerPower, pPow = o.percPower;
    this.hist.set(mag, this.histPos * B);
    this.histPos = (this.histPos + 1) % T;
    const pFreq = this.pFreq, hist = this.hist;
    if (usePerc) {
      // Sliding sorted window over k: drop the outgoing bin, insert the incoming one.
      const sw = this.sortWin;
      const kLo = this.kLo, kHi = this.kHi;
      let c = 0;
      for (let j = Math.max(0, kLo - hf); j <= kLo + hf && j < B; j++) c = DspSeparator.insertSorted(sw, c, mag[j]);
      for (let k = kLo; k <= kHi; k++) {
        pFreq[k] = c & 1 ? sw[c >> 1] : 0.5 * (sw[(c >> 1) - 1] + sw[c >> 1]);
        const out = k - hf, inc = k + 1 + hf;
        if (out >= 0 && inc < B) DspSeparator.replaceSorted(sw, c, mag[out], mag[inc]);
        else {
          if (out >= 0) c = DspSeparator.removeSorted(sw, c, mag[out]);
          if (inc < B) c = DspSeparator.insertSorted(sw, c, mag[inc]);
        }
      }
    }
    const mask = this.mask, band = this.band, rel = o.maskRelease;
    for (let k = 0; k < B; k++) {
      let m = band[k];
      if (m > 0 && useCenter) {
        const pl = Lr[k] * Lr[k] + Li[k] * Li[k], pr = Rr[k] * Rr[k] + Ri[k] * Ri[k];
        const cross = Lr[k] * Rr[k] + Li[k] * Ri[k];
        const coh = (2 * cross) / (pl + pr + 1e-12);
        const c = Math.max(0, (coh - cFloor) / (1 - cFloor));
        m *= cPow === 1 ? c : c ** cPow;
      }
      if (m > 0 && usePerc) {
        let h;
        if (T === 9) h = DspSeparator.median9(hist, k, B);
        else { for (let t = 0; t < T; t++) sc[t] = hist[t * B + k]; h = DspSeparator.median(sc, T); }
        const p = pFreq[k];
        const perc = (p * p) / (h * h + p * p + 1e-12);
        m *= pPow === 0.5 ? Math.sqrt(1 - perc) : (1 - perc) ** pPow;
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
    for (let n = 0; n < N; n++) { const w = win[n]; acc[n] += re[n] * w * g; accR[n] += im[n] * w * g; }
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
