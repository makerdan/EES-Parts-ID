jest.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: jest.fn(),
  OPS: { paintImageXObject: 85, paintInlineImageXObject: 92 },
}));
jest.mock("sharp", () => ({ default: jest.fn() }));

import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFDocument } from "pdf-lib";

import { extractPdfPages, extractRichText, MAX_CATALOG_PDF_PAGES } from "../utils/pdfProcessor";

const getDocument = pdfjs.getDocument as jest.Mock;

describe("catalog PDF extraction limits", () => {
  beforeEach(() => getDocument.mockReset());

  it("rejects a large page count before loading any page or structure tree", async () => {
    const getPage = jest.fn();
    getDocument.mockReturnValue({ promise: Promise.resolve({ numPages: MAX_CATALOG_PDF_PAGES + 1, getPage }) });
    await expect(extractPdfPages(Buffer.from("not a PDF"))).rejects.toThrow("too many pages");
    expect(getPage).not.toHaveBeenCalled();
  });

  it("checks real PDF metadata before starting full-page rendering", async () => {
    const pdf = await PDFDocument.create();
    for (let i = 0; i <= MAX_CATALOG_PDF_PAGES; i++) pdf.addPage([100, 100]);
    await expect(extractPdfPages(Buffer.from(await pdf.save()))).rejects.toThrow("too many pages");
    expect(getDocument).not.toHaveBeenCalled();
  });

  it("loads structure trees one at a time and releases the document", async () => {
    let concurrent = 0;
    let peak = 0;
    const cleanup = jest.fn();
    const destroy = jest.fn();
    const getPage = jest.fn().mockImplementation((n: number) => ({
      getTextContent: async () => ({ items: [{ str: `Page ${n}`, transform: [1, 0, 0, 1, 0, 0] }] }),
      getStructTree: async () => {
        peak = Math.max(peak, ++concurrent);
        await Promise.resolve();
        concurrent--;
        return {};
      },
      cleanup,
    }));
    getDocument.mockReturnValue({ promise: Promise.resolve({ numPages: 35, getPage, destroy }) });
    const texts = await extractRichText(Buffer.alloc(0), 35);
    expect(texts).toHaveLength(35);
    expect(getPage).toHaveBeenCalledTimes(35);
    expect(peak).toBe(1);
    expect(cleanup).toHaveBeenCalledTimes(35);
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});