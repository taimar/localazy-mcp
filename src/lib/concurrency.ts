/**
 * Bounded-concurrency map.
 *
 * Localazy exposes no batch endpoint, so per-file work is one HTTP round-trip
 * each. Running those sequentially makes wall-clock time scale with file count;
 * a small worker pool keeps latency close to the slowest single file while
 * staying well inside the rate limiter's budget.
 *
 * Results keep input order. Workers claim indexes in order and always await
 * whatever they claimed, so the returned array is never sparse — but when
 * `shouldStop` fires it is SHORTER than `items`, covering only the leading
 * items that were processed. Compare `results.length` against `items.length`
 * to tell whether the run stopped early.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
  shouldStop: () => boolean = () => false,
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;

  async function worker(): Promise<void> {
    while (index < items.length && !shouldStop()) {
      const i = index++;
      results[i] = await fn(items[i]!);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );

  return results;
}
