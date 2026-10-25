/**
 * Fixed-window rate limiting, in-memory. Adequate for a single-node v1 API;
 * a deployment behind multiple nodes must front this with a shared limiter.
 * Never keyed on payload content — only on identity (installation or IP tier).
 */
export interface WindowCounters {
  [key: string]: { windowStart: number; count: number };
}

export class RateLimiter {
  private readonly counters: WindowCounters = {};
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly nowFn: () => number = () => Date.now(),
  ) {}

  /** true when the key has been seen too many times in the current window. */
  isLimited(key: string): boolean {
    const now = this.nowFn();
    let entry = this.counters[key];
    if (!entry || now - entry.windowStart >= this.windowMs) {
      entry = { windowStart: now, count: 0 };
      this.counters[key] = entry;
    }
    entry.count += 1;
    return entry.count > this.max;
  }

  secondsUntilWindowEnd(key: string): number {
    const entry = this.counters[key];
    if (!entry) return 0;
    const remaining = entry.windowStart + this.windowMs - this.nowFn();
    return Math.max(1, Math.ceil(remaining / 1000));
  }
}
