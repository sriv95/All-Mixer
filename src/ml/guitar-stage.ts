// Guitar stage: becruily's Mel-Band RoFormer guitar model (src/ml/roformer.ts) as a stem of Split instrumental, next to the
// drum stage (src/ml/scnet.ts) and in parallel with it. It takes the instrumental (input − Vk) and returns the guitar; the
// worklet mixes it with its own gain, apart from the drums and the rest. Blocks of `block` samples go through a
// RoformerStream as they complete; its output for block b is the guitar of [b·B − R, (b + 1)·B − R), so a sample waits at
// most B + R for its guitar (`lag`). A run takes seconds (a 6 s chunk: 2 s on an M1) and stops the ML block loop while it
// goes on: ORT's WebGPU EP cannot run two sessions at once (a second run fails to map its output buffer), so the planner
// covers it with slack and the worklet gets a bigger block pool (rof-plan.ts poolFor).
import { RoformerStream, type RoformerMeta } from './roformer';
import { makeGeometry, type RofGeometry, type StageShape } from './rof-plan';
import { ML_QUANTUM, ML_SAMPLE_RATE } from '../worklet/protocol';
import type { SplitStage } from './drum-engine';
import type { ScnetModelFn } from './scnet';

// The guitar model is trained on 11 s chunks and falls apart on short ones: at 1 s it hands over much of the other
// instruments (spike/bench/guitar_stage_eval.mjs: against the one-pass estimate, 5 dB SDR at 0.9 s, 9 dB at 5.9 s, 11 dB at
// 9.9 s), so the block is 5.5 s at the least, longer with a longer Delay limit, and the stage adds its whole block to the
// delay on top of it.
/** Shortest block: 5.5 s per model run. */
export const GUITAR_BLOCK = 242432;
/** 0.5 s overlap between chunks. */
export const GUITAR_OVERLAP = 22016;
/** Longest block: 10 s (about 1000 frames; the exported graph holds up to 1700). */
export const GUITAR_MAX_BLOCK = 441000 - (441000 % 128);

/** The block of the stage for a delay limit (ms; null = the 2 s default): the limit less the overlap, between GUITAR_BLOCK and GUITAR_MAX_BLOCK. */
export function guitarBlockFor(delayMs: number | null): number {
  const want = ((delayMs ?? 2000) / 1000) * ML_SAMPLE_RATE - GUITAR_OVERLAP;
  return Math.min(GUITAR_MAX_BLOCK, Math.max(GUITAR_BLOCK, Math.floor(want / ML_QUANTUM) * ML_QUANTUM));
}

/** Geometry of the guitar model's chunk. */
export const guitarGeometry = (block = GUITAR_BLOCK, overlap = GUITAR_OVERLAP): RofGeometry => makeGeometry(block, overlap, 0);

/** What the planners need: a model run completes every block, a result waits up to block + overlap. */
export const stageShape = (g: Pick<RofGeometry, 'block' | 'overlap'>): StageShape => ({ stride: g.block, lag: g.block + g.overlap });

const CAP = 2 ** 20;
const MASK = CAP - 1;

export class GuitarStage implements SplitStage {
  readonly lag: number;
  private readonly stream: RoformerStream;
  private readonly B: number;
  private readonly R: number;
  private readonly onRun?: (ms: number) => void;
  private readonly inL = new Float32Array(CAP);
  private readonly inR = new Float32Array(CAP);
  private readonly outL = new Float32Array(CAP);
  private readonly outR = new Float32Array(CAP);
  private readonly bl: Float32Array;
  private readonly br: Float32Array;
  private readonly ol: Float32Array;
  private readonly or: Float32Array;
  private pushed = 0;
  private blocks = 0;

  /** `onRun` gets the duration of every model run (ms), for the timing log. */
  constructor(meta: RoformerMeta, g: RofGeometry = guitarGeometry(), opts: { onRun?: (ms: number) => void } = {}) {
    if (g.block % ML_QUANTUM || g.block + g.overlap + ML_QUANTUM > CAP / 2) throw new Error('bad guitar stage geometry');
    this.stream = new RoformerStream(meta, g);
    this.B = g.block;
    this.R = g.overlap;
    this.lag = g.block + g.overlap;
    this.onRun = opts.onRun;
    this.bl = new Float32Array(g.block);
    this.br = new Float32Array(g.block);
    this.ol = new Float32Array(g.block);
    this.or = new Float32Array(g.block);
  }

  /** The stream, for the worker's warm-up (it needs the model input `x`). */
  get roformer(): RoformerStream {
    return this.stream;
  }

  reset(): void {
    this.inL.fill(0);
    this.inR.fill(0);
    this.outL.fill(0);
    this.outR.fill(0);
    this.pushed = 0;
    this.blocks = 0;
    this.stream.reset();
  }

  /** Guitar of every sample below this is final. */
  get ready(): number {
    return this.blocks * this.B - this.R;
  }

  async push(l: Float32Array, r: Float32Array, n: number, model: ScnetModelFn): Promise<void> {
    if (n > CAP / 2) throw new Error('block too long for the guitar stage');
    for (let i = 0; i < n; i++) {
      this.inL[(this.pushed + i) & MASK] = l[i];
      this.inR[(this.pushed + i) & MASK] = r[i];
    }
    this.pushed += n;
    const { B, R, bl, br, ol, or } = this;
    while ((this.blocks + 1) * B <= this.pushed) {
      const start = this.blocks * B;
      for (let i = 0; i < B; i++) {
        bl[i] = this.inL[(start + i) & MASK];
        br[i] = this.inR[(start + i) & MASK];
      }
      const t0 = this.onRun ? performance.now() : 0;
      await this.stream.process(bl, br, model, ol, or);
      this.onRun?.(performance.now() - t0);
      for (let i = 0; i < B; i++) {
        const u = start - R + i; // the block holds the guitar of [start − R, start − R + B)
        if (u < 0) continue;
        this.outL[u & MASK] = ol[i];
        this.outR[u & MASK] = or[i];
      }
      this.blocks++;
    }
  }

  read(start: number, n: number, outL: Float32Array, outR: Float32Array): void {
    for (let i = 0; i < n; i++) {
      const s = start + i;
      outL[i] = s >= 0 ? this.outL[s & MASK] : 0;
      outR[i] = s >= 0 ? this.outR[s & MASK] : 0;
    }
  }
}
