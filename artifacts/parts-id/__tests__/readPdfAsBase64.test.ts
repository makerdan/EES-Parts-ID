/**
 * @jest-environment node
 *
 * Regression tests for readPdfAsBase64.
 *
 * Two platform branches are covered:
 *  - Web  (Platform.OS === "web")  → fetch → arrayBuffer → btoa
 *  - Native (Platform.OS !== "web") → expo-file-system/legacy readAsStringAsync
 *
 * The iOS bug: global fetch('file://...') is unreliable on iOS, leaving
 * pdfBase64 null and the "Start Extraction" button permanently disabled.
 * The fix uses expo-file-system/legacy on native for reliable file:// reads.
 */

import { readPdfAsBase64, PdfTooLargeError, MAX_PDF_BYTES } from "../utils/readPdfAsBase64";

// ── Platform mock ─────────────────────────────────────────────────────────────
// jest.mock is hoisted before variable initialisation, so we cannot close over
// a `const` defined in the same file. Instead we expose a mutable object via
// the mock factory and retrieve it with jest.requireMock() after the fact.
jest.mock("react-native", () => ({
  Platform: { OS: "web" },
}));

// ── expo-file-system/legacy mock ──────────────────────────────────────────────
const mockGetInfoAsync = jest.fn<Promise<{ exists: boolean; size?: number }>, [string, object?]>();
const mockReadAsStringAsync = jest.fn<Promise<string>, [string, object?]>();

jest.mock("expo-file-system/legacy", () => ({
  getInfoAsync: (...args: unknown[]) => mockGetInfoAsync(...(args as [string, object?])),
  readAsStringAsync: (...args: unknown[]) => mockReadAsStringAsync(...(args as [string, object?])),
  EncodingType: { Base64: "base64" },
}));

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

// Helper to set Platform.OS — safe because jest.requireMock returns the same
// mutable object the factory produced.
function setPlatformOS(os: string): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (jest.requireMock("react-native") as any).Platform.OS = os;
}

beforeEach(() => {
  jest.clearAllMocks();
  setPlatformOS("web");
});

// ══════════════════════════════════════════════════════════════════════════════
// WEB PATH  (Platform.OS === "web")
// ══════════════════════════════════════════════════════════════════════════════

describe("readPdfAsBase64 – web path", () => {
  beforeEach(() => { setPlatformOS("web"); });

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

    const b64 = await readPdfAsBase64("blob:http://localhost/test.pdf");
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

  it("throws PdfTooLargeError when the buffer exceeds 25 MB", async () => {
    const oversized = new ArrayBuffer(MAX_PDF_BYTES + 1);
    mockFetchWithBuffer(oversized);

    await expect(readPdfAsBase64("blob:http://localhost/big.pdf")).rejects.toBeInstanceOf(PdfTooLargeError);
  });

  it("does NOT throw for a buffer exactly at the 25 MB limit", async () => {
    const atLimit = new ArrayBuffer(MAX_PDF_BYTES);
    mockFetchWithBuffer(atLimit);

    await expect(readPdfAsBase64("blob:http://localhost/edge.pdf")).resolves.toBeDefined();
  });

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

// ══════════════════════════════════════════════════════════════════════════════
// NATIVE PATH  (Platform.OS === "ios")
// ══════════════════════════════════════════════════════════════════════════════

describe("readPdfAsBase64 – native path (iOS)", () => {
  beforeEach(() => { setPlatformOS("ios"); });

  it("returns the base64 string from FileSystem on a valid file", async () => {
    mockGetInfoAsync.mockResolvedValueOnce({ exists: true, size: 1024 });
    mockReadAsStringAsync.mockResolvedValueOnce("AAEC");

    const result = await readPdfAsBase64("file:///var/mobile/Documents/catalog.pdf");

    expect(result).toBe("AAEC");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("reads the exact URI it receives", async () => {
    const uri = "file:///var/mobile/Documents/catalog.pdf";
    mockGetInfoAsync.mockResolvedValueOnce({ exists: true, size: 512 });
    mockReadAsStringAsync.mockResolvedValueOnce("dGVzdA==");

    await readPdfAsBase64(uri);

    expect(mockGetInfoAsync).toHaveBeenCalledWith(uri);
    expect(mockReadAsStringAsync).toHaveBeenCalledWith(uri, { encoding: "base64" });
  });

  it("throws PdfTooLargeError when file size exceeds 25 MB", async () => {
    mockGetInfoAsync.mockResolvedValueOnce({ exists: true, size: MAX_PDF_BYTES + 1 });

    await expect(readPdfAsBase64("file:///var/mobile/large.pdf")).rejects.toBeInstanceOf(PdfTooLargeError);
    expect(mockReadAsStringAsync).not.toHaveBeenCalled();
  });

  it("includes the 25 MB message in PdfTooLargeError", async () => {
    mockGetInfoAsync.mockResolvedValueOnce({ exists: true, size: MAX_PDF_BYTES + 1 });

    await expect(readPdfAsBase64("file:///var/mobile/large.pdf")).rejects.toThrow(
      "PDF is too large (max 25 MB)",
    );
  });

  it("does NOT throw for a file exactly at the 25 MB limit", async () => {
    mockGetInfoAsync.mockResolvedValueOnce({ exists: true, size: MAX_PDF_BYTES });
    mockReadAsStringAsync.mockResolvedValueOnce("dGVzdA==");

    await expect(readPdfAsBase64("file:///var/mobile/edge.pdf")).resolves.toBeDefined();
  });

  it("throws when the file does not exist", async () => {
    mockGetInfoAsync.mockResolvedValueOnce({ exists: false });

    await expect(readPdfAsBase64("file:///var/mobile/missing.pdf")).rejects.toThrow(
      "file not found",
    );
  });

  it("propagates errors from readAsStringAsync", async () => {
    mockGetInfoAsync.mockResolvedValueOnce({ exists: true, size: 512 });
    mockReadAsStringAsync.mockRejectedValueOnce(new Error("Permission denied"));

    await expect(readPdfAsBase64("file:///var/mobile/Documents/catalog.pdf")).rejects.toThrow(
      "Permission denied",
    );
  });

  it("also works when Platform.OS is 'android'", async () => {
    setPlatformOS("android");
    mockGetInfoAsync.mockResolvedValueOnce({ exists: true, size: 1024 });
    mockReadAsStringAsync.mockResolvedValueOnce("dGVzdA==");

    const result = await readPdfAsBase64("file:///storage/emulated/0/catalog.pdf");

    expect(result).toBe("dGVzdA==");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
