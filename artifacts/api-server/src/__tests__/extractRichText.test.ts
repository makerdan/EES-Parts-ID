/**
 * Unit tests for extractRichText failure handling.
 *
 * Verifies that when pdfjs throws during import or document load,
 * extractRichText:
 *   1. Returns an array of empty strings whose length equals numPages.
 *   2. Calls logger.warn exactly once with a message containing
 *      "extractRichText failed".
 */

// ── Mock pdfjs-dist so no real PDF parsing occurs ────────────────────────────
// Jest hoists jest.mock() calls, so this runs before the module under test is
// imported.  We use a factory that throws to simulate an import-level failure.
jest.mock("pdfjs-dist/legacy/build/pdf.mjs", () => {
  throw new Error("pdfjs simulated import failure");
});

// ── Mock the logger so we can spy on warn() ───────────────────────────────────
const mockWarn = jest.fn();
jest.mock("../lib/logger", () => ({
  logger: {
    warn: mockWarn,
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { extractRichText } from "../utils/pdfProcessor";

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockWarn.mockClear();
});

describe("extractRichText — pdfjs failure path", () => {
  it("returns an array of empty strings with length equal to numPages", async () => {
    const numPages = 4;
    const result = await extractRichText(Buffer.alloc(0), numPages);

    expect(result).toHaveLength(numPages);
    expect(result.every((s) => s === "")).toBe(true);
  });

  it("calls logger.warn exactly once", async () => {
    await extractRichText(Buffer.alloc(0), 3);

    expect(mockWarn).toHaveBeenCalledTimes(1);
  });

  it("logger.warn message contains 'extractRichText failed'", async () => {
    await extractRichText(Buffer.alloc(0), 2);

    const [, message] = mockWarn.mock.calls[0] as [unknown, string];
    expect(message).toContain("extractRichText failed");
  });
});
