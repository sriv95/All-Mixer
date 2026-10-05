// Debug-only: makes the ML worker late on demand so QA can force the deadline-miss fallback.
// Returns null when off (stallMs <= 0), so the block loop has no extra await or timer.
export interface StallOpts {
  stallMs: number;
  stallAfterMs: number;
}

export function makeStall(
  { stallMs, stallAfterMs }: StallOpts,
  now: () => number = () => performance.now(),
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): (() => Promise<void>) | null {
  if (!(stallMs > 0)) return null;
  let first = NaN;
  return () => {
    const t = now();
    if (Number.isNaN(first)) first = t;
    return t - first >= stallAfterMs ? sleep(stallMs) : Promise.resolve();
  };
}
