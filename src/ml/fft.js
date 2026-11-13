// In-place complex FFT: radix-2 for powers of two, Bluestein (chirp-z over a radix-2 FFT) for other sizes
// (Kim Vocal 2 n_fft 7680). All tables are built once; transform() allocates nothing,
// so it is safe to call from an AudioWorklet render callback.
export class FFT {
  constructor(n, pow2 = true) {
    if (pow2 && n & (n - 1)) return new Bluestein(n);
    this.n = n;
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
  }

  // inverse=true computes the unscaled inverse transform (caller divides by n).
  transform(re, im, inverse = false) {
    const n = this.n, rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const sign = inverse ? 1 : -1, cos = this.cos, sin = this.sin;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      // Butterfly loop order swapped (k outer): twiddle loaded once per k, not once per group.
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step], wi = sign * sin[k * step];
        for (let start = 0; start < n; start += size) {
          const a = start + k, b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }
}

class Bluestein {
  constructor(n) {
    let M = 1;
    while (M < 2 * n - 1) M <<= 1;
    this.n = n; this.M = M; this.f = new FFT(M, true);
    this.wr = new Float64Array(n); this.wi = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = (Math.PI * ((i * i) % (2 * n))) / n;
      this.wr[i] = Math.cos(a); this.wi[i] = -Math.sin(a);
    }
    this.ar = new Float64Array(M); this.ai = new Float64Array(M);
    this.br = new Float64Array(M); this.bi = new Float64Array(M);
    this.br[0] = this.wr[0]; this.bi[0] = -this.wi[0];
    for (let i = 1; i < n; i++) { this.br[i] = this.br[M - i] = this.wr[i]; this.bi[i] = this.bi[M - i] = -this.wi[i]; }
    this.f.transform(this.br, this.bi);
  }

  transform(re, im, inverse = false) {
    const { n, M, wr, wi, ar, ai, br, bi } = this;
    if (inverse) for (let i = 0; i < n; i++) im[i] = -im[i];
    ar.fill(0); ai.fill(0);
    for (let i = 0; i < n; i++) { ar[i] = re[i] * wr[i] - im[i] * wi[i]; ai[i] = re[i] * wi[i] + im[i] * wr[i]; }
    this.f.transform(ar, ai);
    for (let i = 0; i < M; i++) { const x = ar[i] * br[i] - ai[i] * bi[i]; ai[i] = ar[i] * bi[i] + ai[i] * br[i]; ar[i] = x; }
    this.f.transform(ar, ai, true);
    for (let i = 0; i < n; i++) { re[i] = (ar[i] * wr[i] - ai[i] * wi[i]) / M; im[i] = (ar[i] * wi[i] + ai[i] * wr[i]) / M; }
    if (inverse) for (let i = 0; i < n; i++) im[i] = -im[i];
  }
}
