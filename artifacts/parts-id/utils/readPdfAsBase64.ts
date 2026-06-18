/**
 * readPdfAsBase64 / readPdfAsBytes
 *
 * Reads a PDF from a URI and returns its contents, either as a raw Uint8Array
 * (readPdfAsBytes) or a base64-encoded string (readPdfAsBase64).
 *
 * Platform strategy:
 *  - Native (iOS / Android) — uses expo-file-system/legacy `readAsStringAsync`
 *    with Base64 encoding. This is the only reliable path for `file://` URIs
 *    on iOS; global `fetch('file://...')` is not guaranteed to work.
 *  - Web — uses `fetch → arrayBuffer`, which handles `blob:` URIs produced by
 *    expo-document-picker on web.
 *
 * `readPdfAsBytes` does NOT enforce a maximum file size — large files are
 * chunked by the upload layer (splitPdfIntoChunks). It does validate that the
 * file is a well-formed, non-encrypted PDF.
 *
 * `readPdfAsBase64` wraps `readPdfAsBytes` and additionally enforces the
 * legacy 25 MB single-upload size limit. It exists for backward compatibility
 * with code paths that have not yet been updated to the chunked upload flow.
 *
 * Throws with a user-friendly message when:
 *  - The file is not a valid PDF (missing %PDF- magic bytes)
 *  - The file is password-protected (/Encrypt detected)
 *  - The read / fetch fails for any reason
 *  - (readPdfAsBase64 only) The file exceeds MAX_PDF_BYTES (25 MB)
 */

import "buffer";
import { Buffer } from "buffer";
import { Platform } from "react-native";
import * as FileSystem from "expo-file-system/legacy";

export const MAX_PDF_BYTES = 25 * 1024 * 1024; // 25 MB (legacy single-upload guard)

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

// ── Validation ────────────────────────────────────────────────────────────────

function bytesToAscii(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return s;
}

/**
 * Validates a raw PDF byte array directly.
 * Checks for the %PDF- magic bytes and the /Encrypt dictionary marker.
 */
function validatePdfBytes(bytes: Uint8Array): void {
  const CHECK_BYTES = 2048;

  const prefixStr = bytesToAscii(bytes.subarray(0, Math.min(CHECK_BYTES, bytes.length)));

  if (!prefixStr.includes("%PDF-")) {
    throw new InvalidPdfError();
  }
  if (prefixStr.includes("/Encrypt")) {
    throw new EncryptedPdfError();
  }

  const suffixStart = Math.max(0, bytes.length - CHECK_BYTES);
  if (bytesToAscii(bytes.subarray(suffixStart)).includes("/Encrypt")) {
    throw new EncryptedPdfError();
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Read a PDF from the given URI and return the raw bytes as a Uint8Array.
 *
 * No file-size limit is enforced — the caller is responsible for deciding
 * whether to split the result into chunks before uploading.
 */
export async function readPdfAsBytes(uri: string): Promise<Uint8Array> {
  if (Platform.OS !== "web") {
    // ── Native path ──────────────────────────────────────────────────────────
    const info = await FileSystem.getInfoAsync(uri).catch(() => null);
    if (info !== null && !info.exists) {
      throw new Error("Failed to read PDF: file not found");
    }

    const rawBase64 = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const base64 = rawBase64.replace(/\s/g, "");
    const bytes = new Uint8Array(Buffer.from(base64, "base64"));

    validatePdfBytes(bytes);
    return bytes;
  }

  // ── Web path ───────────────────────────────────────────────────────────────
  const controller = new AbortController();
  const fetchTimeout = setTimeout(() => controller.abort(), 120_000);

  const response = await fetch(uri, { signal: controller.signal }).then(
    (r) => { clearTimeout(fetchTimeout); return r; },
    (err: unknown) => {
      clearTimeout(fetchTimeout);
      if ((err as { name?: string }).name === "AbortError") {
        throw new Error(
          "Reading the PDF timed out — the file may be corrupted or too large for your browser. Please try again.",
        );
      }
      throw err;
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to read PDF: HTTP ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  validatePdfBytes(bytes);
  return bytes;
}

/**
 * Read a PDF from the given URI and return it as a base64-encoded string.
 *
 * Enforces a 25 MB size limit — throws PdfTooLargeError for larger files.
 * Use readPdfAsBytes for files that will be split into chunks before upload.
 */
export async function readPdfAsBase64(uri: string): Promise<string> {
  const bytes = await readPdfAsBytes(uri);

  if (bytes.length > MAX_PDF_BYTES) {
    throw new PdfTooLargeError();
  }

  // Encode to base64
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + CHUNK) as unknown as number[],
    );
  }
  return btoa(binary);
}
