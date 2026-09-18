/**
 * CJS stub for pdfjs-dist/legacy/build/pdf.mjs.
 *
 * The real file is ESM-only and uses import.meta at module scope, which the
 * Jest CJS runtime cannot parse ("Cannot use 'import.meta' outside a module").
 * jest.config.cjs maps the specifier here so the real file is never resolved.
 *
 * Tests that need controllable behaviour should jest.mock() /
 * jest.doMock("pdfjs-dist/legacy/build/pdf.mjs") with their own factory —
 * this stub only exists so an UNMOCKED import fails loudly instead of
 * crashing the whole suite with a parse error.
 */
module.exports = {
  GlobalWorkerOptions: { workerSrc: "" },
  OPS: {
    paintImageXObject: 85,
    paintInlineImageXObject: 92,
  },
  getDocument() {
    throw new Error(
      "pdfjs-dist stub: jest.mock('pdfjs-dist/legacy/build/pdf.mjs') in your test to control getDocument()",
    );
  },
};
