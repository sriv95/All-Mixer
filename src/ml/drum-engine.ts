// Drum stage around a vocal block engine (MDX or RoFormer): the instrumental of every vocal result (input − Vk) goes
// through the drum stage (src/ml/scnet.ts), and the reply carries the drums next to the vocal planes. Drums trail the
// vocal result by up to SC_LAG samples (a chunk has to be complete), so the vocal planes wait in rings and the whole
// reply is that much older: resultOffset grows by SC_LAG, and the delay of the geometry with it (rof-plan.ts).
import { DrumStage, type ScnetModelFn } from './scnet';

/** What the split needs from a stage (the drum stage, or the guitar stage in guitar-stage.ts). */
export interface SplitStage {
  /** Longest wait of a sample for its stem, samples. */
  readonly lag: number;
  reset(): void;
  /** Append `n` instrumental samples and run what is complete. */
  push(l: Float32Array, r: Float32Array, n: number, model: ScnetModelFn): Promise<void>;
  /** Final stem samples [start, start + n) (zero before the stream began); `start + n` must not pass what the last push completed. */
  read(start: number, n: number, outL: Float32Array, outR: Float32Array): void;
}

/** What the block loop (ml-worker.ts serve) needs from a model pipeline. */
export interface BlockEngine {
  block: number;
  resultOffset: number;
  /** Planes of the block buffer: 4 (input / Vk L, R, vocal L, R), 6 with drums. Default 4. */
  planes?: number;
  reset(): void;
  /** Block buffer data ([in L, in R, …] → [Vk L, R, vocal L, R, (drums L, R)]) in place. */
  process(data: Float32Array): Promise<void>;
  /** Work that can wait until the block has been sent back. */
  afterReply?(): Promise<void>;
  misses?(): number;
}

const CAP = 2 ** 20;
const MASK = CAP - 1;

export function withDrums(inner: BlockEngine, run: ScnetModelFn, stage: SplitStage = new DrumStage()): BlockEngine {
  const H = inner.block, Ro = inner.resultOffset;
  const xL = new Float32Array(CAP), xR = new Float32Array(CAP); // input, by input sample
  const planes = Array.from({ length: 4 }, () => new Float32Array(CAP)); // Vk L, R, vocal L, R, by result sample u
  const instL = new Float32Array(H), instR = new Float32Array(H);
  let n = 0; // result samples so far: block m covers u in [m·H, (m + 1)·H)
  return {
    block: H,
    resultOffset: Ro + stage.lag,
    planes: 6,
    reset() {
      inner.reset();
      stage.reset();
      xL.fill(0);
      xR.fill(0);
      for (const p of planes) p.fill(0);
      n = 0;
    },
    async process(d) {
      for (let i = 0; i < H; i++) {
        xL[(n + i) & MASK] = d[i];
        xR[(n + i) & MASK] = d[H + i];
      }
      await inner.process(d);
      for (let i = 0; i < H; i++) {
        const u = n + i, x = u - Ro; // result sample u belongs to input sample u − Ro
        for (let k = 0; k < 4; k++) planes[k][u & MASK] = d[k * H + i];
        instL[i] = (x >= 0 ? xL[x & MASK] : 0) - d[i];
        instR[i] = (x >= 0 ? xR[x & MASK] : 0) - d[H + i];
      }
      await stage.push(instL, instR, H, run);
      // the reply is for result samples [n − SC_LAG, n − SC_LAG + H): final in the stage, and still in the rings
      for (let i = 0; i < H; i++) {
        const u = n - stage.lag + i;
        for (let k = 0; k < 4; k++) d[k * H + i] = u >= 0 ? planes[k][u & MASK] : 0;
      }
      stage.read(n - stage.lag, H, d.subarray(4 * H, 5 * H), d.subarray(5 * H, 6 * H));
      n += H;
    },
    afterReply: inner.afterReply ? () => inner.afterReply!() : undefined,
    misses: inner.misses ? () => inner.misses!() : undefined,
  };
}
