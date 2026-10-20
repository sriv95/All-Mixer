import { describe, expect, it } from 'vitest';
import { QUANTUM, RING, SLOTS, SeparatorCore, ringOk } from './core';
import {
  GEOMETRY,
  ML_BLOCK,
  ML_HEADER_BYTES,
  ML_LATENCY_SAMPLES,
  ML_RESULT_OFFSET,
  ROF_LATENCY_SAMPLES,
  bufferBytes,
  planesFor,
  type FromWorklet,
  type MlGeometry,
  type MlModel,
} from './protocol';

const SR = 44100;
/** Block m covers input [S + BASE + m·ML_BLOCK, + ML_BLOCK) of the stream that starts at S. */
const BASE = ML_BLOCK - ML_RESULT_OFFSET;
const L = ML_LATENCY_SAMPLES;

/** Deterministic noise in [-0.5, 0.5): every sample is unique, so a repeat or a skip shows up. */
function noise(n: number, seed: number): Float32Array {
  const out = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = s / 2 ** 32 - 0.5;
  }
  return out;
}

function tones(n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / SR) + 0.3 * Math.sin((2 * Math.PI * 1300 * i) / SR);
  return out;
}

type Policy = 'echo' | 'drop' | 'hold';

/** Stands in for the ML worker: returns each posted block with the true input as the "vocal". */
class FakePort {
  onmessage: ((e: MessageEvent) => void) | null = null;
  readonly seen = new Set<ArrayBuffer>();
  posted = 0;
  /** Blocks waiting to be returned: [due quantum, buffer]. */
  private queue: { due: number; buf: ArrayBuffer }[] = [];
  held: ArrayBuffer[] = [];
  /** Per posted block (0-based): what the worker does. Default echo. */
  policy: (k: number) => Policy = () => 'echo';
  /** Quanta between post and return. */
  latencyQ = 1;
  /** Drum geometry: the drums plane is this fraction of the true input. */
  drumShare = 0.25;
  /** Guitar geometry: the guitar plane is this fraction of the true input. */
  guitarShare = 0.1;
  /** Bass and piano geometry (the all-stems model): their planes are these fractions of the true input. */
  bassShare = 0.05;
  pianoShare = 0.2;
  now = 0;

  constructor(
    private readonly sigL: Float32Array,
    private readonly sigR: Float32Array,
    private readonly g: MlGeometry = GEOMETRY.mdx,
  ) {}

  postMessage(buf: ArrayBuffer): void {
    const { block, resultOffset } = this.g;
    expect(buf.byteLength).toBe(bufferBytes(this.g));
    this.seen.add(buf);
    const k = this.posted++;
    const how = this.policy(k);
    const head = new Float64Array(buf, 0, 2);
    if (how === 'hold') {
      this.held.push(buf);
      return;
    }
    if (how === 'drop') {
      head[1] = -1;
    } else {
      // Vocal for input [start − resultOffset, … + block): the true input, so vocal = dry.
      const start = head[1] - resultOffset;
      const data = new Float32Array(buf, ML_HEADER_BYTES, planesFor(this.g) * block);
      for (let i = 0; i < block; i++) {
        const p = start + i;
        data[i] = p >= 0 && p < this.sigL.length ? this.sigL[p] : 0;
        data[block + i] = p >= 0 && p < this.sigR.length ? this.sigR[p] : 0;
        data[2 * block + i] = data[i];
        data[3 * block + i] = data[block + i];
        let plane = 4;
        for (const [on, share] of [[this.g.drums, this.drumShare], [this.g.guitar, this.guitarShare], [this.g.bass, this.bassShare], [this.g.piano, this.pianoShare]] as const) {
          if (!on) continue;
          data[plane * block + i] = share * data[i];
          data[(plane + 1) * block + i] = share * data[block + i];
          plane += 2;
        }
      }
      head[1] = start;
    }
    this.queue.push({ due: this.now + this.latencyQ, buf });
  }

  /** Deliver due blocks (a port message between render quanta). */
  service(q: number): void {
    this.now = q;
    const due = this.queue.filter((e) => e.due <= q);
    this.queue = this.queue.filter((e) => e.due > q);
    for (const e of due) this.onmessage?.({ data: e.buf } as MessageEvent);
  }

  /** Return held blocks as the worker would (echo, current data), after the fact. */
  releaseHeld(): void {
    for (const buf of this.held) this.onmessage?.({ data: buf } as MessageEvent);
    this.held = [];
  }

  close(): void {}
}

interface Rig {
  core: SeparatorCore;
  port: FakePort;
  msgs: FromWorklet[];
  sigL: Float32Array;
  sigR: Float32Array;
  /** Output stems, grown by run(). */
  vL: number[];
  vR: number[];
  iL: number[];
  iR: number[];
  /** Drums output (the geometry's drum plane). */
  dL: number[];
  dR: number[];
  /** Guitar output (the geometry's guitar plane). */
  gL: number[];
  gR: number[];
  /** Bass and piano output. */
  aL: number[];
  aR: number[];
  pL: number[];
  pR: number[];
  /** Bypass weight per output sample. */
  b: number[];
  q: number;
  run(nq: number): void;
}

