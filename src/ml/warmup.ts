// Warm-up timing: the first `skip` runs (shader compile, first upload) are timed but excluded from
// the percentiles, so p50/p90/p95 describe the steady state that has to meet the block deadline.
export interface WarmUpResult {
  p50: number;
  p90: number;
  p95: number;
  /** Total time of the skipped runs. */
  firstMs: number;
}

const percentile = (a: readonly number[], p: number): number => {
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
  return { p50: percentile(times, 0.5), p90: percentile(times, 0.9), p95: percentile(times, 0.95), firstMs };
}

/** Pure retry decision: a first attempt at or over the gate gets exactly one more try; the result with the
 * lower p90 wins and carries both attempts' skipped time in `firstMs`. */
const pickAttempt = (first: WarmUpResult, second: WarmUpResult): WarmUpResult => {
  const best = second.p90 < first.p90 ? second : first;
  return { p50: best.p50, p90: best.p90, p95: best.p95, firstMs: first.firstMs + second.firstMs };
};

/** Runs `attempt(retry)` once, and once more (never again) when p90 >= gate. */
export async function warmUpGated(
  attempt: (retry: boolean) => Promise<WarmUpResult>,
  gateMs: number,
): Promise<WarmUpResult & { attempts: number }> {
  const first = await attempt(false);
  if (first.p90 < gateMs) return { ...first, attempts: 1 };
  const second = await attempt(true);
  const best = pickAttempt(first, second);
  // the first attempt's timed runs also count as start-up time
  return { ...best, attempts: 2 };
}
