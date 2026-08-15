import { getStatusCode } from "./errors.js";
import { rateLimiter } from "./rate-limiter.js";

export type RetryPolicy = "read" | "write";

/**
 * What a failed request says about whether Localazy acted on it. Both the
 * retry rule and the message the caller sees are read off this one split.
 *
 * - `refused` — a 429. Localazy never looked at the request, so sending it
 *   again is safe whatever it was. This server runs above the documented
 *   per-second limit on purpose, so writes have to survive the 429 that
 *   design expects.
 * - `rejected` — any other 4xx. Localazy read the request and turned it down,
 *   and it will turn down the same one again.
 * - `unknown` — a 5xx, a dropped connection, or a status we do not recognise.
 *   The import can have been accepted with only the response lost. Repeating
 *   it would create a second import batch, spend another of the project's 100
 *   imports for the day, and can overwrite an edit made in between.
 */
type Outcome = "refused" | "rejected" | "unknown";

function outcomeOf(error: unknown): Outcome {
  const code = getStatusCode(error);
  if (code === 429) return "refused";
  if (code !== null && code >= 400 && code < 500) return "rejected";
  return "unknown";
}

/** Whether a failed request may be sent again. A write repeats a refusal only. */
export function isRetryable(error: unknown, policy: RetryPolicy): boolean {
  const outcome = outcomeOf(error);
  return outcome === "refused" || (outcome === "unknown" && policy === "read");
}

/** Whether a failed write may already have been applied. */
export function isOutcomeUnknown(error: unknown): boolean {
  return outcomeOf(error) === "unknown";
}

/**
 * Acquires a rate-limiter token, then calls `fn`.
 * Uses longer backoff for 429 to let the per-minute window reset.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  policy: RetryPolicy = "read",
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rateLimiter.acquire();
      return await fn();
    } catch (error) {
      if (attempt >= maxRetries || !isRetryable(error, policy)) throw error;

      const isRateLimit = getStatusCode(error) === 429;

      if (isRateLimit) {
        // We deliberately run above Localazy's documented per-second limit, so a
        // 429 is the signal to ease off for the rest of the session.
        const reduced = rateLimiter.relax();
        if (reduced !== null) {
          console.error(
            `Localazy returned 429; reducing to ~${reduced} requests/second for this session. ` +
            "Set LOCALAZY_RATE_LIMIT_PER_SECOND lower to start there."
          );
        }
      }

      const baseDelay = isRateLimit ? 15_000 : 1000 * 2 ** attempt;
      const jitter = Math.random() * (isRateLimit ? 5000 : 500);
      await new Promise((r) => setTimeout(r, baseDelay + jitter));
    }
  }
}

/** Sends a write once unless Localazy refuses it outright. See {@link isRetryable}. */
export function withWriteRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  return withRetry(fn, maxRetries, "write");
}
