/**
 * Retries an async function on failure with optional exponential back-off.
 *
 * @param fn          The async function to attempt. Receives the attempt index (0-based).
 * @param maxAttempts Total number of attempts (including the first). Default: 3.
 * @param delayMs     Initial delay in milliseconds between attempts. Default: 1000.
 * @param backoff     Multiplier applied to `delayMs` after each failure. Default: 1 (fixed delay).
 *
 * Resolves with the first successful return value.
 * Rejects with the last error if every attempt fails.
 */
export async function retryAsync<T>(
  fn: (attempt: number) => Promise<T>,
  {
    maxAttempts = 3,
    delayMs = 1000,
    backoff = 1,
  }: { maxAttempts?: number; delayMs?: number; backoff?: number } = {},
): Promise<T> {
  let lastError: unknown;
  let currentDelay = delayMs;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts - 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, currentDelay));
        currentDelay = Math.round(currentDelay * backoff);
      }
    }
  }

  throw lastError;
}
