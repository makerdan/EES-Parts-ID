/**
 * readPdfAsBase64
 *
 * Reads a PDF from a URI and returns its contents encoded as a base64 string.
 *
 * Platform strategy:
 *  - Native (iOS / Android) — uses expo-file-system/legacy `readAsStringAsync`
 *    with Base64 encoding. This is the only reliable path for `file://` URIs
 *    on iOS; global `fetch('file://...')` is not guaranteed to work.
 *  - Web — uses `fetch → arrayBuffer → btoa`, which handles `blob:` URIs
 *    produced by expo-document-picker on web.
 *
 * Throws with a user-friendly message when:
 *  - The file exceeds MAX_PDF_BYTES (25 MB)
 *  - The file is not a valid PDF (missing %PDF- magic bytes)
 *  - The file is password-protected (/Encrypt detected)
 *  - The read / fetch fails for any reason
 */

import { Platform } from "react-native";
import * as FileSystem from "expo-file-system/legacy";

export const MAX_PDF_BYTES = 25 * 1024 * 1024; // 25 MB

export class PdfTooLargeError extends Error {
  constructor() {
    super("PDF is too large (max 25 MB). Please split the catalog and try again.");
    this.name = "PdfTooLargeError";
  }
}

export class InvalidPdfError extends Error {
  constructor() {
    super("The selected file is not a valid PDF. Please choose a PDF file and try again.");
    this.name = "InvalidPdfError";
  }
}

export class EncryptedPdfError extends Error {
  constructor() {
    super("Password-protected PDFs are not supported. Please remove the password protection and try again.");
    this.name = "EncryptedPdfError";
  }
}

// ── Base64 decode helpers ─────────────────────────────────────────────────────

const B64_TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Decodes the first `maxBytes` bytes from a base64 string without using atob.
 * Safe for both native and web environments.
 */
function decodeBase64Prefix(base64: string, maxBytes: number): Uint8Array {
  const charsNeeded = Math.ceil((maxBytes * 4) / 3) + 4;
  const slice = base64.slice(0, Math.min(charsNeeded, base64.length));
  const result: number[] = [];
  for (let i = 0; i + 3 < slice.length && result.length < maxBytes; i += 4) {
    const c0 = B64_TABLE.indexOf(slice[i]!);
    const c1 = B64_TABLE.indexOf(slice[i + 1]!);
    const c2 = B64_TABLE.indexOf(slice[i + 2]!);
    const c3 = B64_TABLE.indexOf(slice[i + 3]!);
    if (c0 < 0 || c1 < 0) break;
    result.push((c0 << 2) | (c1 >> 4));
    if (c2 >= 0 && result.length < maxBytes) result.push(((c1 & 0xf) << 4) | (c2 >> 2));
    if (c3 >= 0 && result.length < maxBytes) result.push(((c2 & 0x3) << 6) | c3);
  }
  return new Uint8Array(result);
}

/**
 * Decodes the last `maxBytes` bytes from a base64 string without using atob.
 * Aligns to the nearest 4-char (3-byte) boundary before slicing.
 */
function decodeBase64Suffix(base64: string, maxBytes: number): Uint8Array {
  const charsNeeded = Math.ceil((maxBytes * 4) / 3) + 4;
  const startChar = Math.max(0, base64.length - charsNeeded);
  const alignedStart = startChar - (startChar % 4);
  const slice = base64.slice(alignedStart);
  const result: number[] = [];
  for (let i = 0; i + 3 < slice.length; i += 4) {
    const c0 = B64_TABLE.indexOf(slice[i]!);
    const c1 = B64_TABLE.indexOf(slice[i + 1]!);
    const c2 = B64_TABLE.indexOf(slice[i + 2]!);
    const c3 = B64_TABLE.indexOf(slice[i + 3]!);
    if (c0 < 0 || c1 < 0) break;
    result.push((c0 << 2) | (c1 >> 4));
    if (c2 >= 0) result.push(((c1 & 0xf) << 4) | (c2 >> 2));
    if (c3 >= 0) result.push(((c2 & 0x3) << 6) | c3);
  }
  return new Uint8Array(result);
}

