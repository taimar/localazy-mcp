/**
 * Every tunable knob, resolved once at startup.
 *
 * All of these are read here so the whole configuration surface is one file,
 * and so related limits (request rate against scan concurrency) can be
 * compared side by side.
 */

/** Parse a positive integer from the environment, falling back to `fallback`. */
export function envInt(name: string, fallback: number, min = 1): number {
  const parsed = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) ? Math.max(min, parsed) : fallback;
}

/** Max characters in any single tool response. */
export const CHARACTER_LIMIT = envInt("LOCALAZY_CHARACTER_LIMIT", 50_000, 1000);

// Localazy documents 100 requests/minute and 10 requests/second per token.
//
// The per-minute window is enforced close to the documented value: exceeding it
// is the one thing measured to actually return 429, and a single project scan
// (~60 requests) stays under it, so the ceiling only engages where a 429 would
// otherwise cost a 15s backoff. Headroom covers the dashboard and CLI sharing
// the token.
export const RATE_LIMIT = envInt("LOCALAZY_RATE_LIMIT", 90);

// The per-second value is deliberately well above the documented 10. A parallel
// scan peaks near 22 req/s, which the API serves without complaint, and holding
// to 10 would more than double the wall time of a cold scan for no observed
// benefit. This is a rail against runaway fan-out, not a throttle — and
// `withRetry` tightens it automatically if the API ever does push back.
export const RATE_LIMIT_PER_SECOND = envInt("LOCALAZY_RATE_LIMIT_PER_SECOND", 30);

/**
 * How many files a project-wide scan reads in parallel.
 *
 * This does not change how many requests a scan makes — that is fixed by the
 * file count — only how fast it drains the rate limiter's bucket. An audit
 * fetches a target and a source language per file, so in-flight requests peak
 * at roughly twice this number.
 */
export const FILE_CONCURRENCY = Math.min(envInt("LOCALAZY_FILE_CONCURRENCY", 8), RATE_LIMIT);
