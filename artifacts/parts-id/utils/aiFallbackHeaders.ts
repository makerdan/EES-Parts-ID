/**
 * Helpers for the `x-use-openai-fallback: true` request header.
 *
 * Extracted from CatalogPdfUpload.tsx (sendSingleChunk / handleRetryServerChunk)
 * and catalog-review.tsx (handleResume) so the logic can be unit-tested without
 * mounting the full components.
 */

/**
 * Returns true when the job's error message indicates the Poe chain is
 * exhausted and the OpenAI fallback should be activated for the next attempt.
 */
export function shouldUseFallback(
  errorMessage: string | null | undefined,
): boolean {
  return errorMessage === "poe_chain_exhausted";
}

/**
 * Sets `x-use-openai-fallback: true` on the supplied XHR when `withFallback`
 * is true. Mirrors the conditional in `sendSingleChunk`.
 *
 * Accepts any object that exposes `setRequestHeader` so it is straightforward
 * to mock in tests.
 */
export function applyFallbackHeader(
  xhr: { setRequestHeader: (name: string, value: string) => void },
  withFallback: boolean,
): void {
  if (withFallback) {
    xhr.setRequestHeader("x-use-openai-fallback", "true");
  }
}

/**
 * Builds the full header map for the resume-job fetch call, inserting the
 * fallback header when the job's error message is `poe_chain_exhausted`.
 * Mirrors the header spread in `handleResume`.
 */
export function buildResumeHeaders(
  authHeaders: Record<string, string>,
  jobErrorMessage: string | null | undefined,
): Record<string, string> {
  return {
    ...authHeaders,
    "Content-Type": "application/json",
    ...(shouldUseFallback(jobErrorMessage) ? { "x-use-openai-fallback": "true" } : {}),
  };
}
