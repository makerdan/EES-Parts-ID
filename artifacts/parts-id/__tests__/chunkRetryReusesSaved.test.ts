/**
 * @jest-environment node
 *
 * Regression tests for the "reuse saved chunks on retry" branch in
 * handleRetryChunk (CatalogPdfUpload).
 *
 * The actual branching logic is extracted into getOrSplitChunks so it can be
 * tested directly without rendering the full component (which has complex
 * navigation and native-module dependencies).
 *
 * getOrSplitChunks accepts an optional `splitFn` parameter (default:
 * splitPdfIntoChunks) so a jest spy can be injected without fighting
 * same-module binding issues.
 *
 * Covered cases:
 *  1. When cached chunks are provided (chunksRef.current is populated),
 *     splitFn must NOT be called and the cached array is returned as-is.
 *  2. When no cached chunks exist (chunksRef.current is null), the fallback
 *     invokes splitFn and returns its result.
 *  3. An empty array is treated as a valid cache (non-null), so splitFn is
 *     still skipped.
 *  4. Errors thrown by splitFn in the fallback path propagate as-is.
 */

import { getOrSplitChunks, PAGES_PER_CHUNK } from "../utils/splitPdfIntoChunks";
import type { PdfChunk } from "../utils/splitPdfIntoChunks";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeChunks(count: number): PdfChunk[] {
  return Array.from({ length: count }, (_, i) => ({
    bytes: new Uint8Array([i]),
    pageOffset: i * 20,
    pageCount: 20,
  }));
}

const DUMMY_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF

// ══════════════════════════════════════════════════════════════════════════════
// Case 1 — cached chunks present → splitFn is never called
// ══════════════════════════════════════════════════════════════════════════════

describe("getOrSplitChunks – cached chunks present (simulates chunksRef.current populated)", () => {
  it("returns the cached array without calling splitFn", async () => {
    const splitSpy = jest.fn<Promise<PdfChunk[]>, [Uint8Array, number]>();
    const cached = makeChunks(3);

    const result = await getOrSplitChunks(cached, DUMMY_BYTES, PAGES_PER_CHUNK, splitSpy);

    expect(result).toBe(cached);
    expect(splitSpy).not.toHaveBeenCalled();
  });

  it("returns the exact same reference, not a copy", async () => {
    const splitSpy = jest.fn<Promise<PdfChunk[]>, [Uint8Array, number]>();
    const cached = makeChunks(5);

    const result = await getOrSplitChunks(cached, DUMMY_BYTES, PAGES_PER_CHUNK, splitSpy);

    expect(result).toBe(cached);
    expect(splitSpy).not.toHaveBeenCalled();
  });

  it("does not call splitFn even when a mid-sequence retry (chunkIndex > 0) is simulated", async () => {
    // Mirrors the scenario: upload failed at chunkIndex 2, chunksRef.current
    // was saved from the initial split — retry should reuse those chunks.
    const splitSpy = jest.fn<Promise<PdfChunk[]>, [Uint8Array, number]>();
    const cached = makeChunks(4);

    await getOrSplitChunks(cached, DUMMY_BYTES, PAGES_PER_CHUNK, splitSpy);

    expect(splitSpy).not.toHaveBeenCalled();
  });

  it("treats an empty cached array as a valid cache (skips re-split)", async () => {
    const splitSpy = jest.fn<Promise<PdfChunk[]>, [Uint8Array, number]>();
    const cached: PdfChunk[] = [];

    const result = await getOrSplitChunks(cached, DUMMY_BYTES, PAGES_PER_CHUNK, splitSpy);

    expect(result).toBe(cached);
    expect(splitSpy).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Case 2 — no cached chunks (null) → fallback re-split path is used
// ══════════════════════════════════════════════════════════════════════════════

describe("getOrSplitChunks – no cached chunks (simulates chunksRef.current === null)", () => {
  it("calls splitFn with the provided bytes and pagesPerChunk", async () => {
    const freshChunks = makeChunks(2);
    const splitSpy = jest.fn<Promise<PdfChunk[]>, [Uint8Array, number]>()
      .mockResolvedValueOnce(freshChunks);

    const result = await getOrSplitChunks(null, DUMMY_BYTES, PAGES_PER_CHUNK, splitSpy);

    expect(splitSpy).toHaveBeenCalledTimes(1);
    expect(splitSpy).toHaveBeenCalledWith(DUMMY_BYTES, PAGES_PER_CHUNK);
    expect(result).toBe(freshChunks);
  });

  it("returns exactly what splitFn resolves with", async () => {
    const freshChunks = makeChunks(7);
    const splitSpy = jest.fn<Promise<PdfChunk[]>, [Uint8Array, number]>()
      .mockResolvedValueOnce(freshChunks);

    const result = await getOrSplitChunks(null, DUMMY_BYTES, PAGES_PER_CHUNK, splitSpy);

    expect(result).toStrictEqual(freshChunks);
    expect(result).toBe(freshChunks);
  });

  it("propagates errors thrown by splitFn", async () => {
    const splitSpy = jest.fn<Promise<PdfChunk[]>, [Uint8Array, number]>()
      .mockRejectedValueOnce(new Error("pdf-lib parse failure"));

    await expect(
      getOrSplitChunks(null, DUMMY_BYTES, PAGES_PER_CHUNK, splitSpy),
    ).rejects.toThrow("pdf-lib parse failure");
  });

  it("uses PAGES_PER_CHUNK as the forwarded page-count when called without explicit pagesPerChunk", async () => {
    const freshChunks = makeChunks(1);
    const splitSpy = jest.fn<Promise<PdfChunk[]>, [Uint8Array, number]>()
      .mockResolvedValueOnce(freshChunks);

    await getOrSplitChunks(null, DUMMY_BYTES, undefined, splitSpy);

    expect(splitSpy).toHaveBeenCalledWith(DUMMY_BYTES, PAGES_PER_CHUNK);
  });
});
