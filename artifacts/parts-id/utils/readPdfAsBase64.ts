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
 * Size checking:
 *  - `readPdfAsBytes` has NO size limit — large files are chunked by the upload
 *    layer (splitPdfIntoChunks). It only validates that the file is a
 *    well-formed, non-encrypted PDF.
 *  - `readPdfAsBase64` enforces the 25 MB (MAX_PDF_BYTES) size limit. Size is
 *    checked BEFORE PDF validation so that an oversized file always produces
 *    PdfTooLargeError rather than InvalidPdfError. On native, getInfoAsync's
 *    reported size is used to bail out before reading the file at all.
 *
 * Throws with a user-friendly message when:
 *  - (readPdfAsBase64 only) The file exceeds MAX_PDF_BYTES (25 MB)
 *  - The file is not a valid PDF (missing %PDF- magic bytes)
 *  - The file is password-protected (/Encrypt detected)
 *  - The read / fetch fails for any reason
 */

import "buffer";

import { Buffer } from "buffer";
import * as FileSystem from "expo-file-system/legacy";
import { Platform } from "react-native";

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

// ── Internal read helpers ─────────────────────────────────────────────────────

/**
 * Reads the raw bytes from a URI without PDF validation.
 *
 * `maxBytes` — when provided, the function throws PdfTooLargeError if the
 * file exceeds this size. On native, getInfoAsync's reported size is used for
 * an early bail-out before reading; on web, the check runs after the fetch.
 *
 * `file` — optional native `File` object (available as `asset.file` on the
 * DocumentPicker result on web). When provided on web, FileReader is used
 * instead of fetch(blob:uri), which avoids silent failures in
 * iframe/proxy environments such as the Replit canvas preview.
 */