function bytesToAscii(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return s;
}

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Validates a base64-encoded PDF by checking for the %PDF- magic bytes and
 * sniffing for the /Encrypt dictionary marker that signals password protection.
 *
 * We search the first 2 KB for %PDF- (not just byte 0 — some generators prepend
 * a BOM or comment like `%iFilter-5.0\n` before the signature) and the last 2 KB
 * for /Encrypt (traditional trailer-based PDFs store the dictionary there).
 */
function validatePdfBase64(base64: string): void {
  const CHECK_BYTES = 2048;

  const prefix = decodeBase64Prefix(base64, CHECK_BYTES);
  const prefixStr = bytesToAscii(prefix);

  // %PDF- must appear within the first 2 KB. Strict byte-0 check is too
  // aggressive: real catalogs sometimes have a comment or BOM before the header.
  if (!prefixStr.includes("%PDF-")) {
    throw new InvalidPdfError();
  }

  // Check for /Encrypt in the prefix area (cross-reference stream PDFs, PDF 1.5+)
  if (prefixStr.includes("/Encrypt")) {
    throw new EncryptedPdfError();
  }

  // Check for /Encrypt in the suffix area (traditional trailer-based PDFs)
  const suffix = decodeBase64Suffix(base64, CHECK_BYTES);
  if (bytesToAscii(suffix).includes("/Encrypt")) {
    throw new EncryptedPdfError();
  }
}

/**
 * Validates a raw PDF byte array directly (faster than the base64 path).
 */
function validatePdfBytes(bytes: Uint8Array): void {
  const CHECK_BYTES = 2048;

  const prefixStr = bytesToAscii(bytes.subarray(0, Math.min(CHECK_BYTES, bytes.length)));

  // %PDF- must appear within the first 2 KB (handles pre-header comments/BOMs).
  if (!prefixStr.includes("%PDF-")) {
    throw new InvalidPdfError();
  }

  // Check prefix for /Encrypt (cross-reference stream PDFs)
  if (prefixStr.includes("/Encrypt")) {
    throw new EncryptedPdfError();
  }

  // Check suffix for /Encrypt (traditional trailer-based PDFs)
  const suffixStart = Math.max(0, bytes.length - CHECK_BYTES);
  const suffixStr = bytesToAscii(bytes.subarray(suffixStart));
  if (suffixStr.includes("/Encrypt")) {
    throw new EncryptedPdfError();
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function readPdfAsBase64(uri: string): Promise<string> {
  if (Platform.OS !== "web") {
    // ── Native path ──────────────────────────────────────────────────────────
    // Use expo-file-system/legacy for reliable file:// URI reading on iOS/Android.
    //
    // getInfoAsync is used for a pre-flight size check so we don't load huge
    // files into memory. On iOS, certain URI schemes (e.g. from iCloud or
    // the Files app) can cause getInfoAsync to fail even when the file is
    // perfectly readable, so failures are caught and ignored — we fall through
    // to readAsStringAsync which will surface a clearer error if the file is
    // genuinely unavailable.
    const info = await FileSystem.getInfoAsync(uri).catch(() => null);
    if (info !== null && !info.exists) {
      throw new Error("Failed to read PDF: file not found");
    }
    const fileSize = info ? (info as { size?: number }).size : undefined;
    if (fileSize !== undefined && fileSize > MAX_PDF_BYTES) {
      throw new PdfTooLargeError();
    }

    const rawBase64 = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    // Strip any whitespace — expo-file-system may emit MIME-style line-wrapped
    // base64 on some iOS versions. A clean string is also required for upload.
    const base64 = rawBase64.replace(/\s/g, "");

    // Post-read size guard covers cases where getInfoAsync had no size info.
    if (base64.length > Math.ceil(MAX_PDF_BYTES * (4 / 3))) {
      throw new PdfTooLargeError();
    }

    validatePdfBase64(base64);
    return base64;
  }

  // ── Web path ───────────────────────────────────────────────────────────────
  const response = await fetch(uri);
  if (!response.ok) {
    throw new Error(`Failed to read PDF: HTTP ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_PDF_BYTES) {
    throw new PdfTooLargeError();
  }
  const bytes = new Uint8Array(buffer);

  // Validate on raw bytes before encoding (avoids redundant decode on web)
  validatePdfBytes(bytes);

  const CHUNK = 0x8000; // 32 KB — safe below V8 call-stack argument limit
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(binary);
}
