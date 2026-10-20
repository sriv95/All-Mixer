// Separator core: the ML block path plus the bypass (original mix) path, without worklet
// globals so it can be unit tested. The processor (separator-processor.ts) wraps it and applies
// the stem gains and the bypass weight.
//
// Both engines read from rings indexed by absolute input sample:
//   dry  input,  ml  vocal blocks back from the ML worker.
// Output at input position p reads index p − delay; instrumental = dry − Vk, where Vk = x − the Karaoke
// instrumental (MDX vocal plus the Spleeter-mask cleanup, src/ml/karaoke.ts); the vocal stem is the MDX vocal V.
//
// Bypass engine: delay 0, bypass weight b = 1, vocal 0, instrumental = dry: the original mix.
// ML engine: delay = the model's latency (protocol GEOMETRY). Input goes to the worker in blocks of the model's block size. Each
//   vocal block is chosen one quantum before it starts: ML if it is back, else the original mix
//   (b = 1; the rings hold it at the same delay, so there is no delay jump). Source switches
//   crossfade b over one quantum. 3 misses within 10 s → bypass engine ('deadline-miss').
//
// The processor outputs (1 − b)·(vg·v + ig·i) + b·(v + i).
//
// Engine switches change the delay. Bypass → ML plays the original up to input P, is silent
// for the ML delay, then plays ML from input P, so nothing repeats; ML → bypass skips ahead.
// `onEngine` reports the context time of the first input sample heard with the new delay;
// the video overlay steps there too.
//
// Hold (pause): the delay line freezes. The first held quantum fades the output out reading the ring
// at `pos`; `pos` then stays put, input is neither written nor fed to the ML stream, and the output is
// silent. Release resumes at the same `pos`, so the pending audio comes out unchanged. In the
// delay-0 case (bypass, or the original-mix part of `to-ml`) nothing is pending: the fade quantum plays
// live input and `pos` advances as usual.
//
// process() allocates nothing (engine-switch messages aside, which are rare). onBlock (port
// message handler) creates two typed-array views per returned block; that runs between quanta,
// not inside process(), and the transferred ArrayBuffer is a new object anyway.
// ML is refused unless the context runs at ML_SAMPLE_RATE.
import {
  GEOMETRY,
  PARTS,
  ML_BLOCK,
  ML_BUFFER_BYTES,
  ML_HEADER_BYTES,
  ML_SAMPLE_RATE,
  bufferBytes,
  planesFor,
  type FromWorklet,
  type MlEngine,
  type MlGeometry,
  type MlModel,
  type MlReason,
} from './protocol';

export const QUANTUM = 128;
/** Smallest power of two ≥ n. */
const pow2Ceil = (n: number): number => 2 ** Math.ceil(Math.log2(n));
/** A block is ready `latency` after its start and spans `block`, plus one quantum: 131072 for 86912 + 128 + 34304. */
const ringFor = (g: MlGeometry): number => pow2Ceil(g.latency + QUANTUM + g.block);
/** Block slots, a power of two ≥ ring / block (3.8 → 4): slot m & (slots − 1) holds block m. */
const slotsFor = (g: MlGeometry): number => pow2Ceil(Math.ceil(ringFor(g) / g.block));
/** Ring and slot counts of the default (MDX) geometry. */
export const RING = ringFor(GEOMETRY.mdx);
export const SLOTS = slotsFor(GEOMETRY.mdx);
/** Block buffers: one filling, ≤ 2 at the worker (MDX hop 743 ms vs ≤ 0.4 s response), the rest spare. `MlGeometry.pool` overrides it. */
const POOL = 4;

/** Ring sizing rule (unit tested): a power of two, holding latency + one quantum + one block. */
export function ringOk(ring: number, latency: number, block: number): boolean {
  return ring > 0 && (ring & (ring - 1)) === 0 && ring >= latency + QUANTUM + block;
}
for (const g of Object.values(GEOMETRY)) if (!ringOk(ringFor(g), g.latency, g.block)) throw new Error('separator ring too small');
const MISS_WINDOW_S = 10;
/**
 * ML vocal block m covers input [streamStart + base + block·m, … + block): the first returned block whose
 * region reaches into the stream. MDX: block 0 ends before the stream starts, so m = 0 is the second block.
 */
