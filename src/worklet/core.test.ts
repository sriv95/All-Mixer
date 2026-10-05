import { describe, expect, it } from 'vitest';
import { QUANTUM, SeparatorCore } from './core';
import {
  ML_BLOCK,
  ML_BUFFER_BYTES,
  ML_HEADER_BYTES,
  ML_LATENCY_SAMPLES,
  ML_RESULT_OFFSET,
  type FromWorklet,
} from './protocol';

const SR = 44100;

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
  now = 0;

  constructor(
    private readonly sigL: Float32Array,
    private readonly sigR: Float32Array,
  ) {}

  postMessage(buf: ArrayBuffer): void {
    expect(buf.byteLength).toBe(ML_BUFFER_BYTES);
    this.seen.add(buf);
    const k = this.posted++;
    const how = this.policy(k);
    const head = new Float64Array(buf, 0, 3);
    if (how === 'hold') {
      this.held.push(buf);
      return;
    }
    if (how === 'drop') {
      head[1] = -1;
    } else {
      // Vocal for input [start − ML_RESULT_OFFSET, … + ML_BLOCK): the true input, so vocal = dry.
      const start = head[1] - ML_RESULT_OFFSET;
      const data = new Float32Array(buf, ML_HEADER_BYTES, 4 * ML_BLOCK);
      for (let i = 0; i < ML_BLOCK; i++) {
        const p = start + i;
        data[i] = p >= 0 && p < this.sigL.length ? this.sigL[p] : 0;
        data[ML_BLOCK + i] = p >= 0 && p < this.sigR.length ? this.sigR[p] : 0;
        data[2 * ML_BLOCK + i] = data[i];
        data[3 * ML_BLOCK + i] = data[ML_BLOCK + i];
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
  /** Bypass weight per output sample. */
  b: number[];
  q: number;
  run(nq: number): void;
}

function rig(seconds: number, signal: (n: number, seed: number) => Float32Array = noise): Rig {
  const total = Math.ceil((seconds * SR) / QUANTUM) * QUANTUM;
  const sigL = signal(total, 1);
  const sigR = signal(total, 2);
  const msgs: FromWorklet[] = [];
  const core = new SeparatorCore(SR, (m) => msgs.push(m));
  const port = new FakePort(sigL, sigR);
  core.setPort(port as unknown as MessagePort);
  const vl = new Float32Array(QUANTUM);
  const vr = new Float32Array(QUANTUM);
  const il = new Float32Array(QUANTUM);
  const ir = new Float32Array(QUANTUM);
  const bw = new Float32Array(QUANTUM);
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
    b: [],
    q: 0,
    run(nq) {
      for (let k = 0; k < nq; k++) {
        const p = r.q * QUANTUM;
        core.process(sigL.subarray(p, p + QUANTUM), sigR.subarray(p, p + QUANTUM), vl, vr, il, ir, bw, p / SR);
        for (let i = 0; i < QUANTUM; i++) {
          r.vL.push(vl[i]);
          r.vR.push(vr[i]);
          r.iL.push(il[i]);
          r.iR.push(ir[i]);
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

describe('SeparatorCore, ML engine and bypass', () => {
  it('with every block back in time, output is the input delayed by exactly ML_LATENCY_SAMPLES', () => {
    expect(ML_LATENCY_SAMPLES).toBe(13440);
    const r = rig(3);
    r.core.setActive(true, 'ml');
    expect(r.core.engine).toBe('ml');
    expect(r.core.latencySamples).toBe(13440);
    r.run(blocks(30));
    const n = r.vL.length;
    // vocal is the echoed input, instrumental is what is left: both stems sum to the delayed input.
    expect(maxErr(r, 13440, 0, n)).toBeLessThanOrEqual(1e-6);
    // After the first block the vocal stem itself is the delayed input and the instrumental is ~0.
    let vocErr = 0;
    let insMax = 0;
    for (let i = 13440 + QUANTUM; i < n; i++) {
      vocErr = Math.max(vocErr, Math.abs(r.vL[i] - r.sigL[i - 13440]), Math.abs(r.vR[i] - r.sigR[i - 13440]));
      insMax = Math.max(insMax, Math.abs(r.iL[i]), Math.abs(r.iR[i]));
    }
    expect(vocErr).toBeLessThanOrEqual(1e-6);
    expect(insMax).toBeLessThanOrEqual(1e-6);
    expect(r.core.stats.misses).toBe(0);
    expect(r.msgs).toEqual([]);
  });

  it('a dropped block plays the original mix at unity for that block: same delay, crossfade has no step above the bound', () => {
    const r = rig(3, tones);
    r.port.policy = (k) => (k === 12 ? 'drop' : 'echo');
    r.core.setActive(true, 'ml');
    r.run(blocks(30));
    const n = r.vL.length;
    expect(r.core.stats.misses).toBe(1);
    expect(r.core.engine).toBe('ml');
    expect(r.msgs).toEqual([]);
    // Delay unchanged: the stems still sum to the input delayed by 13440.
    expect(maxErr(r, 13440, 0, n)).toBeLessThanOrEqual(1e-6);
    // The dropped posted block 12 is vocal block 11: input [S − 1024 + 11·4096, + 4096), heard 13440 later.
    const from = 13440 - 1024 + 11 * ML_BLOCK;
    const to = from + ML_BLOCK;
    const echo = (i: number) => r.sigL[i - 13440];
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
    const r = rig(4, tones);
    r.port.policy = (k) => (k === 12 || k === 14 || k === 16 ? 'drop' : 'echo');
    r.core.setActive(true, 'ml');
    r.run(blocks(40));
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
    for (let s = 12 * ML_BLOCK; s < n; s += QUANTUM) {
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
    r.run(blocks(10));
    expect(r.msgs).toHaveLength(1);
  });

  it('3 misses spread over more than 10 s do not switch', () => {
    // 10 s = 107.7 blocks. Misses at blocks 20, 130 and 240.
    const r = rig(24, tones);
    r.port.policy = (k) => (k === 20 || k === 130 || k === 240 ? 'drop' : 'echo');
    r.core.setActive(true, 'ml');
    r.run(blocks(250));
    expect(r.core.stats.misses).toBe(3);
    expect(r.msgs).toEqual([]);
    expect(r.core.engine).toBe('ml');
    expect(r.core.latencySamples).toBe(ML_LATENCY_SAMPLES);
  }, 60_000);

  it('bypass plays the original mix: delay 0, b = 1, vocal 0, stems sum to the input', () => {
    const r = rig(1);
    r.core.setActive(true, 'bypass');
    expect(r.core.latencySamples).toBe(0);
    r.run(blocks(4));
    const n = r.vL.length;
    expect(maxErr(r, 0, 0, n)).toBeLessThanOrEqual(0);
    expect(Math.min(...r.b)).toBe(1);
    expect(Math.max(...r.vL.map(Math.abs))).toBe(0);
    expect(r.port.posted).toBe(0);
  });

  it('bypass → ML: no input sample repeats, `at` is the first input sample with the ML delay', () => {
    const r = rig(3);
    r.core.setActive(true, 'bypass');
    r.run(blocks(10) + 3);
    const P = r.q * QUANTUM + QUANTUM; // the switch starts at the next quantum, which fades the original out
    r.core.requestEngine('ml', 'auto');
    r.run(blocks(20));
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
    const r = rig(3);
    r.core.setActive(true, 'ml');
    r.run(blocks(12) + 5);
    const pos = r.q * QUANTUM;
    r.core.requestEngine('bypass', 'auto');
    r.run(blocks(10));
    // Handled at the start of quantum `pos`; the original follows from the quantum after it.
    expect(r.msgs).toEqual([{ type: 'engine', engine: 'bypass', reason: 'auto', at: (pos + QUANTUM) / SR }]);
    const n = r.vL.length;
    expect(maxErr(r, ML_LATENCY_SAMPLES, 3 * ML_BLOCK, pos)).toBeLessThanOrEqual(1e-6);
    expect(maxErr(r, 0, pos + 2 * QUANTUM, n)).toBeLessThanOrEqual(1e-6);
    // The first bypass output (input pos + 128) is past the last ML input (pos − 13440 + 128).
    expect(pos + QUANTUM).toBeGreaterThan(pos - ML_LATENCY_SAMPLES + QUANTUM);
  });

  it('the pool is reused: no buffer is created after warm-up', () => {
    const r = rig(10);
    r.core.setActive(true, 'ml');
    r.run(blocks(10));
    const warm = r.port.seen.size;
    r.run(blocks(90));
    expect(r.port.posted).toBeGreaterThan(90);
    expect(r.port.seen.size).toBe(warm);
    expect(r.port.seen.size).toBeLessThanOrEqual(8);
    expect(r.core.stats.returned).toBeGreaterThan(80);
  });

  it('a worker that never answers (pool exhausted) falls back to bypass', () => {
    const r = rig(4, tones);
    r.port.policy = () => 'hold';
    r.core.setActive(true, 'ml');
    r.run(blocks(30));
    expect(r.msgs).toHaveLength(1);
    expect(r.msgs[0]).toMatchObject({ engine: 'bypass', reason: 'deadline-miss' });
    expect(r.port.seen.size).toBeLessThanOrEqual(8);
  });

  it('flush() during ML drops in-flight blocks: no stale vocal is played', () => {
    const r = rig(3);
    r.core.setActive(true, 'ml');
    r.run(blocks(12));
    // Hold the next blocks (in flight at the seek), then flush.
    r.port.policy = () => 'hold';
    r.run(blocks(2) + 3);
    expect(r.port.held.length).toBeGreaterThan(0);
    const F = r.q * QUANTUM;
    const returned = r.core.stats.returned;
    r.core.flush();
    r.port.releaseHeld(); // old-epoch blocks arrive late
    expect(r.core.stats.returned).toBe(returned);
    r.port.policy = () => 'echo';
    r.run(blocks(10));
    // Nothing is played from before the flush: silent until the new input reaches the output.
    let loud = 0;
    for (let i = F; i < F + ML_LATENCY_SAMPLES; i++) {
      loud = Math.max(loud, Math.abs(r.vL[i]), Math.abs(r.vR[i]), Math.abs(r.iL[i]), Math.abs(r.iR[i]));
    }
    expect(loud).toBeLessThan(1e-6); // a stale vocal would be ~0.5
    // Then the new stream plays, delayed by the same 13440 samples, from input F.
    const n = r.vL.length;
    expect(maxErr(r, ML_LATENCY_SAMPLES, F + ML_LATENCY_SAMPLES + 2 * ML_BLOCK, n)).toBeLessThanOrEqual(1e-6);
    expect(r.core.stats.returned).toBeGreaterThan(returned);
    expect(r.msgs).toEqual([]);
  });
});