function rig(seconds: number, signal: (n: number, seed: number) => Float32Array = noise, model: MlModel | MlGeometry = 'mdx'): Rig {
  const total = Math.ceil((seconds * SR) / QUANTUM) * QUANTUM;
  const sigL = signal(total, 1);
  const sigR = signal(total, 2);
  const msgs: FromWorklet[] = [];
  const core = new SeparatorCore(SR, (m) => msgs.push(m));
  if (typeof model === 'string') core.setModel(model);
  else core.setGeometry(model);
  const port = new FakePort(sigL, sigR, typeof model === 'string' ? GEOMETRY[model] : model);
  core.setPort(port as unknown as MessagePort);
  const vl = new Float32Array(QUANTUM);
  const vr = new Float32Array(QUANTUM);
  const il = new Float32Array(QUANTUM);
  const ir = new Float32Array(QUANTUM);
  const bw = new Float32Array(QUANTUM);
  const dl = new Float32Array(QUANTUM);
  const dr = new Float32Array(QUANTUM);
  const gl = new Float32Array(QUANTUM);
  const gr = new Float32Array(QUANTUM);
  const al = new Float32Array(QUANTUM);
  const ar = new Float32Array(QUANTUM);
  const pl = new Float32Array(QUANTUM);
  const pr = new Float32Array(QUANTUM);
  const r: Rig = {
    core,
    port,
    msgs,
    sigL,
    sigR,
    vL: [],
    vR: [],
    iL: [],
    iR: [],
    dL: [],
    dR: [],
    gL: [],
    gR: [],
    aL: [],
    aR: [],
    pL: [],
    pR: [],
    b: [],
    q: 0,
    run(nq) {
      for (let k = 0; k < nq; k++) {
        const p = r.q * QUANTUM;
        core.process(sigL.subarray(p, p + QUANTUM), sigR.subarray(p, p + QUANTUM), vl, vr, il, ir, bw, p / SR, [dl, dr, gl, gr, al, ar, pl, pr]);
        for (let i = 0; i < QUANTUM; i++) {
          r.vL.push(vl[i]);
          r.vR.push(vr[i]);
          r.iL.push(il[i]);
          r.iR.push(ir[i]);
          r.dL.push(dl[i]);
          r.dR.push(dr[i]);
          r.gL.push(gl[i]);
          r.gR.push(gr[i]);
          r.aL.push(al[i]);
          r.aR.push(ar[i]);
          r.pL.push(pl[i]);
          r.pR.push(pr[i]);
          r.b.push(bw[i]);
        }
        r.q++;
        port.service(r.q);
      }
    },
  };
  return r;
}

/** Processor output at 100 % / 100 %: (1 − b)·(v + i) + b·(v + i). Output n is the sum of both stems (= the input at n − delay, when steady). */
const mixL = (r: Rig, n: number) => (1 - r.b[n]) * (r.vL[n] + r.iL[n]) + r.b[n] * (r.vL[n] + r.iL[n]);
const mixR = (r: Rig, n: number) => (1 - r.b[n]) * (r.vR[n] + r.iR[n]) + r.b[n] * (r.vR[n] + r.iR[n]);
const sigAt = (s: Float32Array, p: number) => (p >= 0 ? s[p] : 0);

/** Max |mix − input delayed by d| over output samples [from, to). */
function maxErr(r: Rig, d: number, from: number, to: number): number {
  let m = 0;
  for (let n = from; n < to; n++) {
    m = Math.max(m, Math.abs(mixL(r, n) - sigAt(r.sigL, n - d)), Math.abs(mixR(r, n) - sigAt(r.sigR, n - d)));
  }
  return m;
}

const blocks = (n: number) => (n * ML_BLOCK) / QUANTUM; // quanta

describe('ring geometry', () => {
  it('RING is the next power of two ≥ latency + QUANTUM + one ML block: 131072', () => {
    expect(RING).toBe(131072);
    expect(RING).toBeGreaterThanOrEqual(ML_LATENCY_SAMPLES + QUANTUM + ML_BLOCK);
    expect(RING / 2).toBeLessThan(ML_LATENCY_SAMPLES + QUANTUM + ML_BLOCK);
    expect(SLOTS).toBe(4);
    expect(SLOTS & (SLOTS - 1)).toBe(0);
    expect(SLOTS * ML_BLOCK).toBeGreaterThanOrEqual(RING - ML_BLOCK);
  });

  it('a ring that is too small or not a power of two fails', () => {
    expect(ringOk(RING, ML_LATENCY_SAMPLES, ML_BLOCK)).toBe(true);
    expect(ringOk(65536, ML_LATENCY_SAMPLES, ML_BLOCK)).toBe(false); // too small
    expect(ringOk(ML_LATENCY_SAMPLES + QUANTUM + ML_BLOCK - 1, ML_LATENCY_SAMPLES, ML_BLOCK)).toBe(false);
    expect(ringOk(120000, ML_LATENCY_SAMPLES, ML_BLOCK)).toBe(false); // big enough, not a power of two
    expect(ringOk(0, 0, 0)).toBe(false);
  });
});

