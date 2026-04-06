import { getStatusCode } from "./errors.js";
import { rateLimiter } from "./rate-limiter.js";

function isClientError(error: unknown): boolean {
  const code = getStatusCode(error);
  return code !== null && code >= 400 && code < 500 && code !== 429;
}

/**
 * Acquires a rate-limiter token, then calls `fn`.
 * Retries on 429, 5xx, and network failures. Does not retry other 4xx errors.
 * Uses longer backoff for 429 to let the per-minute window reset.
 */
export async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rateLimiter.acquire();
      return await fn();
    } catch (error) {
      if (attempt >= maxRetries || isClientError(error)) throw error;

      const isRateLimit = getStatusCode(error) === 429;
      const baseDelay = isRateLimit ? 15_000 : 1000 * 2 ** attempt;
      const jitter = Math.random() * (isRateLimit ? 5000 : 500);
      await new Promise((r) => setTimeout(r, baseDelay + jitter));
    }
  }
}