const baseFor = (g: MlGeometry): number => -g.resultOffset + g.block * Math.floor(g.resultOffset / g.block);

interface PoolEntry {
  buf: ArrayBuffer;
  head: Float64Array;
  data: Float32Array;
}

type Phase =
  | 'steady'
  /** Original mix until input `switchPos`, silence, then ML from input `switchPos`. */
  | 'to-ml'
  /** This quantum fades the ML output out; the original mix fades in on the next. */
  | 'to-bypass';

export class SeparatorCore {
  /** Block geometry of the ML model in use (see setModel). */
  private g: MlGeometry = GEOMETRY.mdx;
  private mask = RING - 1;
  private slots = SLOTS;
  private base = baseFor(GEOMETRY.mdx);
  private dryL = new Float32Array(RING);
  private dryR = new Float32Array(RING);
  private mlL = new Float32Array(RING);
  private mlR = new Float32Array(RING);
  /** MDX vocal (A cappella); the instrumental uses mlL/mlR (Vk = x − Karaoke instrumental). */
  private mlSL = new Float32Array(RING);
  private mlSR = new Float32Array(RING);
  /** The parts of the instrumental the geometry has (PARTS order: drums, guitar, bass, piano; only the ones that are on): L, R ring each. */
  private mlP: Float32Array[] = [];
  /** Absolute start of the ML block held in each slot (NaN = empty). */
  private slotStart = new Float64Array(SLOTS).fill(NaN);

  /** Absolute input index of the current (or next) quantum's first sample. */
  private pos = 0;
  /** Context time of `pos`. */
  private time = 0;
  private active = false;
  /** Engine whose output (and delay) we hear. */
  engine: MlEngine = 'bypass';
  reason: MlReason = 'auto';
  private delay = 0;
  private phase: Phase = 'steady';
  private switchPos = 0;
  /** Output envelope at the end of the last quantum (0 = silent). */
  private env = 1;
  /** Paused: delay line frozen (see header). */
  private held = false;
  private wantMl: MlReason | null = null;
  private wantBypass: MlReason | null = null;
  private pendingGeometry: MlGeometry | null = null;
  /** Input position whose audio reports `audible` when it is output (-1 = nothing awaited). */
  private audibleAt = -1;

