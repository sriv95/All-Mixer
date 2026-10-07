// One ML block step in the worker (no ORT, DOM or ports, so Node can test it with fake models).
//
// Block b in = input [b·H, (b + 1)·H), H = ML_BLOCK. MDX-Net runs on [block b − 1, block b] (src/ml/mdx.ts) and
// completes the vocal for [(b − 1)·H, b·H). The Spleeter vocal mask (src/ml/stream.ts) runs on the same input in
// its own 4096-sample steps, from a FIFO, and feeds the Karaoke combine (src/ml/karaoke.ts), which lags the
// MDX vocal by KARAOKE_TAIL. The block returns [blockStart − ML_RESULT_OFFSET, + H): Vk (x − Karaoke
// instrumental) and the MDX vocal V (A cappella).
//
// Scheduling (SRI-116: the GPU runs one model at a time, so a queued MDX run waits behind Spleeter runs):
// MDX first, then only the Spleeter steps the combine needs for this block, then the caller sends the
// block back, then `catchUp` runs the remaining Spleeter steps. Masks are needed ~1.3 s before the result is
// due, so Spleeter has far more slack than MDX.
import { ML_BLOCK, KARAOKE_TAIL } from '../worklet/protocol';
import { KaraokeCombiner } from './karaoke';
import { MdxStream, type MdxModelFn } from './mdx';
import { BINS, SPL_BLOCK, SpleeterStream, type ModelFn } from './stream';

const H = ML_BLOCK;
/**
 * Longest wait for Spleeter masks after the MDX step of a block (SRI-130). Slack to the deadline is 319 ms
 * (14080 samples + block); MDX p95 is 160 ms, so 60 ms keeps ~100 ms margin for the post and the worklet read.
 * Still missing → the block is combined with mask 0 (ungated x − V_mdx).
 */
export const SPL_WAIT_MS = 60;
const FIFO = 65536; // > H + SPL_BLOCK, power of two
const FMASK = FIFO - 1;

export interface Models {
  mdx: MdxModelFn;
  spleeter: ModelFn;
}

export class MlPipeline {
  readonly mdx = new MdxStream();
  readonly spl = new SpleeterStream();
  readonly kara: KaraokeCombiner;
  /** Input not yet given to Spleeter, [L: FIFO][R: FIFO], by absolute position. */
  private readonly fifo = new Float32Array(2 * FIFO);
  private readonly sL = new Float32Array(SPL_BLOCK);
  private readonly sR = new Float32Array(SPL_BLOCK);
  private readonly maskBlock = new Float32Array(4 * 2 * BINS);
  private readonly regL = new Float32Array(H);
  private readonly regR = new Float32Array(H);
  /** Next block index; input position of its first sample is b·H. */
  private b = 0;
  /** Spleeter has consumed input below this. */
  private splPos = 0;
  /** Input received so far ends here. */
  private inEnd = 0;

  /** Blocks whose Spleeter masks were still missing after the wait (combined with mask 0). */
  splMisses = 0;
  /** Running Spleeter loop (one step at a time, in order); null when idle. */
  private splRun: Promise<void> | null = null;
  private splTarget = -1;
  private splModel: ModelFn | null = null;
  /** Bumped by reset: a step still in flight from the old stream is dropped. */
  private gen = 0;

  constructor(g?: number, private readonly splWaitMs: number = SPL_WAIT_MS, fill = true) {
    this.kara = new KaraokeCombiner(g, fill);
  }

  reset(): void {
    this.gen++;
    this.splTarget = -1;
    this.splRun = null;
    this.mdx.reset();
    this.spl.reset();
    this.kara.reset();
    this.fifo.fill(0);
    this.b = 0;
    this.splPos = 0;
    this.inEnd = 0;
  }

  /**
   * Block in (`inL`/`inR`, ML_BLOCK samples; read before any output is written, so they may alias the outputs)
   * → vkL/vkR (x − Karaoke instrumental) and vL/vR (MDX vocal) for input [b·H − ML_RESULT_OFFSET, + H).
   */
  async process(
    inL: Float32Array,
    inR: Float32Array,
    models: Models,
    vkL: Float32Array,
    vkR: Float32Array,
    vL: Float32Array,
    vR: Float32Array,
  ): Promise<void> {
    const { kara, regL, regR } = this;
    const pos = this.b * H;
    this.inEnd = pos + H;
    kara.writeInput(pos, inL, inR, H);
    for (let i = 0; i < H; i++) {
      const j = (pos + i) & FMASK;
      this.fifo[j] = inL[i];
      this.fifo[FIFO + j] = inR[i];
    }
    // 1. MDX first.
    await this.mdx.process(inL, inR, models.mdx, regL, regR);
    kara.writeVocal(pos - H, regL, regR, H);
    // 2. The Spleeter steps the combine needs (bounded wait), then the combine; missing masks count as 0.
    const need = kara.neededMask(pos);
    if (kara.maskFrame < need) {
      const run = this.spleeterUntil(need, models.spleeter);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = await Promise.race([
        run.then(() => false),
        new Promise<boolean>((r) => (timer = setTimeout(() => r(true), this.splWaitMs))),
      ]);
      clearTimeout(timer);
      if (late && kara.maskFrame < need) this.splMisses++;
    }
    kara.advance(pos, true);
    // 3. Output [pos − H − TAIL, pos − TAIL): complete because every frame starting before it ends by `pos`.
    const o = pos - H - KARAOKE_TAIL;
    kara.emit(o, H, vkL, vkR);
    kara.emitVocal(o, H, vL, vR);
    kara.release(o, H);
    this.b++;
  }

  /** Run the Spleeter steps that are left for the input received so far (also finishes a late run). */
  catchUp(model: ModelFn): Promise<void> {
    return this.spleeterUntil(Infinity, model);
  }

  /**
   * Raise the target and return the loop that reaches it. A late loop keeps running in the background and is
   * shared, so Spleeter's steps stay one at a time and in order.
   */
  private spleeterUntil(frame: number, model: ModelFn): Promise<void> {
    this.splModel = model;
    if (frame > this.splTarget) this.splTarget = frame;
    if (this.splRun) return this.splRun;
    const run: Promise<void> = this.spleeterLoop().finally(() => {
      if (this.splRun === run) {
        this.splRun = null;
        this.splTarget = -1;
      }
    });
    return (this.splRun = run);
  }

  private async spleeterLoop(): Promise<void> {
    const { fifo, sL, sR, kara } = this;
    const gen = this.gen;
    while (gen === this.gen && this.splPos + SPL_BLOCK <= this.inEnd && kara.maskFrame < this.splTarget) {
      for (let i = 0; i < SPL_BLOCK; i++) {
        const j = (this.splPos + i) & FMASK;
        sL[i] = fifo[j];
        sR[i] = fifo[FIFO + j];
      }
      this.spl.analyze(sL, sR);
      const v = await this.splModel!(this.spl.x);
      if (gen !== this.gen) return;
      const t0 = this.spl.masks(v, this.maskBlock);
      kara.pushMasks(t0, this.maskBlock);
      this.splPos += SPL_BLOCK;
    }
  }
}
