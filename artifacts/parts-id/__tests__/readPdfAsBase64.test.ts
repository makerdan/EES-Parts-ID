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

import {
  readPdfAsBase64,
  PdfTooLargeError,
  InvalidPdfError,
  EncryptedPdfError,
  MAX_PDF_BYTES,
} from "../utils/readPdfAsBase64";

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

function mockFetchWithBuffer(buffer: ArrayBufferLike, status = 200): void {
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

// ── PDF fixture helpers ───────────────────────────────────────────────────────

/** Minimal valid PDF header bytes: %PDF-1.4 */
const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34]);

/** Base64 of "%PDF-1.4" — "JVBERi0xLjQ=" */
const PDF_MAGIC_B64 = "JVBERi0xLjQ=";

/** Builds a Uint8Array starting with %PDF-1.4 followed by extra bytes. */
function makePdfBytes(extraBytes: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(PDF_MAGIC.length + extraBytes.length);
  out.set(PDF_MAGIC, 0);
  out.set(extraBytes, PDF_MAGIC.length);
  return out;
}

/** Builds a Uint8Array that starts with %PDF-1.4 and contains /Encrypt in the prefix window. */
function makeEncryptedPdfBytes(): Uint8Array {
  const encrypt = new TextEncoder().encode("/Encrypt");
  return makePdfBytes(encrypt);
}

/**
 * Builds a large byte array (> 4 KB) where %PDF-1.4 is at the start and
 * /Encrypt appears only in the last 2 KB (suffix detection path).
 */
function makeSuffixEncryptedPdfBytes(): Uint8Array {
  const totalSize = 5000;
  const out = new Uint8Array(totalSize);
  out.set(PDF_MAGIC, 0);
  const encrypt = new TextEncoder().encode("/Encrypt");
  out.set(encrypt, totalSize - encrypt.length);
  return out;
}

