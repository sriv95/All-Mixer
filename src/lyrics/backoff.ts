/** Thrown instead of fetching (or after a 429/403) so the caller skips this source; nothing is cached. */
export class RateLimited extends Error {}

const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

/** Cooldown of one remote source. In memory only: a restarted service worker starts without one. */
export class Backoff {
  private until = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Throws RateLimited while the cooldown runs. */
  check(): void {
    if (this.now() < this.until) throw new RateLimited('cooling down');
  }

  /** Start a cooldown: the Retry-After header (seconds or an HTTP date), else 5 minutes. */
  trip(retryAfter: string | null): never {
    const secs = Number(retryAfter);
    const ms = retryAfter && Number.isFinite(secs) ? secs * 1000 : retryAfter ? Date.parse(retryAfter) - this.now() : NaN;
    this.until = this.now() + (ms > 0 ? ms : DEFAULT_COOLDOWN_MS);
    throw new RateLimited('rate limited');
  }
}