describe('SeparatorCore, ML engine and bypass', () => {
  it('an impulse in the input comes out exactly ML_LATENCY_SAMPLES later (both stems)', () => {
    const P = 5 * ML_BLOCK + 321;
    const r = rig(12, (n) => {
      const x = new Float32Array(n);
      x[P] = 1;
      return x;
    });
    r.core.setActive(true, 'ml');
    r.run(blocks(10));
    let at = -1;
    for (let i = 0; i < r.vL.length; i++) if (Math.abs(r.vL[i] + r.iL[i]) > 0.5) at = i;
    expect(at).toBe(P + L);
    expect(r.vL[P + L]).toBeGreaterThan(0.99); // the vocal stem carries it
  });

  it('with every block back in time, output is the input delayed by exactly ML_LATENCY_SAMPLES', () => {
    expect(ML_LATENCY_SAMPLES).toBe(86912);
    const r = rig(14);
    r.core.setActive(true, 'ml');
    expect(r.core.engine).toBe('ml');
    expect(r.core.latencySamples).toBe(86912);
    r.run(blocks(14));
    const n = r.vL.length;
    // vocal is the echoed input, instrumental is what is left: both stems sum to the delayed input.
    expect(maxErr(r, L, 0, n)).toBeLessThanOrEqual(1e-6);
    // After the first block the vocal stem itself is the delayed input and the instrumental is ~0.
    let vocErr = 0;
    let insMax = 0;
    for (let i = L + QUANTUM; i < n; i++) {
      vocErr = Math.max(vocErr, Math.abs(r.vL[i] - r.sigL[i - L]), Math.abs(r.vR[i] - r.sigR[i - L]));
      insMax = Math.max(insMax, Math.abs(r.iL[i]), Math.abs(r.iR[i]));
    }
    expect(vocErr).toBeLessThanOrEqual(1e-6);
    expect(insMax).toBeLessThanOrEqual(1e-6);
    expect(r.core.stats.misses).toBe(0);
    expect(r.msgs).toEqual([]);
  });

  it('a dropped block plays the original mix at unity for that block: same delay, crossfade has no step above the bound', () => {
    const r = rig(14, tones);
    r.port.policy = (k) => (k === 4 ? 'drop' : 'echo');
    r.core.setActive(true, 'ml');
    r.run(blocks(12));
    const n = r.vL.length;
    expect(r.core.stats.misses).toBe(1);
    expect(r.core.engine).toBe('ml');
    expect(r.msgs).toEqual([]);
    // Delay unchanged: the stems still sum to the input delayed by ML_LATENCY_SAMPLES.
    expect(maxErr(r, L, 0, n)).toBeLessThanOrEqual(1e-6);
    // The dropped posted block 4 is vocal block 3: input [S + BASE + 3·H, + H), heard ML_LATENCY_SAMPLES later.
    const from = L + BASE + 3 * ML_BLOCK;
    const to = from + ML_BLOCK;
    const echo = (i: number) => r.sigL[i - L];
    // delta: how far the vocal stem is from the echo at the two block-edge quanta (sensitivity of the test).
    let delta = 0;
    for (const [a, b] of [
      [from, from + QUANTUM],
      [to - QUANTUM, to],
    ]) {
      for (let i = a; i < b; i++) delta = Math.max(delta, Math.abs(echo(i) - r.vL[i]));
    }
    expect(delta).toBeGreaterThanOrEqual(0.3);
    // The block is the original at unity: bypass weight 1, vocal 0, instrumental = delayed input.
    const mid = from + 2 * QUANTUM;
    expect(r.b[mid]).toBe(1);
    expect(r.vL[mid]).toBe(0);
    expect(r.iL[mid]).toBeCloseTo(echo(mid), 6);
    expect(r.b[mid - ML_BLOCK]).toBe(0);
    // Step bound: the signal's own slope plus a one-quantum fade of size delta (≤ delta / QUANTUM per sample).
    let signalStep = 0;
    let step = 0;
    for (let i = from - 2 * QUANTUM; i < to + 2 * QUANTUM; i++) {
      signalStep = Math.max(signalStep, Math.abs(echo(i) - echo(i - 1)));
      step = Math.max(step, Math.abs(r.vL[i] - r.vL[i - 1]), Math.abs(r.iL[i] - r.iL[i - 1]));
    }
    const BOUND = signalStep + delta / QUANTUM + 1e-3;
    console.info(`crossfade: delta=${delta.toFixed(4)} BOUND=${BOUND.toFixed(4)} max step=${step.toFixed(4)}`);
    expect(step).toBeLessThanOrEqual(BOUND);
  });

  it('refuses ML when the context is not at the model rate', () => {
    const msgs: FromWorklet[] = [];
    const core = new SeparatorCore(48000, (m) => msgs.push(m));
    const port = new FakePort(new Float32Array(0), new Float32Array(0));
    core.setPort(port as unknown as MessagePort);
    core.setActive(true, 'ml');
    expect(core.engine).toBe('bypass');
    expect(port.posted).toBe(0);
    core.requestEngine('ml', 'auto');
    const z = new Float32Array(QUANTUM);
    for (let q = 0; q < 200; q++) core.process(z, z, z.slice(), z.slice(), z.slice(), z.slice(), z.slice(), q * 0.0027);
    expect(core.engine).toBe('bypass');
    expect(port.posted).toBe(0);
    expect(msgs).toEqual([]);
  });

  it('3 misses in 10 s switch to bypass for good, once, with reason deadline-miss', () => {
    const r = rig(15, tones);
    r.port.policy = (k) => (k === 4 || k === 6 || k === 8 ? 'drop' : 'echo');
    r.core.setActive(true, 'ml');
    r.run(blocks(14));
    expect(r.msgs).toHaveLength(1);
    const m = r.msgs[0] as Extract<FromWorklet, { type: 'engine' }>;
    expect(m).toMatchObject({ type: 'engine', engine: 'bypass', reason: 'deadline-miss' });
    expect(r.core.engine).toBe('bypass');
    expect(r.core.reason).toBe('deadline-miss');
    expect(r.core.latencySamples).toBe(0);
    // The output ends up undelayed and unprocessed.
    const n = r.vL.length;
    expect(maxErr(r, 0, n - 4096, n)).toBeLessThanOrEqual(1e-6);
    // `at`: context time of the first input sample heard with no delay. Find the first
    // quantum whose last sample is the undelayed input (not the ML-delayed one).
    let n0 = -1;
    for (let s = 6 * ML_BLOCK; s < n; s += QUANTUM) {
      const e = s + QUANTUM - 1;
      if (
        Math.abs(r.vL[e] + r.iL[e] - r.sigL[e]) < 1e-6 &&
        Math.abs(r.vL[e] + r.iL[e] - r.sigL[e - ML_LATENCY_SAMPLES]) > 1e-3
      ) {
        n0 = s;
        break;
      }
    }
    expect(n0).toBeGreaterThan(0);
    expect(m.at).toBeCloseTo(n0 / SR, 9);
    // It stays on bypass: no further messages even after more blocks.
    r.run(blocks(4));
    expect(r.msgs).toHaveLength(1);
  });

  it('3 misses spread over more than 10 s do not switch', () => {
    // 10 s = 12.9 blocks. Misses at blocks 4, 20 and 36.
    const r = rig(32, tones);
    r.port.policy = (k) => (k === 4 || k === 20 || k === 36 ? 'drop' : 'echo');
    r.core.setActive(true, 'ml');
    r.run(blocks(40));
    expect(r.core.stats.misses).toBe(3);
    expect(r.msgs).toEqual([]);
    expect(r.core.engine).toBe('ml');
    expect(r.core.latencySamples).toBe(ML_LATENCY_SAMPLES);
  }, 60_000);

  it('bypass plays the original mix: delay 0, b = 1, vocal 0, stems sum to the input', () => {
    const r = rig(1);
    r.core.setActive(true, 'bypass');
    expect(r.core.latencySamples).toBe(0);
    r.run(blocks(1));
    const n = r.vL.length;
    expect(maxErr(r, 0, 0, n)).toBeLessThanOrEqual(0);
    expect(Math.min(...r.b)).toBe(1);
    expect(Math.max(...r.vL.map(Math.abs))).toBe(0);
    expect(r.port.posted).toBe(0);
  });

  it('bypass → ML: no input sample repeats, `at` is the first input sample with the ML delay', () => {
    const r = rig(8);
    r.core.setActive(true, 'bypass');
    r.run(blocks(1) + 3);
    const P = r.q * QUANTUM + QUANTUM; // the switch starts at the next quantum, which fades the original out
    r.core.requestEngine('ml', 'auto');
    r.run(blocks(7));
    expect(r.msgs).toEqual([{ type: 'engine', engine: 'ml', reason: 'auto', at: P / SR }]);
    expect(r.core.engine).toBe('ml');
    const n = r.vL.length;
    // Original of inputs < P − 128 (undelayed), silence, then ML from input P.
    expect(maxErr(r, 0, 4096, P - QUANTUM)).toBeLessThanOrEqual(1e-6);
    let quiet = 0;
    for (let i = P; i < P + ML_LATENCY_SAMPLES; i++) {
      quiet = Math.max(quiet, Math.abs(mixL(r, i)), Math.abs(mixR(r, i)));
    }
    expect(quiet).toBe(0);
    expect(maxErr(r, ML_LATENCY_SAMPLES, P + ML_LATENCY_SAMPLES + QUANTUM, n)).toBeLessThanOrEqual(1e-6);
    // Fade-in quantum: input P … P+127 appears once, scaled by a ramp in (0, 1].
    for (let i = 0; i < QUANTUM; i++) {
      const out = mixL(r, P + ML_LATENCY_SAMPLES + i);
      expect(Math.abs(out)).toBeLessThanOrEqual(Math.abs(r.sigL[P + i]) + 1e-6);
    }
  });

  it('ML → bypass on request: skips ahead, nothing repeats, `at` is the first input with no delay', () => {
    const r = rig(8);
    r.core.setActive(true, 'ml');
    r.run(blocks(5) + 5);
    const pos = r.q * QUANTUM;
    r.core.requestEngine('bypass', 'auto');
    r.run(blocks(4));
    // Handled at the start of quantum `pos`; the original follows from the quantum after it.
    expect(r.msgs).toHaveLength(1);
    expect(r.msgs[0]).toMatchObject({ type: 'engine', engine: 'bypass', reason: 'auto' });
    expect((r.msgs[0] as { at: number }).at).toBeCloseTo((pos + QUANTUM) / SR, 9); // one sample is 22.7 µs
    const n = r.vL.length;
    expect(maxErr(r, ML_LATENCY_SAMPLES, L, pos)).toBeLessThanOrEqual(1e-6);
    expect(maxErr(r, 0, pos + 2 * QUANTUM, n)).toBeLessThanOrEqual(1e-6);
    // The first bypass output (input pos + 128) is past the last ML input (pos − ML_LATENCY_SAMPLES + 128).
    expect(pos + QUANTUM).toBeGreaterThan(pos - ML_LATENCY_SAMPLES + QUANTUM);
  });

  it('the pool is reused: no buffer is created after warm-up', () => {
    const r = rig(24);
    r.core.setActive(true, 'ml');
    r.run(blocks(5));
    const warm = r.port.seen.size;
    r.run(blocks(25));
    expect(r.port.posted).toBeGreaterThan(25);
    expect(r.port.seen.size).toBe(warm);
    expect(r.port.seen.size).toBeLessThanOrEqual(4);
    expect(r.core.stats.returned).toBeGreaterThan(20);
  });

  it('a worker that never answers (pool exhausted) falls back to bypass', () => {
    const r = rig(6, tones);
    r.port.policy = () => 'hold';
    r.core.setActive(true, 'ml');
    r.run(blocks(6));
    expect(r.msgs).toHaveLength(1);
    expect(r.msgs[0]).toMatchObject({ engine: 'bypass', reason: 'deadline-miss' });
    expect(r.port.seen.size).toBeLessThanOrEqual(4);
  });

  it('flush() during ML drops in-flight blocks: no stale vocal is played', () => {
    const r = rig(14);
    r.core.setActive(true, 'ml');
    r.run(blocks(5));
    // Hold the next blocks (in flight at the seek), then flush.
    r.port.policy = () => 'hold';
    r.run(blocks(1) + 3);
    expect(r.port.held.length).toBeGreaterThan(0);
    const F = r.q * QUANTUM;
    const returned = r.core.stats.returned;
    r.core.flush();
    r.port.releaseHeld(); // old-epoch blocks arrive late
    expect(r.core.stats.returned).toBe(returned);
    r.port.policy = () => 'echo';
    r.run(blocks(7));
    // Nothing is played from before the flush: silent until the new input reaches the output.
    let loud = 0;
    for (let i = F; i < F + ML_LATENCY_SAMPLES; i++) {
      loud = Math.max(loud, Math.abs(r.vL[i]), Math.abs(r.vR[i]), Math.abs(r.iL[i]), Math.abs(r.iR[i]));
    }
    expect(loud).toBeLessThan(1e-6); // a stale vocal would be ~0.5
    // Then the new stream plays, delayed by the same ML_LATENCY_SAMPLES, from input F.
    const n = r.vL.length;
    expect(maxErr(r, ML_LATENCY_SAMPLES, F + ML_LATENCY_SAMPLES + 2 * ML_BLOCK, n)).toBeLessThanOrEqual(1e-6);
    expect(r.core.stats.returned).toBeGreaterThan(returned);
    expect(r.msgs).toEqual([]);
  });
});

