/**
 * Simple in-memory TTL cache.
 *
 * Used to avoid repeated API calls for data that rarely changes during a
 * session (project list, file list, languages, translation values).
 */

/** How often to walk the map evicting expired entries, in ms. */
const SWEEP_INTERVAL_MS = 60_000;

export class TTLCache<T> {
  private data = new Map<string, { value: T; expiresAt: number }>();
  private lastSweep = Date.now();

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
   * Evict expired entries. Reads already evict lazily, so this only reclaims
   * entries nothing looks at again — and only while writes keep arriving,
   * which is enough to stop a long session from accumulating stale
   * translation sets.
   */
  private sweepIfDue(): void {
    const now = Date.now();
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) return;
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
 * Drop everything cached (call after an upload).
 *
 * An upload changes key values and the per-language statistics, and there is
 * only ever one project, so there is nothing worth keeping and no need for
 * this module to know which keys other modules write.
 */
export function invalidateCache(): void {
  apiCache.clear();
}

/** In-flight requests for singleflight deduplication. */
const inflight = new Map<string, Promise<unknown>>();

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

  const promise = fn().then(
    (value) => {
      apiCache.set(key, value, ttlMs);
      return value;
    },
  ).finally(() => {
    inflight.delete(key);
  });

  inflight.set(key, promise);
  return promise;
}
