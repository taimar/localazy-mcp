/**
 * Simple in-memory TTL cache.
 *
 * Used to avoid repeated API calls for data that rarely changes during a
 * session (project list, file list, languages, translation values).
 *
 * A read drops an expired entry lazily, and writes sweep the rest. Both are
 * needed. Most key families stay small — one project, one file list, one entry
 * per file and language — but `cacheKeys.keysPage` also varies by page limit and
 * cursor, so nothing ever reads those entries again to evict them. At roughly
 * 150 KB per page, a long paging session would otherwise retain every page it
 * ever fetched. Nothing stale is served either way, because reads check expiry.
 *
 * An upload clears the whole cache.
 */

/** How often a write walks the map evicting expired entries, in ms. */
const SWEEP_INTERVAL_MS = 60_000;

export class TTLCache<T> {
  private data = new Map<string, { value: T; expiresAt: number }>();
  private lastSweep = Date.now();

  /** The interval is injectable so tests do not have to wait a minute for it. */
  constructor(private readonly sweepIntervalMs: number = SWEEP_INTERVAL_MS) {}

  /** Entry count, expired-but-not-yet-evicted entries included. */
  get size(): number {
    return this.data.size;
  }

  /**
   * Return the live entry for `key`, or undefined if missing or expired.
   * Distinguishes "cached undefined" from "not cached", which a bare value
   * lookup cannot.
   */
  getEntry(key: string): { value: T } | undefined {
    const entry = this.data.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.data.delete(key);
      return undefined;
    }
    return entry;
  }

  get(key: string): T | undefined {
    return this.getEntry(key)?.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    this.sweepIfDue();
    this.data.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  clear(): void {
    this.data.clear();
  }

  /**
   * Evict every expired entry, at most once per interval.
   *
   * This is what keeps a paging session flat: the resident set stays near one TTL
   * window of writes instead of growing with the whole session. It matters after
   * the writes stop, too — what a session holds once it goes idle is whatever the
   * last sweep left behind, so the bound survives even though no later sweep runs.
   *
   * Writes drive it rather than a timer, because a process that has stopped
   * writing has also stopped growing.
   */
  private sweepIfDue(): void {
    const now = Date.now();
    if (now - this.lastSweep < this.sweepIntervalMs) return;
    this.lastSweep = now;

    for (const [key, entry] of this.data) {
      if (now > entry.expiresAt) this.data.delete(key);
    }
  }
}

const CACHE_TTL = 15 * 60_000; // 15 minutes

/** Shared cache instance for API responses. */
export const apiCache = new TTLCache<unknown>();

/** Every cache key in one place. */
export const cacheKeys = {
  /** The project list with languages — the one entry every tool derives from. */
  projects: "projects:withLanguages",
  files: (projectId: string): string => `files:${projectId}`,
  flat: (projectId: string, fileId: string, lang: string): string =>
    `flat:${projectId}:${fileId}:${lang}`,
  keysPage: (
    projectId: string, fileId: string, lang: string,
    limit: number, extraInfo: boolean, cursor?: string,
  ): string =>
    `keys:${projectId}:${fileId}:${lang}:${limit}:${extraInfo}:${cursor ?? "first"}`,
} as const;

/**
 * In-flight requests for singleflight deduplication.
 *
 * Membership doubles as the record of which fetches predate the last upload.
 * An invalidation empties this map, so a fetch still holding its own entry when
 * it settles is one that started after the upload, and only that fetch may
 * write to the cache.
 */
const inflight = new Map<string, Promise<unknown>>();

/**
 * Drop everything cached (call after an upload).
 *
 * An upload changes key values and the per-language statistics, and there is
 * only ever one project, so there is nothing worth keeping and no need for
 * this module to know which keys other modules write.
 */
export function invalidateCache(): void {
  apiCache.clear();
  // The in-flight requests go too. They carry pre-upload values, so a read
  // arriving now has to start its own instead of joining one of them.
  inflight.clear();
}

/**
 * Fetch with caching. Returns the cached value if present and not expired,
 * otherwise calls `fn`, caches the result, and returns it.
 *
 * Concurrent callers for the same key share a single in-flight request
 * (singleflight) so only one API call is made.
 */
export async function cached<T>(key: string, fn: () => Promise<T>, ttlMs = CACHE_TTL): Promise<T> {
  const hit = apiCache.getEntry(key) as { value: T } | undefined;
  if (hit) return hit.value;

  const pending = inflight.get(key) as Promise<T> | undefined;
  if (pending !== undefined) return pending;

  // Losing our entry means an upload cleared the map while this was out, so the
  // value is already stale. The caller that asked first still receives it; only
  // the cache refuses it, or the next reader would see pre-upload data.
  const isCurrent = (): boolean => inflight.get(key) === promise;

  const promise: Promise<T> = fn().then(
    (value) => {
      if (isCurrent()) apiCache.set(key, value, ttlMs);
      return value;
    },
  ).finally(() => {
    if (isCurrent()) inflight.delete(key);
  });

  inflight.set(key, promise);
  return promise;
}
