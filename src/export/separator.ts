import { ML_HEADER_BYTES, PARTS, bufferBytes, planesFor, type MlGeometry } from '../worklet/protocol';
import { EXPORT_SAMPLE_RATE, MAX_CHUNK_S, type Part } from '../shared/export';
import type { Pair, StemSlice } from './mix';

/** A reply that does not come this long after the last one means the model stopped (the worker answers a block in well under a second). */
const REPLY_TIMEOUT_MS = 120_000;
/** Zero blocks sent after the end of the recording to flush its tail; more than a few means the geometry is not what the worker said. */
const MAX_EXTRA_PAD_BLOCKS = 8;

interface Reply {
  vk: Pair;
  vocal: Pair;
  parts: Partial<Record<Part, Pair>>;
}

/**
 * Drives the ML worker the way the separator worklet does (same block buffers, src/worklet/protocol.ts), but from JS and
 * without the real-time clock: the whole recording is fed as one stream, so the model's context runs across the chunk borders.
 *
 *   push(chunk)  feeds a piece of at most MAX_CHUNK_S and returns the stems that are complete now (they trail the input by the
 *                result offset of the model);
 *   finish()     pads the end with silence and returns the rest.
 *
 * Output sample i is input sample i: the delay of the live engine does not exist here.
 */
export class OfflineSeparator {
  private readonly block: number;
  private readonly lag: number;
  private readonly parts: Part[];
  private readonly bytes: number;
  private readonly planes: number;
  private pool: ArrayBuffer[] = [];
  private pendL: Float32Array;
  private pendR: Float32Array;
  private pending = 0;
  private sent = 0;
  private pushed = 0;
  private emitted = 0;
  /** Input of the blocks that were sent, by block number, until their stems were handed out. */
  private readonly dry = new Map<number, Pair>();
  /** Stems by the absolute start of the region they cover. */
  private readonly replies = new Map<number, Reply>();
  /** Start of a reply modulo the block size, learned from the first reply (all replies sit on the same grid). */
  private phase: number | null = null;
  private inflight = 0;
  private failure: Error | null = null;
  private wake: (() => void) | null = null;
  private epoch = 1;

  constructor(
    private readonly port: MessagePort,
    readonly geometry: MlGeometry,
  ) {
    this.block = geometry.block;
    this.lag = geometry.resultOffset;
    this.parts = PARTS.filter((p) => geometry[p]);
    this.planes = planesFor(geometry);
    this.bytes = bufferBytes(geometry);
    this.pool = Array.from({ length: Math.max(2, geometry.pool ?? 4) }, () => new ArrayBuffer(this.bytes));
    this.pendL = new Float32Array(this.block);
    this.pendR = new Float32Array(this.block);
    port.onmessage = (e: MessageEvent) => this.onReply(e.data);
    port.start();
  }

  /** Input samples sent to the model and not yet handed out as stems. */
  get backlog(): number {
    return this.pushed - this.emitted;
  }

  async push(l: Float32Array, r: Float32Array): Promise<StemSlice | null> {
    if (l.length > MAX_CHUNK_S * EXPORT_SAMPLE_RATE) throw new Error(`a chunk of ${l.length} samples is longer than ${MAX_CHUNK_S} s`);
    this.pushed += l.length;
    let at = 0;
    while (at < l.length) {
      const n = Math.min(this.block - this.pending, l.length - at);
      this.pendL.set(l.subarray(at, at + n), this.pending);
      this.pendR.set(r.subarray(at, at + n), this.pending);
      this.pending += n;
      at += n;
      if (this.pending === this.block) await this.send();
    }
    await this.idle();
    return this.emit(this.pushed);
  }

  async finish(): Promise<StemSlice | null> {
    // Zero-fill the last block, then enough blocks for the results to reach the end of the recording.
    if (this.pending > 0) {
      this.pendL.fill(0, this.pending);
      this.pendR.fill(0, this.pending);
      this.pending = this.block;
      await this.send();
    }
    while (this.sent * this.block - this.lag < this.pushed) await this.sendSilence();
    await this.idle();
    // The grid the worker answered on may differ from the geometry: a few more blocks until the end is covered.
    for (let extra = 0; this.coveredTo() < this.pushed; extra++) {
      if (extra >= MAX_EXTRA_PAD_BLOCKS) throw new Error('the model did not return the end of the recording');
      await this.sendSilence();
      await this.idle();
    }
    return this.emit(this.pushed);
  }

  dispose(): void {
    this.fail(new Error('export stopped'));
    this.port.onmessage = null;
    this.port.close();
  }

