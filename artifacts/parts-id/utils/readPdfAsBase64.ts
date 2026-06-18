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

export async function readPdfAsBase64(uri: string): Promise<string> {
  if (Platform.OS !== "web") {
    // ── Native path ──────────────────────────────────────────────────────────
    // Use expo-file-system/legacy for reliable file:// URI reading on iOS/Android.
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) {
      throw new Error("Failed to read PDF: file not found");
    }
    // `size` is present on the exists:true variant of FileInfo
    const fileSize = (info as { size?: number }).size;
    if (fileSize !== undefined && fileSize > MAX_PDF_BYTES) {
      throw new PdfTooLargeError();
    }
    const base64 = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
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
  const CHUNK = 0x8000; // 32 KB — safe below V8 call-stack argument limit
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(binary);
}
