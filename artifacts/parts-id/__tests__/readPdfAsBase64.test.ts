/**
 * @jest-environment node
 *
 * Regression tests for readPdfAsBase64.
 *
 * The bug: CatalogPdfUpload used expo-file-system/legacy readAsStringAsync
 * which fails on web (blob: URIs unsupported) and some iOS URIs, leaving
 * pdfBase64 null and the "Start Extraction" button permanently disabled.
 *
 * The fix: replace with fetch(uri) → arrayBuffer() → JS base64 encode,
 * which works universally for both blob: (web) and file:// (native) URIs.
 */

import { readPdfAsBase64, PdfTooLargeError, MAX_PDF_BYTES } from "../utils/readPdfAsBase64";

// ── fetch mock ────────────────────────────────────────────────────────────────
const mockFetch = jest.fn<Promise<Response>, [RequestInfo, RequestInit?]>();
global.fetch = mockFetch as unknown as typeof fetch;

function mockFetchWithBuffer(buffer: ArrayBuffer, status = 200): void {
  mockFetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: () => Promise.resolve(buffer),
  } as unknown as Response);
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ── happy path ────────────────────────────────────────────────────────────────

describe("readPdfAsBase64 – happy path", () => {
  it("returns a non-empty base64 string for a small valid PDF", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
    mockFetchWithBuffer(bytes.buffer);

    const result = await readPdfAsBase64("blob:http://localhost/test-pdf");

    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("round-trips: decoding the result restores the original bytes", async () => {
    const original = new Uint8Array([1, 2, 3, 4, 5, 100, 200, 255]);
    mockFetchWithBuffer(original.buffer);

    const b64 = await readPdfAsBase64("file:///tmp/test.pdf");
    const decoded = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

    expect(Array.from(decoded)).toEqual(Array.from(original));
  });

  it("fetches the exact URI it receives", async () => {
    const uri = "blob:http://localhost/abc-123";
    mockFetchWithBuffer(new Uint8Array([0]).buffer);

    await readPdfAsBase64(uri);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(uri);
  });
});

// ── size guard ────────────────────────────────────────────────────────────────

describe("readPdfAsBase64 – size guard", () => {
  it("throws PdfTooLargeError when the buffer exceeds 25 MB", async () => {
    const oversized = new ArrayBuffer(MAX_PDF_BYTES + 1);
    mockFetchWithBuffer(oversized);

    await expect(readPdfAsBase64("blob:http://localhost/big.pdf")).rejects.toBeInstanceOf(
      PdfTooLargeError,
    );
  });

  it("includes the 25 MB message in the PdfTooLargeError", async () => {
    const oversized = new ArrayBuffer(MAX_PDF_BYTES + 1);
    mockFetchWithBuffer(oversized);

    await expect(readPdfAsBase64("blob:http://localhost/big.pdf")).rejects.toThrow(
      "PDF is too large (max 25 MB)",
    );
  });

  it("does NOT throw for a buffer exactly at the 25 MB limit", async () => {
    const atLimit = new ArrayBuffer(MAX_PDF_BYTES);
    mockFetchWithBuffer(atLimit);

    await expect(readPdfAsBase64("blob:http://localhost/edge.pdf")).resolves.toBeDefined();
  });
});

// ── fetch failure ─────────────────────────────────────────────────────────────

describe("readPdfAsBase64 – fetch failure", () => {
  it("propagates a network error thrown by fetch", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network request failed"));

    await expect(readPdfAsBase64("blob:http://localhost/fail.pdf")).rejects.toThrow(
      "Network request failed",
    );
  });

  it("throws when fetch returns a non-OK HTTP status", async () => {
    mockFetchWithBuffer(new ArrayBuffer(0), 403);

    await expect(readPdfAsBase64("blob:http://localhost/forbidden.pdf")).rejects.toThrow(
      "HTTP 403",
    );
  });
});
