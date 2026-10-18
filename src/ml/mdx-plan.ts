// Segment planning for the default model (MDX-Net 9482): how many STFT frames the model sees per step, for a delay
// budget and the speed of this GPU. Pure (no ORT, no DOM), so Node can test it; the ML worker measures the speed and
// checks the plan. Same idea as rof-plan.ts: a longer segment gives the model more context but delays the output more.
//
// One step runs the model over a segment of `frames` frames, 50 % overlap, so the block is half a segment. Output is
// delayed by one segment + KARAOKE_TAIL + slack (the time a step may take) + one quantum.
import { KARAOKE_TAIL, ML_QUANTUM, ML_SAMPLE_RATE, ML_SLACK_SAMPLES, type MlGeometry } from '../worklet/protocol';

/** The shipped segment (`ML_LATENCY_SAMPLES`, 1.97 s): the least delay, and the plan for every budget below the next size. */
export const MDX_T_MIN = 64;
/** Longest segment (6 s, the usual MDX-Net training length): beyond it the model sees spans it was not trained on, and memory grows. */
export const MDX_T_MAX = 256;
/** The U-Net halves the time axis repeatedly, so a segment must be a multiple of 32 frames (measured: 100 fails in ORT). */
export const MDX_T_STEP = 32;
/** A step must finish in `slack / MARGIN`: the same 1.5 as the warm-up gate of the default segment. */
export const MDX_MARGIN = 1.5;
const MDX_N_FFT = 4096;
const MDX_HOP = 1024;
const SAMPLES_PER_MS = ML_SAMPLE_RATE / 1000;

/** Samples of a segment of `frames` frames (no centre padding). */
export const mdxSegment = (frames: number): number => (frames - 1) * MDX_HOP + MDX_N_FFT;

const alignUp = (n: number): number => Math.ceil(n / ML_QUANTUM) * ML_QUANTUM;

/** Block geometry of a segment with `slack` samples of compute allowance. */
export function mdxGeometry(frames: number, slack: number): MlGeometry {
  const segment = mdxSegment(frames);
  return {
    block: segment / 2,
    resultOffset: segment / 2 + KARAOKE_TAIL,
    latency: segment + KARAOKE_TAIL + slack + ML_QUANTUM,
    warmupP90Ms: slack / SAMPLES_PER_MS / MDX_MARGIN,
  };
}

/** Slack for a segment: the default one, or what the predicted step needs (the time is linear in the frames). */
export const mdxSlack = (frames: number, baseMs: number): number =>
  Math.max(ML_SLACK_SAMPLES, alignUp(MDX_MARGIN * baseMs * (frames / MDX_T_MIN) * SAMPLES_PER_MS));

/**
 * The longest segment whose delay fits `delaySamples` for a GPU whose step at MDX_T_MIN frames takes `baseMs`, or null
 * when even the shipped segment does not fit (the GPU is too slow). latency ≤ delaySamples always.
 */
export function planMdx(delaySamples: number, baseMs: number): { frames: number; geometry: MlGeometry } | null {
  for (let frames = MDX_T_MAX; frames >= MDX_T_MIN; frames -= MDX_T_STEP) {
    const geometry = mdxGeometry(frames, mdxSlack(frames, baseMs));
    if (geometry.latency <= delaySamples) return { frames, geometry };
  }
  return null;
}
