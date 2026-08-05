/**
 * Rate limiter for the Localazy API.
 *
 * A request waits until every configured window has room. See `constants.ts`
 * for which limits we hold to and why — the per-minute ceiling is enforced near
 * the documented value, while the per-second rail sits well above it by choice.
 *
 * These are sliding windows, not token buckets. A bucket holding N tokens and
 * refilling N per window lets 2N through the first window, which is how the
 * per-minute ceiling was being breached before — earning a 429 and a 15s backoff
 * in `withRetry`, far more than the throttling would have cost.
 */

import { RATE_LIMIT, RATE_LIMIT_PER_SECOND } from "../constants.js";

export type WindowSpec = {
  /** Max requests allowed within `windowMs`. */
  capacity: number;
  windowMs: number;
};

/** Tracks release times so no `windowMs` period ever holds more than `capacity`. */
class SlidingWindow {
  private readonly releases: number[] = [];

  constructor(private capacity: number, readonly windowMs: number) {}

  /**
   * Halve the allowance, never below `floor` and never upward. Returns the new
   * capacity, or null when there is nothing left to give up.
   *
   * A capacity already at or under the floor returns null rather than rising to
   * meet it. A configured rate below the floor is the operator's choice, so a 429
   * must not answer pushback by going faster.
   */
  reduceCapacity(floor: number): number | null {
    if (this.capacity <= floor) return null;
    this.capacity = Math.max(floor, Math.floor(this.capacity / 2));
    return this.capacity;
  }

  private prune(now: number): void {
    while (this.releases.length > 0 && now - this.releases[0]! >= this.windowMs) {
      this.releases.shift();
    }
  }

  record(now: number): void {
    this.releases.push(now);
  }

  /** Milliseconds until this window has room again, or 0 when it has room now. */
  msUntilRoom(): number {
    const now = Date.now();
    this.prune(now);
    if (this.releases.length < this.capacity) return 0;
    return Math.max(1, this.windowMs - (now - this.releases[0]!));
  }
}

/** Floor for `relax()`, so repeated 429s cannot throttle the server to a crawl. */
const MIN_PER_SECOND_CAPACITY = 5;

/** Waits at least this long get explained on stderr, at most once per interval. */
const LONG_WAIT_NOTICE_MS = 5_000;
const LONG_WAIT_NOTICE_INTERVAL_MS = 15_000;

const DEFAULT_WINDOWS: WindowSpec[] = [
  { capacity: RATE_LIMIT_PER_SECOND, windowMs: 1_000 },
  { capacity: RATE_LIMIT, windowMs: 60_000 },
];

export class RateLimiter {
  private readonly windows: SlidingWindow[];
  private timer: NodeJS.Timeout | null = null;
  private lastWaitNotice = 0;
  private readonly queue: Array<() => void> = [];

  constructor(windows: WindowSpec[] = DEFAULT_WINDOWS) {
    this.windows = windows.map((w) => new SlidingWindow(w.capacity, w.windowMs));
  }

  /** Record a release against every window, or against none. */
  private tryTake(): boolean {
    if (!this.windows.every((window) => window.msUntilRoom() === 0)) return false;
    const now = Date.now();
    for (const window of this.windows) window.record(now);
    return true;
  }

  private processQueue(): void {
    this.timer = null;
    while (this.queue.length > 0 && this.tryTake()) {
      this.queue.shift()!();
    }
    this.scheduleDrain();
  }

  /**
   * Keep at most one pending timer for the whole queue. Scheduling per waiter
   * would create one timer per queued call, all firing to do the same work.
   *
   * The timer is deliberately not unref'd: a pending drain means callers are
   * still waiting on unsettled promises, so the process must stay alive.
   */
  private scheduleDrain(): void {
    if (this.timer !== null || this.queue.length === 0) return;
    const delay = Math.max(...this.windows.map((window) => window.msUntilRoom()));
    this.noteLongWait(delay);
    this.timer = setTimeout(() => this.processQueue(), Math.max(1, delay));
  }

  /**
   * Say so when the per-minute ceiling forces a long pause. Auditing several
   * languages in a row genuinely exceeds 100 requests/minute, and without this
   * the resulting wait is indistinguishable from a hung tool call.
   */
  private noteLongWait(delayMs: number): void {
    if (delayMs < LONG_WAIT_NOTICE_MS) return;
    const now = Date.now();
    if (now - this.lastWaitNotice < LONG_WAIT_NOTICE_INTERVAL_MS) return;
    this.lastWaitNotice = now;
    console.error(
      `Localazy rate limit reached: waiting ~${Math.ceil(delayMs / 1000)}s for the window to clear ` +
      `(${this.queue.length} request(s) queued). This is the API's per-minute ceiling, not a hang.`
    );
  }

  /**
   * React to a 429 by halving the shortest window's allowance for the rest of
   * the session. We run above the documented per-second limit on purpose, so
   * this is how the server's own pushback walks us back down instead of the
   * session repeatedly paying the retry backoff.
   *
   * Returns the new allowance, or null when there is nothing left to give up.
   * The shortest window is found rather than assumed, because the constructor
   * takes windows in any order while the floor below is a per-second figure.
   */
  relax(): number | null {
    let shortest = this.windows[0];
    if (!shortest) return null;

    for (const window of this.windows) {
      if (window.windowMs < shortest.windowMs) shortest = window;
    }

    return shortest.reduceCapacity(MIN_PER_SECOND_CAPACITY);
  }

  /** Wait until every window has room, then claim a slot in each. */
  async acquire(): Promise<void> {
    // Only skip the queue when nobody is already waiting, so callers are served
    // in order instead of newcomers stealing slots from those queued.
    if (this.queue.length === 0 && this.tryTake()) return;

    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
      this.scheduleDrain();
    });
  }
}

/** Shared singleton — all API calls go through this limiter. */
export const rateLimiter = new RateLimiter();
