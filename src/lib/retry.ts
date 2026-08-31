export type RetryOptions = {
  maxAttempts: number;
  baseDelayMs: number;
  /** Only consulted when `fn()` throws — return true to try again. */
  isRetryable: (err: unknown) => boolean;
  /** Injected for deterministic tests; defaults to a real timer-based sleep. */
  sleep?: (ms: number) => Promise<void>;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exponential backoff with full jitter: each retry waits a random delay in
 * [0, baseDelayMs * 2^(attempt-1)). Retries only while isRetryable(err) is
 * true and attempts remain; the last error is rethrown once exhausted or
 * once isRetryable returns false. Deliberately generic — callers decide
 * what's retryable per docs/API_NOTES.md's three-state (CONFIRMED/FAILED/
 * UNKNOWN) model for their specific call, this module only implements the
 * backoff loop itself.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  let attempt = 0;

  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt >= opts.maxAttempts || !opts.isRetryable(err)) {
        throw err;
      }
      const maxDelay = opts.baseDelayMs * 2 ** (attempt - 1);
      const delay = Math.floor(Math.random() * maxDelay);
      await sleep(delay);
    }
  }
}
