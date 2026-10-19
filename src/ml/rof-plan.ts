// Chunk planning for the RoFormer models: how long the model chunk and the block are, for a delay budget and the speed
// of this GPU. Pure (no ORT, no DOM), so Node can test it; the ML worker measures the speed and checks the plan.
//
// One step runs the model over a chunk of `frames` STFT frames: [E context | H emitted block | R overlap]. Output is
// delayed by H + R + slack + one quantum (src/worklet/protocol.ts MlGeometry.latency), where `slack` is the time a step
// may take. A longer H means fewer joins between chunks and more context for the samples in the middle of a chunk,
// but the step takes longer, and the delay grows with H and with the step time.
import { ML_BLOCK, ML_QUANTUM, ML_RESULT_OFFSET, ML_SAMPLE_RATE, type MlGeometry } from '../worklet/protocol';
import { SC_LAG, SC_STRIDE } from './scnet';

export const HOP = 441;
/** Samples before the emitted block that the model sees as context only (it is worst at the chunk edges). */
export const CONTEXT = 439;
/** A step must finish in `slack / MARGIN`: the same 1.15 as the warm-up gate. */
export const MARGIN = 1.15;
/** Frames the exported graph is measured at (the default 2 s geometry). */
export const BASE_FRAMES = 112;
/** Longest chunk: attention memory grows with its square. */
export const MAX_FRAMES = 900;
/** Delay budgets the popup offers, seconds (the slider; MIN_DELAY_S is the default). */
export const MIN_DELAY_S = 2;
export const MAX_DELAY_S = 15;
/** Smallest block worth running: 0.5 s. */
const MIN_BLOCK = 172 * ML_QUANTUM;
const SAMPLES_PER_MS = ML_SAMPLE_RATE / 1000;

export interface RofGeometry {
  /** STFT frames of the chunk (with centre padding). */
  frames: number;
  /** Samples of the chunk: (frames − 1) · HOP. */
  chunk: number;
  /** Samples emitted per step (H). */
  block: number;
  /** Cross-fade / lookahead samples (R). */
  overlap: number;
  /** Samples a step may take (the compute allowance). */
  slack: number;
  /** Drum stage (src/ml/scnet.ts): extra samples a result waits for its drums, 0 without it. */
  extra: number;
  /** Output delay: block + overlap + extra + slack + one quantum. */
  latency: number;
}

const alignDown = (n: number): number => Math.floor(n / ML_QUANTUM) * ML_QUANTUM;
const alignUp = (n: number): number => Math.ceil(n / ML_QUANTUM) * ML_QUANTUM;

/** Frames of a chunk that holds CONTEXT + block + overlap. */
export const framesFor = (block: number, overlap: number): number => Math.ceil((block + overlap + CONTEXT) / HOP) + 1;

export function makeGeometry(block: number, overlap: number, slack: number, extra = 0): RofGeometry {
  const frames = framesFor(block, overlap);
  return { frames, chunk: (frames - 1) * HOP, block, overlap, slack, extra, latency: block + overlap + extra + slack + ML_QUANTUM };
}

/** A split stage as the planners see it: a model run completes every `stride` samples, and a result waits up to `lag` samples for it. */
export interface StageShape {
  stride: number;
  lag: number;
}
export const DRUM_STAGE: StageShape = { stride: SC_STRIDE, lag: SC_LAG };

/** Stage model runs one block can need (the drum model by default): a chunk completes every `stride` samples. */
export const drumRuns = (block: number, stride = SC_STRIDE): number => Math.floor(block / stride) + 1;

/** Cross-fade / lookahead samples: 0.2 s. The overlap is computed twice (end of one chunk, start of the next), so a longer one costs speed. */
export const OVERLAP = 8832;

/**
 * Step time (ms) predicted from the one measured at BASE_FRAMES: linear in the frames, 15 % more per 225 frames beyond
 * 400 (attention; measured on an M1: 6.4 ms per frame up to 450 frames, 8.2 ms at 896).
 */
export const stepMs = (frames: number, baseMs: number): number => baseMs * (frames / BASE_FRAMES) * (1 + Math.max(0, frames - 400) / 1500);

/**
 * The longest block whose delay fits `delaySamples` for a GPU with a base step of `baseMs` (and, with the drum stage,
 * `drumMs` per drum model run), or null when the GPU cannot keep up: the step (with MARGIN) must fit the block, or steps queue up. The drum stage's wait (`extra`) comes on top of the budget: latency ≤ delaySamples + extra always.
 */
export function planRof(delaySamples: number, baseMs: number, drumMs = 0, stage: StageShape = DRUM_STAGE): RofGeometry | null {
  const extra = drumMs > 0 ? stage.lag : 0;
  const budget = delaySamples - OVERLAP - ML_QUANTUM; // block + slack
  const slackFor = (block: number): number => alignUp(MARGIN * (stepMs(framesFor(block, OVERLAP), baseMs) + (drumMs > 0 ? drumRuns(block, stage.stride) * drumMs : 0)) * SAMPLES_PER_MS);
  // Both limits (delay, and step ≤ block) get harder as the block grows, but not in a simple way past 400 frames: scan down.
  for (let block = alignDown(budget); block >= MIN_BLOCK; block -= ML_QUANTUM) {
    if (framesFor(block, OVERLAP) > MAX_FRAMES) continue;
    const slack = slackFor(block);
    if (block + slack <= budget && slack <= block) return makeGeometry(block, OVERLAP, slack, extra);
  }
  return null;
}

/** Warm-up gate for a planned geometry: the p90 of a step (ms) must stay under this. */
export const gateMs = (g: RofGeometry): number => g.slack / SAMPLES_PER_MS / MARGIN;

/**
 * Geometry of the default (MDX) model with the drum stage: its fixed block and offset, plus the wait for the drum chunk
 * (SC_LAG). A step that runs the drum model takes `mdxMs + drumMs` and the block behind it waits for it, so the slack
 * covers both and half a drum run more. null when the two together cannot keep up with the audio (their load per block
 * period, with MARGIN, is over 1).
 */
export function planMdxDrums(mdxMs: number, drumMs: number, stage: StageShape = DRUM_STAGE): MlGeometry | null {
  const periodMs = ML_BLOCK / SAMPLES_PER_MS;
  if (MARGIN * (mdxMs + (drumMs * ML_BLOCK) / stage.stride) > periodMs) return null;
  const slack = alignUp(MARGIN * (mdxMs + 1.5 * drumMs) * SAMPLES_PER_MS);
  const resultOffset = ML_RESULT_OFFSET + stage.lag;
  return { block: ML_BLOCK, resultOffset, latency: ML_BLOCK + resultOffset + slack + ML_QUANTUM, warmupP90Ms: slack / SAMPLES_PER_MS / MARGIN, drums: true };
}

/**
 * Block buffers the worklet needs when a stage run of `stallMs` stops the block loop: one filling, one being returned, and
 * one for every block that comes in during the stall (4 is enough for a drum run of under a block). At most 16.
 */
export const poolFor = (stallMs: number, blockMs: number): number => Math.min(16, Math.max(4, 3 + Math.ceil(stallMs / blockMs)));