describe('SeparatorCore, audible (sound back after a seek)', () => {
  const audible = (r: Rig) => r.msgs.filter((m) => m.type === 'audible').length;

  it('reports after one ML delay of the input that follows expect-audio, not before', () => {
    const r = rig(14);
    r.core.setActive(true, 'ml');
    r.run(blocks(5));
    r.core.flush();
    r.core.expectAudio();
    const start = r.q;
    r.run(Math.floor(ML_LATENCY_SAMPLES / QUANTUM) - 2);
    expect(audible(r)).toBe(0);
    r.run(4);
    expect(audible(r)).toBe(1);
    expect(r.q - start).toBeGreaterThanOrEqual(ML_LATENCY_SAMPLES / QUANTUM);
    r.run(blocks(1));
    expect(audible(r)).toBe(1); // once
  });

  it('does not count while held: a pause stops the clock', () => {
    const r = rig(14);
    r.core.setActive(true, 'ml');
    r.run(blocks(5));
    r.core.flush();
    r.core.expectAudio();
    r.run(100);
    r.core.setHeld(true);
    r.run(2000);
    expect(audible(r)).toBe(0);
    r.core.setHeld(false);
    r.run(Math.ceil(ML_LATENCY_SAMPLES / QUANTUM) - 100 + 2);
    expect(audible(r)).toBe(1);
  });

  it('is immediate on the original mix (no delay), and a flush cancels a pending one', () => {
    const r = rig(4);
    r.core.setActive(true);
    r.run(4);
    r.core.expectAudio();
    expect(audible(r)).toBe(1);
    const m = rig(14);
    m.core.setActive(true, 'ml');
    m.run(blocks(5));
    m.core.expectAudio();
    m.core.flush();
    m.run(blocks(3));
    expect(audible(m)).toBe(0);
  });
});

