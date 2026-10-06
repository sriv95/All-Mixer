// Debug-only (off by default): per-block MDX response time and Spleeter catchUp time in preallocated rings of the
// last 256 samples; a summary line every 32 blocks. No allocation per block (the summary builds one string).
const RING = 256;
const EVERY = 32;

export class MlTiming {
  private readonly mdx = new Float64Array(RING);
  private readonly spl = new Float64Array(RING);
  private readonly sort = new Float64Array(RING);
  private nm = 0;
  private ns = 0;
  private blocks = 0;

  /** Record one block; returns the summary line every 32nd block, else null. `skipped` = Spleeter-miss count so far. */
  block(mdxMs: number, skipped: number): string | null {
    this.mdx[this.nm++ & (RING - 1)] = mdxMs;
    return ++this.blocks % EVERY === 0 ? this.summary(skipped) : null;
  }

  catchUp(ms: number): void {
    this.spl[this.ns++ & (RING - 1)] = ms;
  }

  private stats(src: Float64Array, count: number): string {
    const n = Math.min(count, RING);
    if (n === 0) return '-/-/-';
    const a = this.sort.subarray(0, n);
    a.set(src.subarray(0, n));
    a.sort();
    const q = (p: number) => a[Math.min(n - 1, Math.floor(p * n))].toFixed(0);
    return `${q(0.5)}/${q(0.95)}/${a[n - 1].toFixed(0)}`;
  }

  summary(skipped: number): string {
    return `[all-mixer ml] mdx resp p50/p95/max ${this.stats(this.mdx, this.nm)} ms, spl catchUp p50/p95/max ${this.stats(this.spl, this.ns)} ms, n ${this.blocks}, spleeter-skipped ${skipped}`;
  }
}
