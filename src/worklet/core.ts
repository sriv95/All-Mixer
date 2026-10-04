// Separator core: DSP engine plus the ML block path, without worklet globals so it can be
// unit tested. The processor (separator-processor.ts) wraps it and applies the stem gains.
//
// Both engines read from the same rings, indexed by absolute input sample:
//   dry  input,  dsp  DSP vocal (written DSP_LATENCY_SAMPLES late, as produced),
//   ml   vocal blocks back from the ML worker.
// Output at input position p reads index p − delay; instrumental = dry − vocal, so
// vocal + instrumental is always the delayed input.
//
// DSP engine: delay = DSP_LATENCY_SAMPLES, vocal from `dsp`.
// ML engine:  delay = ML_LATENCY_SAMPLES. Input goes to the worker in ML_BLOCK blocks. Each
//   vocal block is chosen one quantum before it starts: ML if it is back, else the DSP vocal
//   (the rings hold it at the same delay, so there is no delay jump). Source switches
//   crossfade over one quantum. 3 misses within 10 s → DSP engine for good ('deadline-miss').
//
// Engine switches change the delay. DSP → ML plays the DSP output up to input P, is silent
// for the extra delay, then plays ML from input P, so nothing repeats; ML → DSP skips ahead.
// `onEngine` reports the context time of the first input sample heard with the new delay;
// the video overlay steps there too.
//
// process() allocates nothing (engine-switch messages aside, which are rare). onBlock (port
// message handler) creates two typed-array views per returned block; that runs between quanta,
// not inside process(), and the transferred ArrayBuffer is a new object anyway.
// ML is refused unless the context runs at ML_SAMPLE_RATE.
import { DspSeparator } from './dsp/separator.js';
import {
  DSP_LATENCY_SAMPLES,
  ML_BLOCK,
  ML_BUFFER_BYTES,
  ML_HEADER_BYTES,
  ML_LATENCY_SAMPLES,
  ML_RESULT_OFFSET,
  ML_SAMPLE_RATE,
  type FromWorklet,
  type MlEngine,
  type MlReason,
} from './protocol';

export const QUANTUM = 128;
const RING = 16384; // > ML_LATENCY_SAMPLES + QUANTUM, power of two
const MASK = RING - 1;
const SLOTS = RING / ML_BLOCK;
const POOL = 8;
const MISS_WINDOW_S = 10;
/** ML vocal block m covers input [streamStart + ML_BASE + ML_BLOCK·m, … + ML_BLOCK). */
const ML_BASE = ML_BLOCK - ML_RESULT_OFFSET;

interface PoolEntry {
  buf: ArrayBuffer;
  head: Float64Array;
  data: Float32Array;
}

type Phase =
  | 'steady'
  /** DSP output until input `switchPos`, silence, then ML from input `switchPos`. */
  | 'to-ml'
  /** This quantum fades the ML output out; the DSP output fades in on the next. */
  | 'to-dsp';

export class SeparatorCore {
  private readonly sep: DspSeparator;
  private readonly dryL = new Float32Array(RING);
  private readonly dryR = new Float32Array(RING);
  private readonly dspL = new Float32Array(RING);
  private readonly dspR = new Float32Array(RING);
  private readonly mlL = new Float32Array(RING);
  private readonly mlR = new Float32Array(RING);
  /** Absolute start of the ML block held in each slot (NaN = empty). */
  private readonly slotStart = new Float64Array(SLOTS).fill(NaN);
  private readonly svL = new Float32Array(QUANTUM);
  private readonly svR = new Float32Array(QUANTUM);
  private readonly siL = new Float32Array(QUANTUM);
  private readonly siR = new Float32Array(QUANTUM);

  /** Absolute input index of the current (or next) quantum's first sample. */
  private pos = 0;
  /** Context time of `pos`. */
  private time = 0;
  private active = false;
  /** Engine whose output (and delay) we hear. */
  engine: MlEngine = 'dsp';
  reason: MlReason = 'auto';
  private delay = DSP_LATENCY_SAMPLES;
  private phase: Phase = 'steady';
  private switchPos = 0;
  /** Output envelope at the end of the last quantum (0 = silent). */
  private env = 1;
  private wantMl: MlReason | null = null;
  private wantDsp: MlReason | null = null;