  // ML stream
  private port: MessagePort | null = null;
  private streaming = false;
  private streamStart = 0;
  private epoch = 0;
  private pool: PoolEntry[] = [];
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
    for (let i = 0; i < POOL; i++) this.pool.push(entry(new ArrayBuffer(ML_BUFFER_BYTES), ML_BLOCK, 4));
  }

  get latencySamples(): number {
    return this.engine === 'ml' ? this.g.latency : 0;
  }

  /**
   * Use the block geometry of `model` for the next ML stream. It takes effect on the original mix (bypass, nothing
   * in flight): at once, or at the end of the switch to bypass. The rings are reallocated then (once per model switch,
   * on the original mix, so a hiccup of the allocation is not heard).
   */
  setModel(model: MlModel): void {
    this.setGeometry(GEOMETRY[model]);
  }

  /** Same as `setModel`, for a geometry that is not in the table (the RoFormer chunk plan, src/ml/rof-plan.ts). */
  setGeometry(g: MlGeometry): void {
    if (!ringOk(ringFor(g), g.latency, g.block) || g.block <= 0 || g.block % QUANTUM || g.resultOffset % QUANTUM || g.latency % QUANTUM) return;
    this.pendingGeometry = g;
    this.applyGeometry();
  }

  private applyGeometry(): void {
    if (this.pendingGeometry === null || this.engine !== 'bypass' || this.phase !== 'steady') return;
    const g = this.pendingGeometry;
    this.pendingGeometry = null;
    if (g.block === this.g.block && g.resultOffset === this.g.resultOffset && g.latency === this.g.latency) return;
    this.stopStream();
    this.g = g;
    const ring = ringFor(g);
    this.mask = ring - 1;
    this.slots = slotsFor(g);
    this.base = baseFor(g);
    this.dryL = new Float32Array(ring);
    this.dryR = new Float32Array(ring);
    this.mlL = new Float32Array(ring);
    this.mlR = new Float32Array(ring);
    this.mlSL = new Float32Array(ring);
    this.mlSR = new Float32Array(ring);
    this.mlP = PARTS.filter((p) => g[p]).flatMap(() => [new Float32Array(ring), new Float32Array(ring)]);
    this.slotStart = new Float64Array(this.slots).fill(NaN);
    this.pool = [];
    for (let i = 0; i < (g.pool ?? POOL); i++) this.pool.push(entry(new ArrayBuffer(bufferBytes(g)), g.block, planesFor(g)));
  }

  setPort(port: MessagePort): void {
    this.port?.close();
    this.port = port;
    port.onmessage = (e: MessageEvent) => {
      if (e.data instanceof ArrayBuffer) this.onBlock(e.data);
    };
  }

  setActive(on: boolean, engine: MlEngine = 'bypass', reason: MlReason = 'auto'): void {
    this.active = on;
    this.audibleAt = -1;
    this.reset();
    this.phase = 'steady';
    this.wantMl = this.wantBypass = null;
    this.engine = 'bypass';
    this.applyGeometry();
    this.engine = on && engine === 'ml' && this.mlAllowed() ? 'ml' : 'bypass';
    this.reason = reason;
    this.delay = this.latencySamples;
    if (this.engine === 'ml') this.startStream();
    else this.stopStream();
  }

  setHeld(on: boolean): void {
    this.held = on;
  }

  get isHeld(): boolean {
    return this.held;
  }

  /**
   * The real audio enters now (playback after a seek or a new source): `audible` is sent once it has gone through
   * the delay line, at once when there is no delay. Until then the output is silent (the line was emptied).
   */
  expectAudio(): void {
    if (!this.active || this.delay === 0) this.onEngine({ type: 'audible' });
    else this.audibleAt = this.pos + this.delay;
  }

  /** Drop everything buffered (seek). The ML stream restarts from here. */
  flush(): void {
    this.audibleAt = -1;
    this.reset();
    if (this.phase === 'to-ml') {
      // Nothing buffered is left to protect: finish the switch now.
      this.phase = 'steady';
      this.engine = 'ml';
      this.delay = this.g.latency;
    }
    if (this.streaming) this.startStream();
  }

  /** Ask for an engine switch; it starts at the next quantum. */
  requestEngine(engine: MlEngine, reason: MlReason): void {
    if (engine === 'ml') {
      this.wantBypass = null;
      this.wantMl = reason;
    } else {
      this.wantMl = null;
      this.wantBypass = reason;
    }
  }

  /**
   * One render quantum (QUANTUM frames); `time` is the context time of its first frame.
   * Writes the delayed vocal and instrumental stems and the bypass weight per sample
   * (0 = ML stems, 1 = original mix). `parts` (optional) is L, R for each of PARTS (drums, guitar, bass, piano): the parts of
   * the instrumental that the stages or the all-stems model took out (zero for one the geometry does not have); the instrumental stays whole.
   */
  process(
    inL: Float32Array,
    inR: Float32Array,
    vocL: Float32Array,
    vocR: Float32Array,
    insL: Float32Array,
    insR: Float32Array,
    byp: Float32Array,
    time: number,
    parts?: readonly Float32Array[],
  ): void {
    if (!this.active) {
      vocL.fill(0);
      vocR.fill(0);
      insL.fill(0);
      insR.fill(0);
      byp.fill(0);
      if (parts) for (const p of parts) p.fill(0);
      return;
    }
    const pos = this.pos;
    this.time = time;
    if (this.wantMl !== null) this.toMl(this.wantMl);
    if (this.wantBypass !== null) this.toBypass(this.wantBypass);

    const held = this.held;
    if (held && this.env === 0) {
      // Frozen and silent: no read, no write, no feed, `pos` stays.
      vocL.fill(0);
      vocR.fill(0);
      insL.fill(0);
      insR.fill(0);
      byp.fill(0);
      if (parts) for (const p of parts) p.fill(0);
      return;
    }
    // Fade-out quantum with audio pending in the ring: read it, consume nothing.
    const freeze = held && this.delay > 0;

    // 1. Ring: dry input.
    if (!freeze) {
      for (let i = 0; i < QUANTUM; i++) {
        const j = (pos + i) & this.mask;
        this.dryL[j] = inL[i];
        this.dryR[j] = inR[i];
      }
    }

    // 2. ML stream: fill the current block, send it when full.
    if (this.streaming && !freeze) this.feed(inL, inR);

    // 3. Envelope target and ML weight for this quantum.
    let target = held ? 0 : 1;
    if (held) {
      // target stays 0
    } else if (this.phase === 'to-ml') {
      // The original mix fades out on input P − QUANTUM … P − 1, then silence until ML reaches P.
      if (pos >= this.switchPos - QUANTUM) target = 0;
    } else if (this.phase === 'to-bypass') {
      target = 0;
    }
    this.w0 = this.w1 = 0;
    if (freeze) this.w0 = this.w1 = this.useMl ? 1 : 0;
    else if (this.engine === 'ml') this.chooseSource(pos - this.g.latency);

    // 4. Output: v = w·vocal, i = dry − w·soft vocal, b = 1 − w.
    const r0 = pos - this.delay;
    const env0 = this.env;
    const dE = (target - env0) / QUANTUM;
    const w0 = this.w0;
    const dW = (this.w1 - w0) / QUANTUM;
    const { dryL, dryR, mlL, mlR, mlSL, mlSR, mlP, mask } = this;
    for (let i = 0; i < QUANTUM; i++) {
      const j = (r0 + i) & mask;
      const e = env0 + dE * (i + 1);
      const w = w0 + dW * (i + 1);
      vocL[i] = e * w * mlSL[j];
      vocR[i] = e * w * mlSR[j];
      insL[i] = e * (dryL[j] - w * mlL[j]);
      insR[i] = e * (dryR[j] - w * mlR[j]);
      byp[i] = 1 - w;
    }
    let ring = 0;
    for (let p = 0; p < PARTS.length; p++) {
      const on = this.g[PARTS[p]] === true;
      const oL = parts?.[2 * p], oR = parts?.[2 * p + 1];
      const rL = on ? mlP[2 * ring] : undefined, rR = on ? mlP[2 * ring + 1] : undefined;
      if (on) ring++;
      if (!oL || !oR) continue;
      if (!rL || !rR) {
        oL.fill(0);
        oR.fill(0);
        continue;
      }
      for (let i = 0; i < QUANTUM; i++) {
        const j = (r0 + i) & mask;
        const ew = (env0 + dE * (i + 1)) * (w0 + dW * (i + 1));
        oL[i] = ew * rL[j];
        oR[i] = ew * rR[j];
      }
    }
    this.env = target;

    if (freeze) return;

    // 5. Engine changes take effect from the next quantum.
    if (this.phase === 'to-ml' && pos + QUANTUM === this.switchPos + this.g.latency) {
      this.phase = 'steady';
      this.engine = 'ml';
      this.delay = this.g.latency;
      this.decideInitial(this.switchPos);
    } else if (this.phase === 'to-bypass') {
      this.phase = 'steady';
      this.engine = 'bypass';
      this.delay = 0;
      this.stopStream();
    }
    this.pos = pos + QUANTUM;
    if (this.audibleAt >= 0 && this.pos >= this.audibleAt) {
      this.audibleAt = -1;
      this.onEngine({ type: 'audible' });
    }
    if (this.pendingGeometry !== null) this.applyGeometry();
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
    if (!this.mlAllowed() || this.engine !== 'bypass' || this.phase !== 'steady') return;
    this.phase = 'to-ml';
    this.switchPos = this.pos + QUANTUM; // this quantum fades the original out
    this.reason = reason;
    this.startStream();
    this.onEngine({ type: 'engine', engine: 'ml', reason, at: this.timeOf(this.switchPos) });
  }

  private toBypass(reason: MlReason): void {
    this.wantBypass = null;
    const pos = this.pos;
    if (this.phase === 'to-ml') {
      // ML output has not started: go back to the original mix from here (fades in if silent).
      this.phase = 'steady';
      this.reason = reason;
      this.stopStream();
      this.applyGeometry();
      this.onEngine({ type: 'engine', engine: 'bypass', reason, at: this.timeOf(pos) });
      return;
    }
    if (this.engine !== 'ml' || this.phase !== 'steady') return;
    this.phase = 'to-bypass';
    this.reason = reason;
    this.onEngine({ type: 'engine', engine: 'bypass', reason, at: this.timeOf(pos + QUANTUM) });
  }

  /** Sets w0 / w1 for the quantum that reads input r0 … r0 + QUANTUM − 1. */
  private chooseSource(r0: number): void {
    const { block } = this.g;
    const rel = r0 - (this.streamStart + this.base);
    if (rel < -QUANTUM) return; // before the stream: ring is silent there
    const off = rel - Math.floor(rel / block) * block;
    if (off === 0) {
      const was = this.useMl;
      this.useMl = this.nextMl;
      if (this.useMl && !was) {
        this.w1 = 1; // bypass → ML over the block's first quantum
        return;
      }
    }
    if (off === block - QUANTUM) {
      // Choose the next block now, so ML → bypass can fade over this quantum.
      this.nextMl = this.ready(Math.floor(rel / block) + 1);
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
    const m = Math.floor((p - (this.streamStart + this.base)) / this.g.block);
    this.useMl = this.nextMl = this.ready(m);
    if (!this.useMl) this.miss();
  }

  private ready(m: number): boolean {
    return this.slotStart[m & (this.slots - 1)] === this.streamStart + this.base + this.g.block * m;
  }

  private miss(): void {
    if (this.phase !== 'steady') return;
    this.stats.misses++;
    const pos = this.pos;
    if (pos - this.misses[0] <= MISS_WINDOW_S * this.sampleRate) {
      this.misses.fill(-Infinity);
      this.wantBypass = 'deadline-miss'; // third miss within the window
      return;
    }
    this.misses[0] = this.misses[1];
    this.misses[1] = pos;
  }

  private feed(inL: Float32Array, inR: Float32Array): void {
    const block = this.g.block;
    const fill = (this.pos - this.streamStart) % block;
    if (fill === 0) {
      this.cur = this.pool.pop() ?? null;
      // Every buffer is with the worker: it is blocks behind, far past any deadline.
      if (!this.cur) this.wantBypass = 'deadline-miss';
    }
    const cur = this.cur;
    if (!cur) return;
    cur.data.set(inL, fill);
    cur.data.set(inR, block + fill);
    if (fill + QUANTUM === block) {
      cur.head[0] = this.epoch;
      cur.head[1] = this.pos + QUANTUM - block;
      this.xfer[0] = cur.buf;
      this.port!.postMessage(cur.buf, this.xfer);
      this.cur = null;
      this.stats.posted++;
    }
  }

  /** A buffer back from the worker (port message handler, between render quanta). */
  private onBlock(buf: ArrayBuffer): void {
    // A buggy worker must not grow the pool.
    const block = this.g.block;
    if (buf.byteLength !== bufferBytes(this.g) || this.pool.length >= (this.g.pool ?? POOL)) return;
    const e = entry(buf, block, planesFor(this.g));
    const start = e.head[1];
    const rel = start - (this.streamStart + this.base);
    if (this.streaming && e.head[0] === this.epoch && rel >= 0 && rel % block === 0) {
      for (let i = 0; i < block; i++) {
        const j = (start + i) & this.mask;
        // The head of the first block lies before the stream (nothing was sent for it): keep it silent.
        const live = start + i >= this.streamStart;
        this.mlL[j] = live ? e.data[i] : 0;
        this.mlR[j] = live ? e.data[block + i] : 0;
        this.mlSL[j] = live ? e.data[2 * block + i] : 0;
        this.mlSR[j] = live ? e.data[3 * block + i] : 0;
        for (let k = 0; k < this.mlP.length; k++) this.mlP[k][j] = live ? e.data[(4 + k) * block + i] : 0;
      }
      this.slotStart[(rel / block) & (this.slots - 1)] = start;
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
    this.dryL.fill(0);
    this.dryR.fill(0);
    this.mlL.fill(0);
    this.mlR.fill(0);
    this.mlSL.fill(0);
    this.mlSR.fill(0);
    for (const p of this.mlP) p.fill(0);
    this.env = this.held ? 0 : 1;
  }
}

function entry(buf: ArrayBuffer, block: number, planes: number): PoolEntry {
  return { buf, head: new Float64Array(buf, 0, 2), data: new Float32Array(buf, ML_HEADER_BYTES, planes * block) };
}