describe('SeparatorCore, hold / release (pause)', () => {
  const Q0 = blocks(8); // hold here, ML steady
  const HELD = 600; // ≈ 1.7 s of paused quanta

  it('hold fades to silence within one quantum and the ring is frozen; release replays the same samples (no loss, no repeat)', () => {
    const r = rig(25);
    r.core.setActive(true, 'ml');
    r.run(Q0);
    r.core.setHeld(true);
    r.run(HELD);
    r.core.setHeld(false);
    r.run(blocks(1));
    const h0 = Q0 * QUANTUM;
    // Fade-out quantum: ends at 0, then exact silence.
    expect(Math.abs(mixL(r, h0 + QUANTUM - 1))).toBeLessThan(1e-6);
    for (let n = h0 + QUANTUM; n < h0 + HELD * QUANTUM; n++) expect(mixL(r, n)).toBe(0);
    // After release (skipping the fade-in quantum): input delayed by L from where it was frozen.
    const rel = h0 + HELD * QUANTUM;
    let err = 0;
    for (let j = QUANTUM; j < blocks(1) * QUANTUM; j++) err = Math.max(err, Math.abs(mixL(r, rel + j) - sigAt(r.sigL, h0 - L + j)));
    expect(err).toBeLessThan(1e-6);
    // Fade-in quantum is the same samples under a ramp.
    for (let j = 0; j < QUANTUM; j++) expect(Math.abs(mixL(r, rel + j))).toBeLessThanOrEqual(Math.abs(sigAt(r.sigL, h0 - L + j)) + 1e-6);
  });

  it('input while held is not consumed: nothing is posted to the ML stream', () => {
    const r = rig(25);
    r.core.setActive(true, 'ml');
    r.run(Q0);
    r.core.setHeld(true);
    r.run(2);
    const posted = r.port.posted;
    r.run(blocks(3));
    expect(r.port.posted).toBe(posted);
    r.core.setHeld(false);
    r.run(blocks(2));
    expect(r.port.posted).toBeGreaterThan(posted);
  });

  it('flush while held clears the ring and keeps the hold until release', () => {
    const r = rig(25);
    r.core.setActive(true, 'ml');
    r.run(Q0);
    r.core.setHeld(true);
    r.run(4);
    r.core.flush();
    expect(r.core.isHeld).toBe(true);
    r.run(20);
    const n0 = r.vL.length - 20 * QUANTUM;
    for (let n = n0; n < r.vL.length; n++) expect(mixL(r, n)).toBe(0);
    r.core.setHeld(false);
    r.run(blocks(1));
    // Ring was cleared: the refill is silence (the 2 s ML delay again), not old audio.
    for (let n = r.vL.length - blocks(1) * QUANTUM; n < r.vL.length; n++) expect(mixL(r, n)).toBe(0);
  });

  it('hold during to-ml does not break the phase switch', () => {
    const r = rig(25);
    r.core.setActive(true, 'bypass');
    r.run(blocks(2));
    r.core.requestEngine('ml', 'auto');
    r.run(3);
    r.core.setHeld(true);
    r.run(200);
    r.core.setHeld(false);
    r.run(blocks(12));
    expect(r.msgs.filter((m) => m.type === 'engine')).toHaveLength(1);
    expect(r.core.engine).toBe('ml');
    expect(r.core.latencySamples).toBe(L);
    // Steady state later (everything in the ring was written after release): input delayed by L.
    const end = r.vL.length;
    expect(maxErr(r, L, end - 50 * QUANTUM, end)).toBeLessThan(1e-6);
  });

  it('hold in bypass: silent, frozen, resumes the live input', () => {
    const r = rig(5);
    r.core.setActive(true, 'bypass');
    r.run(100);
    r.core.setHeld(true);
    r.run(50);
    r.core.setHeld(false);
    r.run(50);
    const h0 = 100 * QUANTUM;
    expect(Math.abs(mixL(r, h0 + QUANTUM - 1))).toBeLessThan(1e-6);
    for (let n = h0 + QUANTUM; n < h0 + 50 * QUANTUM; n++) expect(mixL(r, n)).toBe(0);
    // After release the live input plays at once (fade-in quantum, then exact).
    const rel = h0 + 50 * QUANTUM;
    for (let j = QUANTUM; j < 50 * QUANTUM; j++) expect(mixL(r, rel + j)).toBeCloseTo(r.sigL[rel + j], 6);
  });
});

