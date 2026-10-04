// Warm-up timing: the first `skip` runs (shader compile, first upload) are timed but excluded from
// the percentiles, so p50/p95 describe the steady state that has to meet the block deadline.
export interface WarmUpResult {
  p50: number;
  p95: number;
  /** Total time of the skipped runs. */
  firstMs: number;
}

export const percentile = (a: readonly number[], p: number): number => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
};

export async function warmUp(
  step: () => Promise<void>,
  { skip, n }: { skip: number; n: number },
  now: () => number = () => performance.now(),
): Promise<WarmUpResult> {
  let firstMs = 0;
  for (let i = 0; i < skip; i++) {
    const t = now();
    await step();
    firstMs += now() - t;
  }
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = now();
    await step();
    times.push(now() - t);
  }
  return { p50: percentile(times, 0.5), p95: percentile(times, 0.95), firstMs };
}
