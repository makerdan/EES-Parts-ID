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

export async function countPdfChunks(bytes: Uint8Array, pagesPerChunk = PAGES_PER_CHUNK): Promise<number> {
  if (!Number.isSafeInteger(pagesPerChunk) || pagesPerChunk < 1) throw new RangeError("Invalid PDF chunk size");
  const { PDFDocument } = await import("pdf-lib");
  return Math.ceil((await PDFDocument.load(bytes)).getPageCount() / pagesPerChunk);
}

/** Generate only the requested page range; callers retain the source for retries. */
export async function createPdfChunk(
  bytes: Uint8Array,
  index: number,
  pagesPerChunk: number = PAGES_PER_CHUNK,
): Promise<{ chunk: PdfChunk; totalChunks: number }> {
  const { PDFDocument } = await import("pdf-lib");
  const srcDoc = await PDFDocument.load(bytes);
  const totalPages = srcDoc.getPageCount();
  const totalChunks = Math.ceil(totalPages / pagesPerChunk);
  if (!Number.isSafeInteger(index) || index < 0 || index >= totalChunks || pagesPerChunk < 1) {
    throw new RangeError("PDF chunk index out of range");
  }
  const pageOffset = index * pagesPerChunk;
  const pageCount = Math.min(pagesPerChunk, totalPages - pageOffset);
  if (totalChunks === 1) return { chunk: { bytes, pageOffset, pageCount }, totalChunks };
  const chunkDoc = await PDFDocument.create();
  for (const page of await chunkDoc.copyPages(
    srcDoc, Array.from({ length: pageCount }, (_, i) => pageOffset + i),
  )) chunkDoc.addPage(page);
  return { chunk: { bytes: await chunkDoc.save(), pageOffset, pageCount }, totalChunks };
}

/** Only the current chunk is resident, even for PDFs with thousands of pages. */
export async function* iteratePdfChunks(
  bytes: Uint8Array,
  pagesPerChunk: number = PAGES_PER_CHUNK,
  startIndex = 0,
): AsyncGenerator<{ chunk: PdfChunk; index: number; totalChunks: number }> {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.load(bytes);
  const totalPages = doc.getPageCount();
  const totalChunks = Math.ceil(totalPages / pagesPerChunk);
  if (pagesPerChunk < 1 || !Number.isSafeInteger(startIndex) || startIndex < 0 || startIndex >= totalChunks) {
    throw new RangeError("PDF chunk index out of range");
  }
  for (let index = startIndex; index < totalChunks; index++) {
    const pageOffset = index * pagesPerChunk;
    const pageCount = Math.min(pagesPerChunk, totalPages - pageOffset);
    if (totalChunks === 1) {
      yield { index, totalChunks, chunk: { bytes, pageOffset, pageCount } };
    } else {
      const chunkDoc = await PDFDocument.create();
      for (const page of await chunkDoc.copyPages(
        doc, Array.from({ length: pageCount }, (_, i) => pageOffset + i),
      )) chunkDoc.addPage(page);
      yield { index, totalChunks, chunk: { bytes: await chunkDoc.save(), pageOffset, pageCount } };
    }
  }
}

/**
 * Return the cached chunks when available, otherwise split the PDF from scratch.
 *
 * This is the branching logic used by `handleRetryChunk` in CatalogPdfUpload so
 * that the decision can be unit-tested without rendering the full component.
 *
 * `splitFn` defaults to `splitPdfIntoChunks` and exists solely to allow unit
 * tests to inject a spy without fighting same-module binding issues.
 *
 * @param cached       Previously-split chunks stored in chunksRef.current, or null.
 * @param bytes        Raw PDF bytes — only consumed when `cached` is null.
 * @param pagesPerChunk  Forwarded to splitFn when a fresh split is needed.
 * @param splitFn      Overridable split implementation (default: splitPdfIntoChunks).
 */
export async function getOrSplitChunks(
  cached: Array<PdfChunk> | null,
  bytes: Uint8Array,
  pagesPerChunk: number = PAGES_PER_CHUNK,
  splitFn: (b: Uint8Array, n: number) => Promise<Array<PdfChunk>> = splitPdfIntoChunks,
): Promise<Array<PdfChunk>> {
  if (cached !== null) {
    return cached;
  }
  return splitFn(bytes, pagesPerChunk);
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
): Promise<Array<PdfChunk>> {
  const { PDFDocument } = await import("pdf-lib");
  const srcDoc = await PDFDocument.load(bytes);
  const totalPages = srcDoc.getPageCount();

  if (totalPages <= pagesPerChunk) {
    return [{ bytes, pageOffset: 0, pageCount: totalPages }];
  }

  const chunks: Array<PdfChunk> = [];
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