describe('SeparatorCore, RoFormer geometry', () => {
  const G = GEOMETRY.roformer;
  const rblocks = (n: number) => (n * G.block) / QUANTUM; // quanta; block 39690 is not a multiple of 128, so round up
  it('latency stays under 2 s', () => {
    expect(G.latency).toBe(ROF_LATENCY_SAMPLES);
    expect(G.latency / SR).toBeLessThan(2);
  });

  it('with every block back in time, output is the input delayed by the RoFormer latency (stems sum to it)', () => {
    const r = rig(14, noise, 'roformer');
    r.core.setActive(true, 'ml');
    expect(r.core.engine).toBe('ml');
    expect(r.core.latencySamples).toBe(G.latency);
    r.run(Math.ceil(rblocks(14)));
    const n = r.vL.length;
    expect(maxErr(r, G.latency, 0, n)).toBeLessThanOrEqual(1e-6);
    // from the first full block on, the vocal stem is the delayed input and the instrumental ~0
    let vocErr = 0;
    for (let i = G.latency + G.block; i < n; i++) vocErr = Math.max(vocErr, Math.abs(r.vL[i] - r.sigL[i - G.latency]));
    expect(vocErr).toBeLessThanOrEqual(1e-6);
    expect(r.core.stats.misses).toBe(0);
    expect(r.msgs).toEqual([]);
  });

  it('block, overlap and latency are whole render quanta (the core needs the 128-sample grid)', () => {
    for (const g of Object.values(GEOMETRY)) {
      expect(g.block % QUANTUM).toBe(0);
      expect(g.resultOffset % QUANTUM).toBe(0);
      expect(g.latency % QUANTUM).toBe(0);
    }
  });

  it('a model change waits for the original mix, then switching back to MDX restores its latency', () => {
    const r = rig(6, noise, 'roformer');
    r.core.setActive(true, 'ml');
    r.core.setModel('mdx'); // engine is ml: waits
    expect(r.core.latencySamples).toBe(G.latency);
    r.core.requestEngine('bypass', 'auto');
    r.run(4);
    expect(r.core.engine).toBe('bypass');
    r.core.setActive(false);
    r.core.setActive(true, 'ml');
    expect(r.core.latencySamples).toBe(ML_LATENCY_SAMPLES);
  });
});