/** Encodes a Uint8Array to base64 using the same chunk strategy as the module. */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(binary);
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
    const bytes = makePdfBytes();
    mockFetchWithBuffer(bytes.buffer);

    const result = await readPdfAsBase64("blob:http://localhost/test-pdf");

    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("round-trips: decoding the result restores the original bytes", async () => {
    const original = makePdfBytes(new Uint8Array([10, 20, 30, 100, 200, 255]));
    mockFetchWithBuffer(original.buffer);

    const b64 = await readPdfAsBase64("blob:http://localhost/test.pdf");
    const decoded = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

    expect(Array.from(decoded)).toEqual(Array.from(original));
  });

  it("fetches the exact URI it receives", async () => {
    const uri = "blob:http://localhost/abc-123";
    mockFetchWithBuffer(makePdfBytes().buffer);

    await readPdfAsBase64(uri);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    // Second arg is the AbortSignal options object — check only the URI.
    expect(mockFetch).toHaveBeenCalledWith(uri, expect.objectContaining({ signal: expect.anything() }));
  });

  it("throws PdfTooLargeError when the buffer exceeds 25 MB", async () => {
    const oversized = new ArrayBuffer(MAX_PDF_BYTES + 1);
    mockFetchWithBuffer(oversized);

    await expect(readPdfAsBase64("blob:http://localhost/big.pdf")).rejects.toBeInstanceOf(PdfTooLargeError);
  });

  it("does NOT throw for a buffer exactly at the 25 MB limit", async () => {
    const atLimit = new Uint8Array(MAX_PDF_BYTES);
    atLimit.set(PDF_MAGIC, 0);
    mockFetchWithBuffer(atLimit.buffer);

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

  it("throws a user-friendly message when the fetch is aborted (timeout)", async () => {
    const abortError = Object.assign(new Error("The user aborted a request."), {
      name: "AbortError",
    });
    mockFetch.mockRejectedValueOnce(abortError);

    await expect(readPdfAsBase64("blob:http://localhost/large.pdf")).rejects.toThrow(
      "timed out",
    );
  });

  it("throws InvalidPdfError when the file does not start with %PDF-", async () => {
    const nonPdf = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
    mockFetchWithBuffer(nonPdf.buffer);

    await expect(readPdfAsBase64("blob:http://localhost/fake.pdf")).rejects.toBeInstanceOf(InvalidPdfError);
  });

  it("includes a user-friendly message in InvalidPdfError", async () => {
    const nonPdf = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]); // JPEG magic bytes
    mockFetchWithBuffer(nonPdf.buffer);

    await expect(readPdfAsBase64("blob:http://localhost/photo.pdf")).rejects.toThrow(
      "not a valid PDF",
    );
  });

  it("throws EncryptedPdfError when /Encrypt appears in the header", async () => {
    const encrypted = makeEncryptedPdfBytes();
    mockFetchWithBuffer(encrypted.buffer);

    await expect(readPdfAsBase64("blob:http://localhost/secure.pdf")).rejects.toBeInstanceOf(EncryptedPdfError);
  });

  it("includes a user-friendly message in EncryptedPdfError", async () => {
    const encrypted = makeEncryptedPdfBytes();
    mockFetchWithBuffer(encrypted.buffer);

    await expect(readPdfAsBase64("blob:http://localhost/secure.pdf")).rejects.toThrow(
      "Password-protected",
    );
  });

  it("throws EncryptedPdfError when /Encrypt appears in the trailer (suffix detection)", async () => {
    const encrypted = makeSuffixEncryptedPdfBytes();
    mockFetchWithBuffer(encrypted.buffer);

    await expect(readPdfAsBase64("blob:http://localhost/oldformat.pdf")).rejects.toBeInstanceOf(EncryptedPdfError);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// NATIVE PATH  (Platform.OS === "ios")
// ══════════════════════════════════════════════════════════════════════════════

describe("readPdfAsBase64 – native path (iOS)", () => {
  beforeEach(() => { setPlatformOS("ios"); });

  it("returns the base64 string from FileSystem on a valid file", async () => {
    mockGetInfoAsync.mockResolvedValueOnce({ exists: true, size: 1024 });
    mockReadAsStringAsync.mockResolvedValueOnce(PDF_MAGIC_B64);

    const result = await readPdfAsBase64("file:///var/mobile/Documents/catalog.pdf");

    expect(result).toBe(PDF_MAGIC_B64);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("reads the exact URI it receives", async () => {
    const uri = "file:///var/mobile/Documents/catalog.pdf";
    mockGetInfoAsync.mockResolvedValueOnce({ exists: true, size: 512 });
    mockReadAsStringAsync.mockResolvedValueOnce(PDF_MAGIC_B64);

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
    mockReadAsStringAsync.mockResolvedValueOnce(PDF_MAGIC_B64);

    await expect(readPdfAsBase64("file:///var/mobile/edge.pdf")).resolves.toBeDefined();
  });

  it("throws when the file does not exist", async () => {
    mockGetInfoAsync.mockResolvedValueOnce({ exists: false });

    await expect(readPdfAsBase64("file:///var/mobile/missing.pdf")).rejects.toThrow(
      "file not found",
    );
  });

  it("proceeds when getInfoAsync itself throws (non-fatal — reads anyway)", async () => {
    // On iOS, certain URI schemes cause getInfoAsync to throw even though
    // the file is perfectly readable (e.g. iCloud Documents URIs).
    mockGetInfoAsync.mockRejectedValueOnce(new Error("getInfoAsync internal error"));
    mockReadAsStringAsync.mockResolvedValueOnce(PDF_MAGIC_B64);

    // Should NOT reject — getInfoAsync failure is swallowed and read succeeds.
    await expect(readPdfAsBase64("file:///var/mobile/Documents/catalog.pdf")).resolves.toBe(PDF_MAGIC_B64);
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
    mockReadAsStringAsync.mockResolvedValueOnce(PDF_MAGIC_B64);

    const result = await readPdfAsBase64("file:///storage/emulated/0/catalog.pdf");

    expect(result).toBe(PDF_MAGIC_B64);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("throws InvalidPdfError when the file is not a PDF", async () => {
    mockGetInfoAsync.mockResolvedValueOnce({ exists: true, size: 512 });
    // "AAEC" decodes to [0x00, 0x01, 0x02] — no %PDF- magic
    mockReadAsStringAsync.mockResolvedValueOnce("AAEC");

    await expect(readPdfAsBase64("file:///var/mobile/fake.pdf")).rejects.toBeInstanceOf(InvalidPdfError);
  });

  it("includes a user-friendly message in InvalidPdfError on native", async () => {
    mockGetInfoAsync.mockResolvedValueOnce({ exists: true, size: 512 });
    mockReadAsStringAsync.mockResolvedValueOnce("AAEC");

    await expect(readPdfAsBase64("file:///var/mobile/fake.pdf")).rejects.toThrow(
      "not a valid PDF",
    );
  });

  it("accepts a PDF whose header has a pre-header comment before %PDF-", async () => {
    // Some generators (e.g. iFilter, certain print drivers) emit a comment line
    // like `%iFilter-5.0\n` before the canonical `%PDF-x.y` signature.
    // The previous strict byte-0 check would incorrectly reject these files.
    const comment = new TextEncoder().encode("%iFilter-5.0\n");
    const pdfBytes = makePdfBytes();
    const combined = new Uint8Array(comment.length + pdfBytes.length);
    combined.set(comment, 0);
    combined.set(pdfBytes, comment.length);

    mockGetInfoAsync.mockResolvedValueOnce({ exists: true, size: combined.length });
    mockReadAsStringAsync.mockResolvedValueOnce(toBase64(combined));

    await expect(readPdfAsBase64("file:///var/mobile/vendor-catalog.pdf")).resolves.toBeDefined();
  });

  it("strips MIME-style newlines from base64 before validation and return", async () => {
    // Simulate expo-file-system emitting 76-char-wrapped MIME base64 (if it ever does).
    const rawB64 = PDF_MAGIC_B64;
    // Artificially inject newlines as if MIME-wrapped
    const wrapped = rawB64.slice(0, 4) + "\n" + rawB64.slice(4);

    mockGetInfoAsync.mockResolvedValueOnce({ exists: true, size: 8 });
    mockReadAsStringAsync.mockResolvedValueOnce(wrapped);

    const result = await readPdfAsBase64("file:///var/mobile/Documents/catalog.pdf");
    // Returned string must have no whitespace
    expect(result).not.toMatch(/\s/);
    expect(result).toBe(PDF_MAGIC_B64);
  });

  it("throws EncryptedPdfError when /Encrypt is present in the file", async () => {
    mockGetInfoAsync.mockResolvedValueOnce({ exists: true, size: 64 });
    const encrypted = makeEncryptedPdfBytes();
    mockReadAsStringAsync.mockResolvedValueOnce(toBase64(encrypted));

    await expect(readPdfAsBase64("file:///var/mobile/secure.pdf")).rejects.toBeInstanceOf(EncryptedPdfError);
  });

  it("includes a user-friendly message in EncryptedPdfError on native", async () => {
    mockGetInfoAsync.mockResolvedValueOnce({ exists: true, size: 64 });
    const encrypted = makeEncryptedPdfBytes();
    mockReadAsStringAsync.mockResolvedValueOnce(toBase64(encrypted));

    await expect(readPdfAsBase64("file:///var/mobile/secure.pdf")).rejects.toThrow(
      "Password-protected",
    );
  });
});
