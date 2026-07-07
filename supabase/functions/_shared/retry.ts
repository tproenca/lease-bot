// Generic retry-with-exponential-backoff helper.
//
// Two retry triggers, independently opt-in so callers preserve their exact
// behaviour:
//   - shouldRetry(result): retry based on the resolved value (e.g. HTTP status)
//   - retryOnThrow:        retry when fn() rejects (e.g. network/GraphQL errors)
//
// Backoff before attempt n (1-based, n > 0) is baseDelayMs * 2^(n-1):
// 1 s, 2 s, 4 s, … with the default 1000 ms base.

export interface RetryOptions<T> {
  /** Maximum number of attempts (including the first). Default 3. */
  maxAttempts?: number;
  /** Base backoff delay in ms; attempt n waits baseDelayMs * 2^(n-1). Default 1000. */
  baseDelayMs?: number;
  /** Return true to retry based on the resolved value. Default: never retry on value. */
  shouldRetry?: (result: T) => boolean;
  /** When true, retry if fn() throws; the last error is rethrown on exhaustion. Default false. */
  retryOnThrow?: boolean;
}

/**
 * Run `fn` up to `maxAttempts` times with exponential backoff.
 *
 * Retries when `shouldRetry(result)` is true, or when `fn` throws and
 * `retryOnThrow` is set. Returns the last result once attempts are exhausted;
 * if every attempt threw, rethrows the last error.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions<T> = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 1000,
    shouldRetry,
    retryOnThrow = false,
  } = options;

  let lastResult: T;
  let hasResult = false;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, baseDelayMs * Math.pow(2, attempt - 1))
      );
    }
    try {
      const result = await fn();
      lastResult = result;
      hasResult = true;
      if (!shouldRetry || !shouldRetry(result)) return result;
    } catch (err) {
      if (!retryOnThrow) throw err;
      lastError = err;
      hasResult = false;
    }
  }

  if (hasResult) return lastResult!;
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