describe('SeparatorCore, geometry planned at run time', () => {
  /** A 5 s block with a 5 s compute slack: 9.7 s of delay. */
  const planned: MlGeometry = { block: 1722 * QUANTUM, resultOffset: 69 * QUANTUM, latency: (1722 + 69 + 1563 + 1) * QUANTUM, warmupP90Ms: 4000 };

  it('output is the input delayed by the planned latency (stems sum to it)', () => {
    const r = rig(26, noise, planned);
    r.core.setActive(true, 'ml');
    expect(r.core.engine).toBe('ml');
    expect(r.core.latencySamples).toBe(planned.latency);
    r.run(Math.ceil((26 * SR) / QUANTUM) - 1);
    expect(maxErr(r, planned.latency, 0, r.vL.length)).toBeLessThanOrEqual(1e-6);
    expect(r.core.stats.misses).toBe(0);
    expect(r.msgs).toEqual([]);
  });

  it('a geometry that is off the quantum grid or does not fit the ring is ignored', () => {
    for (const bad of [{ ...planned, block: planned.block + 1 }, { ...planned, latency: planned.latency + 1 }, { ...planned, resultOffset: 5 }]) {
      const r = rig(2, noise, bad);
      r.core.setActive(true, 'ml');
      expect(r.core.latencySamples).toBe(GEOMETRY.mdx.latency);
    }
  });

  it('the longest plan (15 s) fits the ring', () => {
    const max: MlGeometry = { block: 56 * 128 * 10, resultOffset: 69 * QUANTUM, latency: Math.floor((15 * SR) / QUANTUM) * QUANTUM, warmupP90Ms: 1 };
    const r = rig(1, noise, max);
    r.core.setActive(true, 'ml');
    expect(r.core.latencySamples).toBe(max.latency);
  });
});

describe('SeparatorCore, drum stage', () => {
  // block 40, offset 10, delay 40 + 10 + 30 + 1 quanta: a geometry of the shape the drum planner makes
  const drumsG: MlGeometry = { block: 40 * QUANTUM, resultOffset: 10 * QUANTUM, latency: 81 * QUANTUM, warmupP90Ms: 1, drums: true };

  it('a drum geometry has 6 planes per block and a ring that holds its latency', () => {
    expect(planesFor(drumsG)).toBe(6);
    expect(planesFor({})).toBe(4);
    expect(bufferBytes(drumsG)).toBe(ML_HEADER_BYTES + 6 * drumsG.block * 4);
    expect(ringOk(131072, drumsG.latency, drumsG.block)).toBe(true);
  });

  it('the drums plane comes out with the instrumental delay, a part of the instrumental that stays whole', () => {
    const r = rig(3, noise, drumsG);
    r.core.setActive(true, 'ml');
    expect(r.core.latencySamples).toBe(drumsG.latency);
    r.run(Math.ceil((3 * SR) / QUANTUM) - 2);
    const D = drumsG.latency;
    let dErr = 0, iErr = 0;
    for (let n = D + 2 * drumsG.block; n < r.dL.length; n++) {
      // Vk = the input here, so the instrumental is ~0 and the vocal carries the signal; the drums are 25 % of the input
      dErr = Math.max(dErr, Math.abs(r.dL[n] - 0.25 * r.sigL[n - D]), Math.abs(r.dR[n] - 0.25 * r.sigR[n - D]));
      iErr = Math.max(iErr, Math.abs(r.iL[n]), Math.abs(r.iR[n]));
    }
    expect(dErr).toBeLessThan(1e-6);
    expect(iErr).toBeLessThan(1e-6);
    expect(r.dL.slice(0, D).every((v) => v === 0)).toBe(true);
  });

  it('without the drum stage the drums output stays silent', () => {
    const r = rig(3, noise, 'mdx');
    r.core.setActive(true, 'ml');
    r.run(Math.ceil((3 * SR) / QUANTUM) - 2);
    expect(r.dL.every((v) => v === 0) && r.dR.every((v) => v === 0)).toBe(true);
  });

  it('the original mix (bypass) has no drums', () => {
    const r = rig(1, noise, drumsG);
    r.core.setActive(true, 'bypass');
    r.run(200);
    expect(r.dL.every((v) => v === 0)).toBe(true);
  });
});

