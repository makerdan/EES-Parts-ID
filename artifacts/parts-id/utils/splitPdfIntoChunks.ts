/**
 * splitPdfIntoChunks
 *
 * Splits a PDF (as Uint8Array) into page-range chunks using pdf-lib.
 * The `buffer` polyfill must be imported before this module is used so that
 * pdf-lib works correctly on the Hermes JS runtime (React Native / iOS / Android).
 *
 * Returns an array of { bytes, pageOffset, pageCount }.
 * If the PDF has no more pages than `pagesPerChunk` it returns a single-element
 * array containing the original bytes unchanged (no-op path).
 */
import "buffer";

export const PAGES_PER_CHUNK = 20;

export interface PdfChunk {
  bytes: Uint8Array;
  pageOffset: number;
  pageCount: number;
}

/**
 * Split `bytes` into chunks of at most `pagesPerChunk` pages.
 *
 * @param bytes        Full PDF as a Uint8Array.
 * @param pagesPerChunk  Maximum pages per chunk (default 20).
 * @returns            Array of chunks. Single-element for PDFs that fit in one chunk.
 */
export async function splitPdfIntoChunks(
  bytes: Uint8Array,
  pagesPerChunk: number = PAGES_PER_CHUNK,
): Promise<PdfChunk[]> {
  const { PDFDocument } = await import("pdf-lib");
  const srcDoc = await PDFDocument.load(bytes);
  const totalPages = srcDoc.getPageCount();

  if (totalPages <= pagesPerChunk) {
    return [{ bytes, pageOffset: 0, pageCount: totalPages }];
  }

  const chunks: PdfChunk[] = [];
  let pageOffset = 0;

  while (pageOffset < totalPages) {
    const chunkPageCount = Math.min(pagesPerChunk, totalPages - pageOffset);
    const pageIndices = Array.from({ length: chunkPageCount }, (_, i) => pageOffset + i);

    const chunkDoc = await PDFDocument.create();
    const copiedPages = await chunkDoc.copyPages(srcDoc, pageIndices);
    for (const page of copiedPages) {
      chunkDoc.addPage(page);
    }

    const chunkBytes = await chunkDoc.save();
    chunks.push({ bytes: new Uint8Array(chunkBytes), pageOffset, pageCount: chunkPageCount });
    pageOffset += chunkPageCount;
  }

  return chunks;
}
