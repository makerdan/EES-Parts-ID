/**
 * readPdfAsBase64
 *
 * Reads a PDF from any URI supported by the platform's native `fetch`
 * implementation and returns its contents encoded as a base64 string.
 *
 * Works on:
 *  - Web  — `blob:` URIs produced by expo-document-picker
 *  - iOS / Android — `file://` URIs produced by expo-document-picker
 *
 * Throws with a user-friendly message when:
 *  - The file exceeds MAX_PDF_BYTES (25 MB)
 *  - The fetch fails for any reason
 */

export const MAX_PDF_BYTES = 25 * 1024 * 1024; // 25 MB

export class PdfTooLargeError extends Error {
  constructor() {
    super("PDF is too large (max 25 MB). Please split the catalog and try again.");
    this.name = "PdfTooLargeError";
  }
}

export async function readPdfAsBase64(uri: string): Promise<string> {
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