describe('SeparatorCore, guitar stage', () => {
  const base = { block: 40 * QUANTUM, resultOffset: 10 * QUANTUM, latency: 81 * QUANTUM, warmupP90Ms: 1 };
  const guitarG: MlGeometry = { ...base, guitar: true };
  const bothG: MlGeometry = { ...base, drums: true, guitar: true };

  it('each stage adds two planes to a block buffer', () => {
    expect(planesFor(guitarG)).toBe(6);
    expect(planesFor(bothG)).toBe(8);
    expect(bufferBytes(bothG)).toBe(ML_HEADER_BYTES + 8 * bothG.block * 4);
  });

  it('with both stages the drums and the guitar planes come out apart, with the instrumental delay', () => {
    const r = rig(3, noise, bothG);
    r.core.setActive(true, 'ml');
    r.run(Math.ceil((3 * SR) / QUANTUM) - 2);
    const D = bothG.latency;
    let dErr = 0, gErr = 0;
    for (let n = D + 2 * bothG.block; n < r.dL.length; n++) {
      dErr = Math.max(dErr, Math.abs(r.dL[n] - 0.25 * r.sigL[n - D]), Math.abs(r.dR[n] - 0.25 * r.sigR[n - D]));
      gErr = Math.max(gErr, Math.abs(r.gL[n] - 0.1 * r.sigL[n - D]), Math.abs(r.gR[n] - 0.1 * r.sigR[n - D]));
    }
    expect(dErr).toBeLessThan(1e-6);
    expect(gErr).toBeLessThan(1e-6);
  });

  it('with the guitar stage alone the guitar comes out and the drums stay silent', () => {
    const r = rig(3, noise, guitarG);
    r.core.setActive(true, 'ml');
    r.run(Math.ceil((3 * SR) / QUANTUM) - 2);
    const D = guitarG.latency;
    let gErr = 0;
    for (let n = D + 2 * guitarG.block; n < r.gL.length; n++) gErr = Math.max(gErr, Math.abs(r.gL[n] - 0.1 * r.sigL[n - D]));
    expect(gErr).toBeLessThan(1e-6);
    expect(r.dL.every((v) => v === 0)).toBe(true);
  });

  it('without the guitar stage the guitar output stays silent, and in bypass too', () => {
    const r = rig(2, noise, 'mdx');
    r.core.setActive(true, 'ml');
    r.run(Math.ceil((2 * SR) / QUANTUM) - 2);
    expect(r.gL.every((v) => v === 0)).toBe(true);
    const b = rig(1, noise, bothG);
    b.core.setActive(true, 'bypass');
    b.run(200);
    expect(b.gL.every((v) => v === 0)).toBe(true);
  });
});

describe('SeparatorCore, all-stems model (drums, guitar, bass and piano planes)', () => {
  const allG: MlGeometry = { block: 40 * QUANTUM, resultOffset: 10 * QUANTUM, latency: 81 * QUANTUM, warmupP90Ms: 1, drums: true, guitar: true, bass: true, piano: true };

  it('a block buffer has 12 planes, in the order drums, guitar, bass, piano', () => {
    expect(planesFor(allG)).toBe(12);
    expect(planesFor({ bass: true })).toBe(6);
    expect(planesFor({ piano: true, drums: true })).toBe(8);
    expect(bufferBytes(allG)).toBe(ML_HEADER_BYTES + 12 * allG.block * 4);
  });

  it('every part comes out apart with the instrumental delay', () => {
    const r = rig(3, noise, allG);
    r.core.setActive(true, 'ml');
    r.run(Math.ceil((3 * SR) / QUANTUM) - 2);
    const D = allG.latency;
    const worst = { d: 0, g: 0, a: 0, p: 0 };
    for (let n = D + 2 * allG.block; n < r.dL.length; n++) {
      worst.d = Math.max(worst.d, Math.abs(r.dL[n] - 0.25 * r.sigL[n - D]));
      worst.g = Math.max(worst.g, Math.abs(r.gL[n] - 0.1 * r.sigL[n - D]));
      worst.a = Math.max(worst.a, Math.abs(r.aL[n] - 0.05 * r.sigL[n - D]), Math.abs(r.aR[n] - 0.05 * r.sigR[n - D]));
      worst.p = Math.max(worst.p, Math.abs(r.pL[n] - 0.2 * r.sigL[n - D]), Math.abs(r.pR[n] - 0.2 * r.sigR[n - D]));
    }
    expect(Math.max(worst.d, worst.g, worst.a, worst.p)).toBeLessThan(1e-6);
  });

  it('bass alone takes the first plane pair, and the other parts stay silent', () => {
    const r = rig(3, noise, { ...allG, drums: false, guitar: false, piano: false });
    r.core.setActive(true, 'ml');
    r.run(Math.ceil((3 * SR) / QUANTUM) - 2);
    const D = allG.latency;
    let err = 0;
    for (let n = D + 2 * allG.block; n < r.aL.length; n++) err = Math.max(err, Math.abs(r.aL[n] - 0.05 * r.sigL[n - D]));
    expect(err).toBeLessThan(1e-6);
    expect([r.dL, r.gL, r.pL].every((a) => a.every((v) => v === 0))).toBe(true);
  });
});
