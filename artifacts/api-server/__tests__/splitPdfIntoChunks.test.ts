/**
 * Unit tests for splitPdfIntoChunks (client-side PDF splitting utility).
 *
 * pdf-lib is used internally, so tests require it to be available.
 * The tests create minimal valid PDFs in memory to exercise the logic.
 */

import { PDFDocument } from "pdf-lib";
import { splitPdfIntoChunks } from "../../../artifacts/parts-id/utils/splitPdfIntoChunks";

// Helper: build a synthetic N-page PDF as a Uint8Array
async function makeTestPdf(pageCount: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`Page ${i + 1}`, { x: 50, y: 700 });
  }
  const bytes = await doc.save();
  return new Uint8Array(bytes);
}

describe("splitPdfIntoChunks", () => {
  describe("no-op path (totalPages <= pagesPerChunk)", () => {
    it("returns a single chunk for a PDF with exactly pagesPerChunk pages", async () => {
      const bytes = await makeTestPdf(5);
      const chunks = await splitPdfIntoChunks(bytes, 5);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.pageOffset).toBe(0);
      expect(chunks[0]!.pageCount).toBe(5);
    });

    it("returns the original bytes unchanged on the no-op path", async () => {
      const bytes = await makeTestPdf(3);
      const chunks = await splitPdfIntoChunks(bytes, 10);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.bytes).toBe(bytes); // same reference
    });

    it("returns a single chunk for a 1-page PDF", async () => {
      const bytes = await makeTestPdf(1);
      const chunks = await splitPdfIntoChunks(bytes, 20);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.pageCount).toBe(1);
    });

    it("uses PAGES_PER_CHUNK (20) as the default when pagesPerChunk is omitted", async () => {
      const bytes = await makeTestPdf(20);
      const chunks = await splitPdfIntoChunks(bytes); // default = 20

      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.pageCount).toBe(20);
    });
  });

  describe("split path (totalPages > pagesPerChunk)", () => {
    it("splits a 45-page PDF with pagesPerChunk=20 into 3 chunks", async () => {
      const bytes = await makeTestPdf(45);
      const chunks = await splitPdfIntoChunks(bytes, 20);

      expect(chunks).toHaveLength(3);
    });

    it("returns correct pageCount values [20, 20, 5] for a 45-page PDF", async () => {
      const bytes = await makeTestPdf(45);
      const chunks = await splitPdfIntoChunks(bytes, 20);

      expect(chunks[0]!.pageCount).toBe(20);
      expect(chunks[1]!.pageCount).toBe(20);
      expect(chunks[2]!.pageCount).toBe(5);
    });

    it("returns correct pageOffset values [0, 20, 40] for a 45-page PDF", async () => {
      const bytes = await makeTestPdf(45);
      const chunks = await splitPdfIntoChunks(bytes, 20);

      expect(chunks[0]!.pageOffset).toBe(0);
      expect(chunks[1]!.pageOffset).toBe(20);
      expect(chunks[2]!.pageOffset).toBe(40);
    });

    it("each chunk byte array is a valid PDF (starts with %PDF)", async () => {
      const bytes = await makeTestPdf(45);
      const chunks = await splitPdfIntoChunks(bytes, 20);

      for (const chunk of chunks) {
        const header = Buffer.from(chunk.bytes.slice(0, 5)).toString("ascii");
        expect(header).toBe("%PDF-");
      }
    });

    it("the sum of all chunkPageCounts equals totalPages", async () => {
      const bytes = await makeTestPdf(37);
      const chunks = await splitPdfIntoChunks(bytes, 10);

      const total = chunks.reduce((sum, c) => sum + c.pageCount, 0);
      expect(total).toBe(37);
    });

    it("each chunk contains the correct number of pages (re-parsed by pdf-lib)", async () => {
      const bytes = await makeTestPdf(21);
      const chunks = await splitPdfIntoChunks(bytes, 10);

      expect(chunks).toHaveLength(3); // [10, 10, 1]
      for (const chunk of chunks) {
        const doc = await PDFDocument.load(chunk.bytes);
        expect(doc.getPageCount()).toBe(chunk.pageCount);
      }
    });

    it("handles a PDF whose page count is exactly 1 more than pagesPerChunk", async () => {
      const bytes = await makeTestPdf(6);
      const chunks = await splitPdfIntoChunks(bytes, 5);

      expect(chunks).toHaveLength(2);
      expect(chunks[0]!.pageCount).toBe(5);
      expect(chunks[1]!.pageCount).toBe(1);
      expect(chunks[1]!.pageOffset).toBe(5);
    });

    it("pageOffset of chunk N equals the sum of all previous chunks' pageCounts", async () => {
      const bytes = await makeTestPdf(50);
      const chunks = await splitPdfIntoChunks(bytes, 13);

      let expectedOffset = 0;
      for (const chunk of chunks) {
        expect(chunk.pageOffset).toBe(expectedOffset);
        expectedOffset += chunk.pageCount;
      }
    });
  });
});