async function readRawBytes(
  uri: string,
  maxBytes?: number,
  file?: File,
  onLog?: (msg: string, data?: unknown) => void,
): Promise<Uint8Array> {
  const log = onLog ?? (() => {});

  if (Platform.OS !== "web") {
    // ── Native path ──────────────────────────────────────────────────────────
    log("readRawBytes: native path — calling FileSystem.getInfoAsync", { uri });
    const info = await FileSystem.getInfoAsync(uri).catch(() => null);
    log("readRawBytes: FileSystem.getInfoAsync result", {
      exists: info?.exists,
      size: (info as Record<string, unknown> | null)?.size,
    });
    if (info !== null && !info.exists) {
      throw new Error("Failed to read PDF: file not found");
    }
    if (
      maxBytes !== undefined &&
      info !== null &&
      "size" in info &&
      typeof info.size === "number" &&
      info.size > maxBytes
    ) {
      throw new PdfTooLargeError();
    }

    log("readRawBytes: calling FileSystem.readAsStringAsync (Base64)");
    const rawBase64 = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const base64 = rawBase64.replace(/\s/g, "");
    const bytes = new Uint8Array(Buffer.from(base64, "base64"));
    log("readRawBytes: native read complete", { byteLength: bytes.length });
    return bytes;
  }

  // ── Web path ───────────────────────────────────────────────────────────────
  log("readRawBytes: web path", {
    uriScheme: uri.split(":")[0],
    uriPrefix: uri.substring(0, 60),
    fileArg: file === undefined ? "undefined" : file === null ? "null" : file.constructor?.name,
    isFile: file instanceof File,
    isBlob: file instanceof Blob,
  });

  // Prefer FileReader when the native File object is available (expo-document-picker
  // on web exposes it as asset.file). This avoids the silent fetch(blob:uri) failure
  // that occurs inside iframe/proxy environments like the Replit canvas preview.
  if (file instanceof File) {
    log("readRawBytes: file instanceof File=true → FileReader path", {
      fileName: file.name, fileSize: file.size, fileType: file.type,
    });
    const bytes = await new Promise<Uint8Array>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const buf = reader.result as ArrayBuffer;
        log("readRawBytes: FileReader.onload fired", { byteLength: buf.byteLength });
        resolve(new Uint8Array(buf));
      };
      reader.onerror = () => {
        log("readRawBytes: FileReader.onerror fired", { error: String(reader.error) });
        reject(new Error("Failed to read PDF: FileReader error"));
      };
      log("readRawBytes: FileReader.readAsArrayBuffer called");
      reader.readAsArrayBuffer(file);
    });

    if (maxBytes !== undefined && bytes.length > maxBytes) {
      throw new PdfTooLargeError();
    }
    log("readRawBytes: FileReader path complete", { byteLength: bytes.length });
    return bytes;
  }

  // Fallback: fetch(blob:uri) — used when asset.file is not available.
  log("readRawBytes: file not instanceof File → fetch(blob:uri) fallback", {
    fileConstructor: (file as unknown as { constructor?: { name?: string } } | undefined)?.constructor?.name,
  });
  const controller = new AbortController();
  const fetchTimeout = setTimeout(() => controller.abort(), 120_000);

  log("readRawBytes: fetch() starting");
  const response = await fetch(uri, { signal: controller.signal }).then(
    (r) => { clearTimeout(fetchTimeout); return r; },
    (err: unknown) => {
      clearTimeout(fetchTimeout);
      log("readRawBytes: fetch() threw", { errName: (err as Error)?.name, errMsg: (err as Error)?.message });
      if ((err as { name?: string }).name === "AbortError") {
        throw new Error(
          "Reading the PDF timed out — the file may be corrupted or too large for your browser. Please try again.",
        );
      }
      throw err;
    },
  );

  log("readRawBytes: fetch() resolved", { ok: response.ok, status: response.status });
  if (!response.ok) {
    throw new Error(`Failed to read PDF: HTTP ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  log("readRawBytes: fetch path complete", { byteLength: bytes.length });

  if (maxBytes !== undefined && bytes.length > maxBytes) {
    throw new PdfTooLargeError();
  }
  return bytes;
}

// ── Error message mapping ──────────────────────────────────────────────────────

/**
 * Maps a raw error thrown by readPdfAsBytes / readPdfAsBase64 (or the
 * DocumentPicker wrapper) to a human-readable string suitable for display in
 * the UI.
 *
 * Domain-specific error classes (InvalidPdfError, EncryptedPdfError,
 * PdfTooLargeError) carry their own user-friendly messages and are returned
 * verbatim. Generic OS / network errors are matched by pattern and converted
 * to friendly copy.
 */
export function toFriendlyReadError(err: unknown): string {
  if (
    err instanceof InvalidPdfError ||
    err instanceof EncryptedPdfError ||
    err instanceof PdfTooLargeError
  ) {
    return err.message;
  }
  const msg = (err as Error)?.message ?? "";
  if (/not found|no such file/i.test(msg)) {
    return "The file could not be found. Please try picking it again.";
  }
  if (/timed out|timeout|aborted/i.test(msg)) {
    return "Reading the file timed out — it may be too large or corrupted. Please try again.";
  }
  if (/permission denied|not permitted|unauthorized/i.test(msg)) {
    return "Permission was denied when reading the file. Please try again.";
  }
  if (/http\s*\d{3}/i.test(msg)) {
    return "The file could not be loaded due to a network error. Please try again.";
  }
  return "The file could not be opened. Please make sure it is a valid, unprotected PDF and try again.";
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Read a PDF from the given URI and return the raw bytes as a Uint8Array.
 *
 * No file-size limit is enforced — large files are chunked by the upload layer
 * (splitPdfIntoChunks). Validates that the file is a well-formed,
 * non-encrypted PDF.
 *
 * `file` — optional native `File` object (available as `asset.file` on the
 * DocumentPicker result on web). When provided, the web path uses FileReader
 * instead of fetch(blob:uri) to avoid silent failures in proxy environments.
 *
 * `onLog` — optional diagnostic callback; receives structured step messages
 * for the pdfPickLogger diagnostic panel.
 */
export async function readPdfAsBytes(
  uri: string,
  file?: File,
  onLog?: (msg: string, data?: unknown) => void,
): Promise<Uint8Array> {
  const bytes = await readRawBytes(uri, undefined, file, onLog);
  const prefix = bytes.length > 0
    ? Array.from(bytes.subarray(0, Math.min(8, bytes.length)))
        .map(b => (b >= 32 && b <= 126) ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, "0")}`)
        .join("")
    : "(empty)";
  onLog?.("readPdfAsBytes: calling validatePdfBytes", { byteLength: bytes.length, prefix });
  validatePdfBytes(bytes);
  onLog?.("readPdfAsBytes: validatePdfBytes passed — valid PDF");
  return bytes;
}

/**
 * Read a PDF from the given URI and return it as a base64-encoded string.
 *
 * Enforces a 25 MB size limit — throws PdfTooLargeError for larger files.
 * Size is checked BEFORE PDF validation so that an oversized file always
 * produces PdfTooLargeError rather than InvalidPdfError. On native,
 * getInfoAsync's reported size is used to bail out before reading the file.
 *
 * Use readPdfAsBytes for files that will be split into chunks before upload.
 */
export async function readPdfAsBase64(uri: string): Promise<string> {
  const bytes = await readRawBytes(uri, MAX_PDF_BYTES);

  validatePdfBytes(bytes);

  // Encode to base64
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + CHUNK) as unknown as Array<number>,
    );
  }
  return btoa(binary);
}
