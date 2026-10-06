class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(4096 * 2); this.n = 0; this.f0 = 0; this.rec = false; this.port.onmessage = (e) => { this.rec = !!e.data.rec; this.n = 0; }; }
  process(inputs) {
    const i = inputs[0]; if (!i || !i.length || !this.rec) return true;
    const L = i[0], R = i.length > 1 ? i[1] : L;
    if (this.n === 0) this.f0 = currentFrame;
    for (let k = 0; k < 128; k++) { this.buf[this.n * 2 + 0] = L[k]; this.buf[this.n * 2 + 1] = R[k]; this.n++; }
    if (this.n >= 4096) { const o = this.buf.slice(0, this.n * 2); this.port.postMessage({ f0: this.f0, d: o }, [o.buffer]); this.n = 0; }
    return true;
  }
}
registerProcessor('qa-tap', Tap);
