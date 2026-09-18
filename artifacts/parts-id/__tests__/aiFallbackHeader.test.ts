/**
 * @jest-environment node
 *
 * Unit tests that verify the `x-use-openai-fallback: true` header reaches the
 * server in the two paths that set it when a job previously failed with
 * `poe_chain_exhausted`:
 *
 *   1. handleRetryServerChunk + sendSingleChunk (CatalogPdfUpload.tsx)
 *      shouldUseFallback() decides whether withFallbackRef is set to true;
 *      applyFallbackHeader() then writes the header to the XHR.
 *      Both functions are imported directly from production code.
 *
 *   2. handleResume (catalog-review.tsx)
 *      buildResumeHeaders() merges auth headers + Content-Type + the optional
 *      fallback header into the fetch options.
 *      The function is imported directly from production code.
 *
 * All three helpers live in utils/aiFallbackHeaders.ts and are called by the
 * real component code.  These tests exercise that production module, so a
 * regression in the helper (wrong condition, missing header, altered key)
 * will cause these tests to fail.
 */

import {
  applyFallbackHeader,
  buildResumeHeaders,
  shouldUseFallback,
} from "../utils/aiFallbackHeaders";

// ─────────────────────────────────────────────────────────────────────────────
// shouldUseFallback — the shared predicate used by handleRetryServerChunk
// ─────────────────────────────────────────────────────────────────────────────