  // ML stream
  private port: MessagePort | null = null;
  private streaming = false;
  private streamStart = 0;
  private epoch = 0;
  private readonly pool: PoolEntry[] = [];
  private cur: PoolEntry | null = null;
  private readonly xfer: Transferable[] = [];
  /** Vocal source of the block being read (true = ML) and of the next one. */
  private useMl = false;
  private nextMl = false;
  /** Positions of the last two misses. */
  private readonly misses = new Float64Array(2).fill(-Infinity);
  /** ML weight at the start / end of the current quantum. */
  private w0 = 0;
  private w1 = 0;
  /** Counters for tests and diagnostics. */
  readonly stats = { posted: 0, returned: 0, misses: 0 };

  constructor(
    private readonly sampleRate: number,
    private readonly onEngine: (msg: FromWorklet) => void,
  ) {
    this.sep = new DspSeparator(sampleRate);
    if (this.sep.latency !== DSP_LATENCY_SAMPLES) throw new Error('separator latency changed; update DSP_LATENCY_SAMPLES');
    for (let i = 0; i < POOL; i++) this.pool.push(entry(new ArrayBuffer(ML_BUFFER_BYTES)));
  }

  get latencySamples(): number {
    return this.engine === 'ml' ? ML_LATENCY_SAMPLES : DSP_LATENCY_SAMPLES;
  }

  setPort(port: MessagePort): void {
    this.port?.close();
    this.port = port;
    port.onmessage = (e: MessageEvent) => {
      if (e.data instanceof ArrayBuffer) this.onBlock(e.data);
    };
  }

  setActive(on: boolean, engine: MlEngine = 'dsp', reason: MlReason = 'auto'): void {
    this.active = on;
    this.reset();
    this.phase = 'steady';
    this.wantMl = this.wantDsp = null;
    this.engine = on && engine === 'ml' && this.mlAllowed() ? 'ml' : 'dsp';
    this.reason = reason;
    this.delay = this.latencySamples;
    if (this.engine === 'ml') this.startStream();
    else this.stopStream();
  }

  /** Drop everything buffered (seek). The ML stream restarts from here. */
  flush(): void {
    this.reset();
    if (this.phase === 'to-ml') {
      // Nothing buffered is left to protect: finish the switch now.
      this.phase = 'steady';
      this.engine = 'ml';
      this.delay = ML_LATENCY_SAMPLES;
    }
    if (this.streaming) this.startStream();
  }

  /** Ask for an engine switch; it starts at the next quantum. */
  requestEngine(engine: MlEngine, reason: MlReason): void {
    if (engine === 'ml') {
      this.wantDsp = null;
      this.wantMl = reason;
    } else {
      this.wantMl = null;
      this.wantDsp = reason;
    }
  }