  private async sendSilence(): Promise<void> {
    this.pendL.fill(0);
    this.pendR.fill(0);
    this.pending = this.block;
    await this.send();
  }

  private async send(): Promise<void> {
    await this.until(() => this.pool.length > 0);
    const buf = this.pool.pop()!;
    const head = new Float64Array(buf, 0, 2);
    head[0] = this.epoch;
    head[1] = this.sent * this.block;
    const data = new Float32Array(buf, ML_HEADER_BYTES, this.planes * this.block);
    data.set(this.pendL, 0);
    data.set(this.pendR, this.block);
    this.dry.set(this.sent, [this.pendL.slice(), this.pendR.slice()]);
    this.sent++;
    this.pending = 0;
    this.inflight++;
    this.port.postMessage(buf, [buf]);
  }

  private onReply(buf: unknown): void {
    if (!(buf instanceof ArrayBuffer) || buf.byteLength !== this.bytes) return;
    this.inflight--;
    const start = new Float64Array(buf, 0, 2)[1];
    if (start === -1) {
      this.fail(new Error('the model failed on a block'));
    } else {
      const B = this.block;
      const plane = (k: number): Float32Array => new Float32Array(buf, ML_HEADER_BYTES + k * B * 4, B).slice();
      const parts: Partial<Record<Part, Pair>> = {};
      this.parts.forEach((p, i) => (parts[p] = [plane(4 + 2 * i), plane(5 + 2 * i)]));
      this.phase ??= ((start % B) + B) % B;
      this.replies.set(start, { vk: [plane(0), plane(1)], vocal: [plane(2), plane(3)], parts });
    }
    this.pool.push(buf);
    this.wake?.();
  }

  private fail(e: Error): void {
    this.failure ??= e;
    this.wake?.();
  }

  /** Resolves when `ok()`; throws when the model failed or went quiet. */
  private async until(ok: () => boolean): Promise<void> {
    while (!ok()) {
      if (this.failure) throw this.failure;
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => {
          this.wake = null;
          reject(new Error('the model stopped answering'));
        }, REPLY_TIMEOUT_MS);
        this.wake = () => {
          clearTimeout(t);
          this.wake = null;
          resolve();
        };
      });
    }
    if (this.failure) throw this.failure;
  }

  private idle(): Promise<void> {
    return this.until(() => this.inflight === 0);
  }

  /** Start of the reply that holds sample `pos`. */
  private regionStart(pos: number): number {
    const B = this.block, p = this.phase ?? 0;
    return p + Math.floor((pos - p) / B) * B;
  }

  /** End of the stems that are there without a gap, starting at what was handed out. */
  private coveredTo(): number {
    let end = this.emitted;
    while (this.replies.has(this.regionStart(end))) end = this.regionStart(end) + this.block;
    return end;
  }

  private emit(limit: number): StemSlice | null {
    const end = Math.min(limit, this.coveredTo());
    const n = end - this.emitted;
    if (n <= 0) return null;
    const B = this.block;
    const pair = (): Pair => [new Float32Array(n), new Float32Array(n)];
    const slice: StemSlice = { start: this.emitted, length: n, dry: pair(), vk: pair(), vocal: pair(), parts: {} };
    for (const p of this.parts) slice.parts![p] = pair();
    for (let pos = this.emitted; pos < end; ) {
      const rs = this.regionStart(pos);
      const take = Math.min(end, rs + B) - pos;
      const rep = this.replies.get(rs)!;
      const from = pos - rs, to = pos - this.emitted;
      for (let c = 0; c < 2; c++) {
        slice.vk![c].set(rep.vk[c].subarray(from, from + take), to);
        slice.vocal![c].set(rep.vocal[c].subarray(from, from + take), to);
        for (const p of this.parts) slice.parts![p]![c].set(rep.parts[p]![c].subarray(from, from + take), to);
      }
      pos += take;
    }
    for (let pos = this.emitted; pos < end; ) {
      const j = Math.floor(pos / B);
      const take = Math.min(end, (j + 1) * B) - pos;
      const d = this.dry.get(j)!;
      for (let c = 0; c < 2; c++) slice.dry[c].set(d[c].subarray(pos - j * B, pos - j * B + take), pos - this.emitted);
      pos += take;
    }
    this.emitted = end;
    for (const k of [...this.replies.keys()]) if (k + B <= end) this.replies.delete(k);
    for (const j of [...this.dry.keys()]) if ((j + 1) * B <= end) this.dry.delete(j);
    return slice;
  }
}