describe("shouldUseFallback", () => {
  it("returns true when errorMessage is 'poe_chain_exhausted'", () => {
    expect(shouldUseFallback("poe_chain_exhausted")).toBe(true);
  });

  it("returns false for a different error string", () => {
    expect(shouldUseFallback("timeout")).toBe(false);
  });

  it("returns false for null", () => {
    expect(shouldUseFallback(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(shouldUseFallback(undefined)).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(shouldUseFallback("")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// applyFallbackHeader — called by sendSingleChunk in CatalogPdfUpload.tsx
//
// sendSingleChunk calls:
//   applyFallbackHeader(xhr, withFallbackRef.current);
// after opening the XHR and setting Content-Type / Authorization.
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal XHR stand-in that records setRequestHeader calls. */
function makeXhrSpy(): {
  setRequestHeader: jest.Mock;
  getHeader: (name: string) => string | undefined;
} {
  const headers: Record<string, string> = {};
  const setRequestHeader = jest.fn((name: string, value: string) => {
    headers[name.toLowerCase()] = value;
  });
  return {
    setRequestHeader,
    getHeader: (name: string) => headers[name.toLowerCase()],
  };
}

describe("applyFallbackHeader — sets header on XHR passed to sendSingleChunk", () => {
  it("sets x-use-openai-fallback: true when withFallback is true", () => {
    const xhr = makeXhrSpy();
    applyFallbackHeader(xhr, true);
    expect(xhr.getHeader("x-use-openai-fallback")).toBe("true");
  });

  it("does not call setRequestHeader when withFallback is false", () => {
    const xhr = makeXhrSpy();
    applyFallbackHeader(xhr, false);
    expect(xhr.setRequestHeader).not.toHaveBeenCalled();
  });

  it("does not set x-use-openai-fallback when withFallback is false", () => {
    const xhr = makeXhrSpy();
    applyFallbackHeader(xhr, false);
    expect(xhr.getHeader("x-use-openai-fallback")).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end: shouldUseFallback → applyFallbackHeader
//
// Models the two-step sequence in the real component:
//   handleRetryServerChunk sets withFallbackRef.current = true via
//     shouldUseFallback(jobStatus?.errorMessage)
//   sendSingleChunk applies the header via applyFallbackHeader(xhr, withFallbackRef.current)
// ─────────────────────────────────────────────────────────────────────────────

describe("shouldUseFallback + applyFallbackHeader — full chunk-retry path", () => {
  it("applies the header to the XHR when jobStatus.errorMessage is 'poe_chain_exhausted'", () => {
    // Step 1: handleRetryServerChunk decides whether to set the ref
    const withFallback = shouldUseFallback("poe_chain_exhausted");
    // Step 2: sendSingleChunk applies the header
    const xhr = makeXhrSpy();
    applyFallbackHeader(xhr, withFallback);
    expect(xhr.getHeader("x-use-openai-fallback")).toBe("true");
  });

  it("does NOT apply the header when jobStatus.errorMessage is a different error", () => {
    const withFallback = shouldUseFallback("page_parse_error");
    const xhr = makeXhrSpy();
    applyFallbackHeader(xhr, withFallback);
    expect(xhr.getHeader("x-use-openai-fallback")).toBeUndefined();
  });

  it("does NOT apply the header when jobStatus.errorMessage is null", () => {
    const withFallback = shouldUseFallback(null);
    const xhr = makeXhrSpy();
    applyFallbackHeader(xhr, withFallback);
    expect(xhr.getHeader("x-use-openai-fallback")).toBeUndefined();
  });

  it("applies the header when withFallbackRef was already true from a prior retry", () => {
    // Once set to true, all subsequent retries carry the header even if the
    // latest jobStatus no longer shows poe_chain_exhausted.
    const priorWithFallback = true; // ref already set by a previous retry
    const latestError = null;       // latest poll shows no error yet
    const withFallback = priorWithFallback || shouldUseFallback(latestError);
    const xhr = makeXhrSpy();
    applyFallbackHeader(xhr, withFallback);
    expect(xhr.getHeader("x-use-openai-fallback")).toBe("true");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildResumeHeaders — called by handleResume in catalog-review.tsx
//
// handleResume calls:
//   headers: buildResumeHeaders(authHeaders, job?.errorMessage)
// ─────────────────────────────────────────────────────────────────────────────

const AUTH_HEADERS = { Authorization: "Bearer test-token" };

describe("buildResumeHeaders — header map for handleResume fetch call", () => {
  it("includes x-use-openai-fallback: true when errorMessage is 'poe_chain_exhausted'", () => {
    const headers = buildResumeHeaders(AUTH_HEADERS, "poe_chain_exhausted");
    expect(headers["x-use-openai-fallback"]).toBe("true");
  });

  it("omits x-use-openai-fallback when errorMessage is a generic error string", () => {
    const headers = buildResumeHeaders(AUTH_HEADERS, "timeout");
    expect(headers["x-use-openai-fallback"]).toBeUndefined();
  });

  it("omits x-use-openai-fallback when errorMessage is null", () => {
    const headers = buildResumeHeaders(AUTH_HEADERS, null);
    expect(headers["x-use-openai-fallback"]).toBeUndefined();
  });

  it("omits x-use-openai-fallback when errorMessage is undefined (job not found)", () => {
    const headers = buildResumeHeaders(AUTH_HEADERS, undefined);
    expect(headers["x-use-openai-fallback"]).toBeUndefined();
  });

  it("omits x-use-openai-fallback for an empty error string", () => {
    const headers = buildResumeHeaders(AUTH_HEADERS, "");
    expect(headers["x-use-openai-fallback"]).toBeUndefined();
  });

  it("always includes Authorization from authHeaders", () => {
    const h1 = buildResumeHeaders(AUTH_HEADERS, "poe_chain_exhausted");
    expect(h1["Authorization"]).toBe("Bearer test-token");

    const h2 = buildResumeHeaders(AUTH_HEADERS, "some_other_error");
    expect(h2["Authorization"]).toBe("Bearer test-token");
  });

  it("always includes Content-Type: application/json", () => {
    const h1 = buildResumeHeaders(AUTH_HEADERS, "poe_chain_exhausted");
    expect(h1["Content-Type"]).toBe("application/json");

    const h2 = buildResumeHeaders(AUTH_HEADERS, null);
    expect(h2["Content-Type"]).toBe("application/json");
  });

  it("passes all authHeaders fields through to the result", () => {
    const extraAuth = { Authorization: "Bearer tok", "X-Tenant-Id": "acme" };
    const headers = buildResumeHeaders(extraAuth, "poe_chain_exhausted");
    expect(headers["Authorization"]).toBe("Bearer tok");
    expect(headers["X-Tenant-Id"]).toBe("acme");
  });
});