  /**
   * One render quantum (QUANTUM frames); `time` is the context time of its first frame.
   * Writes the delayed vocal and instrumental stems.
   */
  process(
    inL: Float32Array,
    inR: Float32Array,
    vocL: Float32Array,
    vocR: Float32Array,
    insL: Float32Array,
    insR: Float32Array,
    time: number,
  ): void {
    if (!this.active) {
      vocL.fill(0);
      vocR.fill(0);
      insL.fill(0);
      insR.fill(0);
      return;
    }
    const pos = this.pos;
    this.time = time;
    if (this.wantMl !== null) this.toMl(this.wantMl);
    if (this.wantDsp !== null) this.toDsp(this.wantDsp);

    // 1. Rings: dry input and the DSP vocal (DSP_LATENCY_SAMPLES behind).
    const { svL, svR } = this;
    this.sep.process(inL, inR, svL, svR, this.siL, this.siR);
    const dspAt = pos - DSP_LATENCY_SAMPLES;
    for (let i = 0; i < QUANTUM; i++) {
      const j = (pos + i) & MASK;
      this.dryL[j] = inL[i];
      this.dryR[j] = inR[i];
      const k = (dspAt + i) & MASK;
      this.dspL[k] = svL[i];
      this.dspR[k] = svR[i];
    }

    // 2. ML stream: fill the current block, send it when full.
    if (this.streaming) this.feed(inL, inR);

    // 3. Envelope target and vocal source for this quantum.
    let target = 1;
    if (this.phase === 'to-ml') {
      // DSP output fades out on input P − QUANTUM … P − 1, then silence until ML reaches P.
      if (pos >= this.switchPos + DSP_LATENCY_SAMPLES - QUANTUM) target = 0;
    } else if (this.phase === 'to-dsp') {
      target = 0;
    }
    this.w0 = this.w1 = 0;
    if (this.engine === 'ml') this.chooseSource(pos - ML_LATENCY_SAMPLES);

    // 4. Output.
    const r0 = pos - this.delay;
    const env0 = this.env;
    const dE = (target - env0) / QUANTUM;
    const w0 = this.w0;
    const dW = (this.w1 - w0) / QUANTUM;
    const mix = w0 > 0 || this.w1 > 0;
    const { dryL, dryR, dspL, dspR, mlL, mlR } = this;
    for (let i = 0; i < QUANTUM; i++) {
      const j = (r0 + i) & MASK;
      const e = env0 + dE * (i + 1);
      let vl = dspL[j];
      let vr = dspR[j];
      if (mix) {
        const w = w0 + dW * (i + 1);
        vl += w * (mlL[j] - vl);
        vr += w * (mlR[j] - vr);
      }
      vocL[i] = e * vl;
      vocR[i] = e * vr;
      insL[i] = e * (dryL[j] - vl);
      insR[i] = e * (dryR[j] - vr);
    }
    this.env = target;

    // 5. Engine changes take effect from the next quantum.
    if (this.phase === 'to-ml' && pos + QUANTUM === this.switchPos + ML_LATENCY_SAMPLES) {
      this.phase = 'steady';
      this.engine = 'ml';
      this.delay = ML_LATENCY_SAMPLES;
      this.decideInitial(this.switchPos);
    } else if (this.phase === 'to-dsp') {
      this.phase = 'steady';
      this.engine = 'dsp';
      this.delay = DSP_LATENCY_SAMPLES;
      this.stopStream();
    }
    this.pos = pos + QUANTUM;
  }

  /** ML needs a port and a 44.1 kHz context (the model has no resampler). */
  private mlAllowed(): boolean {
    return this.port !== null && this.sampleRate === ML_SAMPLE_RATE;
  }

  private timeOf(p: number): number {
    return this.time + (p - this.pos) / this.sampleRate;
  }

  private toMl(reason: MlReason): void {
    this.wantMl = null;
    if (!this.mlAllowed() || this.engine !== 'dsp' || this.phase !== 'steady') return;
    this.phase = 'to-ml';
    this.switchPos = this.pos;
    this.reason = reason;
    this.startStream();
    this.onEngine({ type: 'engine', engine: 'ml', reason, at: this.timeOf(this.pos) });
  }

  private toDsp(reason: MlReason): void {
    this.wantDsp = null;
    const pos = this.pos;
    if (this.phase === 'to-ml') {
      // ML output has not started: go back to the DSP output from here (fades in if silent).
      this.phase = 'steady';
      this.reason = reason;
      this.stopStream();
      this.onEngine({ type: 'engine', engine: 'dsp', reason, at: this.timeOf(pos - DSP_LATENCY_SAMPLES) });
      return;
    }
    if (this.engine !== 'ml' || this.phase !== 'steady') return;
    this.phase = 'to-dsp';
    this.reason = reason;
    this.onEngine({ type: 'engine', engine: 'dsp', reason, at: this.timeOf(pos + QUANTUM - DSP_LATENCY_SAMPLES) });
  }

  /** Sets w0 / w1 for the quantum that reads input r0 … r0 + QUANTUM − 1. */
  private chooseSource(r0: number): void {
    const rel = r0 - (this.streamStart + ML_BASE);
    if (rel < -QUANTUM) return; // before the stream: rings are silent there
    const off = rel - Math.floor(rel / ML_BLOCK) * ML_BLOCK;
    if (off === 0) {
      const was = this.useMl;
      this.useMl = this.nextMl;
      if (this.useMl && !was) {
        this.w1 = 1; // DSP → ML over the block's first quantum
        return;
      }
    }
    if (off === ML_BLOCK - QUANTUM) {
      // Choose the next block now, so ML → DSP can fade over this quantum.
      this.nextMl = this.ready(Math.floor(rel / ML_BLOCK) + 1);
      if (!this.nextMl) this.miss();
      if (this.useMl && !this.nextMl) {
        this.w0 = 1;
        return;
      }
    }
    if (this.useMl) this.w0 = this.w1 = 1;
  }

