const STATUS_CODE_PATTERN = /status code (\d{3})/;

function isClientError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const match = error.message.match(STATUS_CODE_PATTERN);
  if (!match) return false;
  const code = parseInt(match[1], 10);
  return code >= 400 && code < 500 && code !== 429;
}

/** Retries on 429, 5xx, and network failures. Does not retry other 4xx errors. */
export async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= maxRetries || isClientError(error)) throw error;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt + Math.random() * 500));
    }
  }
}
