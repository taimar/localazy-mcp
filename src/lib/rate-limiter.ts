/**
 * Token bucket rate limiter.
 *
 * Proactively throttles API calls to stay under Localazy's 100 req/min limit.
 * Requests that exceed the budget are queued and released as tokens refill.
 */

// Localazy allows 100 req/min. We default to 90 to leave headroom for
// retries, clock skew between our token bucket and the server's window,
// and any out-of-band requests (dashboard, CLI) sharing the same API token.
const DEFAULT_REQUESTS_PER_MINUTE = 90;

export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillIntervalMs: number; // ms between token refills
  private readonly queue: Array<() => void> = [];

  constructor(requestsPerMinute?: number) {
    const rpm = requestsPerMinute ?? DEFAULT_REQUESTS_PER_MINUTE;
    this.maxTokens = rpm;
    this.tokens = rpm;
    this.refillIntervalMs = 60_000 / rpm;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const newTokens = Math.floor(elapsed / this.refillIntervalMs);
    if (newTokens > 0) {
      this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
      this.lastRefill += newTokens * this.refillIntervalMs;
    }
  }

  private processQueue(): void {
    this.refill();
    while (this.queue.length > 0 && this.tokens >= 1) {
      this.tokens--;
      const resolve = this.queue.shift()!;
      resolve();
    }
    if (this.queue.length > 0) {
      setTimeout(() => this.processQueue(), this.refillIntervalMs);
    }
  }

  /** Wait until a request token is available, then consume it. */
  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens--;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
      setTimeout(() => this.processQueue(), this.refillIntervalMs);
    });
  }
}

const RATE_LIMIT = Math.max(
  1,
  parseInt(process.env.LOCALAZY_RATE_LIMIT ?? String(DEFAULT_REQUESTS_PER_MINUTE), 10) ||
    DEFAULT_REQUESTS_PER_MINUTE,
);

/** Shared singleton — all API calls go through this limiter. */
export const rateLimiter = new RateLimiter(RATE_LIMIT);