  /** Entering the ML output at input p (mid-block): ML for this block only if it is here. */
  private decideInitial(p: number): void {
    const m = Math.floor((p - (this.streamStart + ML_BASE)) / ML_BLOCK);
    this.useMl = this.nextMl = this.ready(m);
    if (!this.useMl) this.miss();
  }

  private ready(m: number): boolean {
    return this.slotStart[m & (SLOTS - 1)] === this.streamStart + ML_BASE + ML_BLOCK * m;
  }

  private miss(): void {
    if (this.phase !== 'steady') return;
    this.stats.misses++;
    const pos = this.pos;
    if (pos - this.misses[0] <= MISS_WINDOW_S * this.sampleRate) {
      this.misses.fill(-Infinity);
      this.wantDsp = 'deadline-miss'; // third miss within the window
      return;
    }
    this.misses[0] = this.misses[1];
    this.misses[1] = pos;
  }

  private feed(inL: Float32Array, inR: Float32Array): void {
    const fill = (this.pos - this.streamStart) % ML_BLOCK;
    if (fill === 0) {
      this.cur = this.pool.pop() ?? null;
      // Every buffer is with the worker: it is blocks behind, far past any deadline.
      if (!this.cur) this.wantDsp = 'deadline-miss';
    }
    const cur = this.cur;
    if (!cur) return;
    cur.data.set(inL, fill);
    cur.data.set(inR, ML_BLOCK + fill);
    if (fill + QUANTUM === ML_BLOCK) {
      cur.head[0] = this.epoch;
      cur.head[1] = this.pos + QUANTUM - ML_BLOCK;
      this.xfer[0] = cur.buf;
      this.port!.postMessage(cur.buf, this.xfer);
      this.cur = null;
      this.stats.posted++;
    }
  }

  /** A buffer back from the worker (port message handler, between render quanta). */
  private onBlock(buf: ArrayBuffer): void {
    // A buggy worker must not grow the pool.
    if (buf.byteLength !== ML_BUFFER_BYTES || this.pool.length >= POOL) return;
    const e = entry(buf);
    const start = e.head[1];
    const rel = start - (this.streamStart + ML_BASE);
    if (this.streaming && e.head[0] === this.epoch && rel >= 0 && rel % ML_BLOCK === 0) {
      for (let i = 0; i < ML_BLOCK; i++) {
        const j = (start + i) & MASK;
        // The head of the first block lies before the stream (nothing was sent for it): keep it silent.
        const live = start + i >= this.streamStart;
        this.mlL[j] = live ? e.data[i] : 0;
        this.mlR[j] = live ? e.data[ML_BLOCK + i] : 0;
      }
      this.slotStart[(rel / ML_BLOCK) & (SLOTS - 1)] = start;
      this.stats.returned++;
    }
    this.pool.push(e);
  }

  private startStream(): void {
    this.dropCurrent();
    this.streaming = true;
    this.streamStart = this.pos;
    this.epoch++;
    this.slotStart.fill(NaN);
    this.useMl = this.nextMl = false;
    this.misses.fill(-Infinity);
  }

  private stopStream(): void {
    this.dropCurrent();
    this.streaming = false;
    this.epoch++;
    this.slotStart.fill(NaN);
    this.useMl = this.nextMl = false;
  }

  private dropCurrent(): void {
    if (this.cur) this.pool.push(this.cur);
    this.cur = null;
  }

  private reset(): void {
    this.sep.reset();
    this.dryL.fill(0);
    this.dryR.fill(0);
    this.dspL.fill(0);
    this.dspR.fill(0);
    this.mlL.fill(0);
    this.mlR.fill(0);
    this.env = 1;
  }
}

function entry(buf: ArrayBuffer): PoolEntry {
  return { buf, head: new Float64Array(buf, 0, 2), data: new Float32Array(buf, ML_HEADER_BYTES, 2 * ML_BLOCK) };
}
