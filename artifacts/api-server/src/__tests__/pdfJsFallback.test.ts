/**
 * Unit tests for pdfJsFallback failure propagation (via extractPdfPages).
 *
 * pdfJsFallback has no try/catch guard around the pdfjs dynamic import or
 * the getDocument() call.  If either throws the error must propagate to the
 * caller — extractPdfPages must reject rather than silently resolve to an
 * empty array.
 *
 * Each scenario is loaded inside jest.isolateModules() + jest.doMock() so the
 * two pdfjs stubs do not bleed into each other or into other test files.
 */

// Sharp is dynamically imported inside pdfJsFallback; stub it to avoid
// native-addon side-effects during the test run.
jest.mock("sharp", () => ({ default: jest.fn() }));

// The logger is used by extractRichText which is called from
// tryPdftoppmRendering on the success path (never reached here because
// pdftoppm is unavailable in CI).  Stub it to prevent "cannot find module"
// errors in case the isolated module graph walks that path.
jest.mock("../lib/logger", () => ({
  logger: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

type PdfProcessorModule = {
  extractPdfPages: (buf: Buffer) => Promise<unknown[]>;
};

describe("pdfJsFallback — error propagation via extractPdfPages", () => {
  afterEach(() => {
    jest.resetModules();
  });

  describe("when pdfjs-dist throws at import time", () => {
    it("rejects with the pdfjs error instead of resolving to an empty array", async () => {
      let mod!: PdfProcessorModule;

      jest.isolateModules(() => {
        jest.doMock("pdfjs-dist/legacy/build/pdf.mjs", () => {
          throw new Error("pdfjs simulated import failure");
        });
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        mod = require("../utils/pdfProcessor") as PdfProcessorModule;
      });

      await expect(mod.extractPdfPages(Buffer.alloc(0))).rejects.toThrow(
        "pdfjs simulated import failure",
      );
    });

    it("does not resolve to an empty array on import failure", async () => {
      let mod!: PdfProcessorModule;

      jest.isolateModules(() => {
        jest.doMock("pdfjs-dist/legacy/build/pdf.mjs", () => {
          throw new Error("pdfjs simulated import failure");
        });
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        mod = require("../utils/pdfProcessor") as PdfProcessorModule;
      });

      // The promise must reject — if it resolves at all the assertion fails.
      let resolved = false;
      await mod.extractPdfPages(Buffer.alloc(0)).then(() => {
        resolved = true;
      }).catch(() => { /* expected */ });

      expect(resolved).toBe(false);
    });
  });

  describe("when pdfjs-dist getDocument().promise rejects", () => {
    it("rejects with the getDocument error instead of resolving to an empty array", async () => {
      let mod!: PdfProcessorModule;

      jest.isolateModules(() => {
        jest.doMock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
          GlobalWorkerOptions: { workerSrc: "" },
          getDocument: () => ({
            promise: Promise.reject(new Error("pdfjs getDocument failure")),
          }),
        }));
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        mod = require("../utils/pdfProcessor") as PdfProcessorModule;
      });

      await expect(mod.extractPdfPages(Buffer.alloc(0))).rejects.toThrow(
        "pdfjs getDocument failure",
      );
    });

    it("does not resolve to an empty array on getDocument failure", async () => {
      let mod!: PdfProcessorModule;

      jest.isolateModules(() => {
        jest.doMock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
          GlobalWorkerOptions: { workerSrc: "" },
          getDocument: () => ({
            promise: Promise.reject(new Error("pdfjs getDocument failure")),
          }),
        }));
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        mod = require("../utils/pdfProcessor") as PdfProcessorModule;
      });

      let resolved = false;
      await mod.extractPdfPages(Buffer.alloc(0)).then(() => {
        resolved = true;
      }).catch(() => { /* expected */ });

      expect(resolved).toBe(false);
    });
  });
});
