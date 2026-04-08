/**
 * Simple in-memory TTL cache.
 *
 * Used to avoid repeated API calls for data that rarely changes during a
 * session (project list, file list, languages).
 */
export class TTLCache<T> {
  private data = new Map<string, { value: T; expiresAt: number }>();

  get(key: string): T | undefined {
    const entry = this.data.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.data.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    this.data.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  delete(key: string): void {
    this.data.delete(key);
  }

  deleteByPrefix(prefix: string): void {
    for (const key of this.data.keys()) {
      if (key.startsWith(prefix)) this.data.delete(key);
    }
  }
}

const CACHE_TTL = 10 * 60_000; // 10 minutes

/** Shared cache instance for API responses. */
export const apiCache = new TTLCache<unknown>();

/** Clear all cached data for a project (call after import). */
export function invalidateProject(projectId: string): void {
  apiCache.delete(`files:${projectId}`);
  apiCache.delete(`languages:${projectId}`);
  apiCache.deleteByPrefix(`keys:${projectId}:`);
  apiCache.deleteByPrefix(`keys-all:${projectId}:`);
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
  const hit = apiCache.get(key) as T | undefined;
  if (hit !== undefined) return hit;

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
