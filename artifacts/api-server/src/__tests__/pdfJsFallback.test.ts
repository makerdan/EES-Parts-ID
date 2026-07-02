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

  describe("when getTextContent throws on a single page mid-document", () => {
    /**
     * pdfJsFallback wraps per-page getTextContent in a bare catch block that
     * discards the error and leaves text as "".  This describe block pins that
     * intentional behaviour: the overall extraction must still resolve, the
     * failing page must have empty text, and the surrounding pages must retain
     * their text.
     */
    it("resolves (does not reject) even when page 2 of 3 throws from getTextContent", async () => {
      let mod!: PdfProcessorModule;

      jest.isolateModules(() => {
        jest.doMock("pdfjs-dist/legacy/build/pdf.mjs", () => {
          const makeItem = (str: string) => ({
            str,
            transform: [1, 0, 0, 1, 10, 700],
          });

          const makePage = (pageNum: number) => ({
            getStructTree: () => Promise.resolve({}),
            getTextContent: () => {
              if (pageNum === 2) {
                return Promise.reject(new Error("getTextContent failure on page 2"));
              }
              return Promise.resolve({
                items: [makeItem(`text from page ${pageNum}`)],
              });
            },
            getOperatorList: () =>
              Promise.resolve({ fnArray: [], argsArray: [] }),
            objs: { get: () => { /* unused — no image ops */ } },
            cleanup: () => { /* no-op */ },
          });

          return {
            GlobalWorkerOptions: { workerSrc: "" },
            OPS: { paintImageXObject: 85, paintInlineImageXObject: 92 },
            getDocument: () => ({
              promise: Promise.resolve({
                numPages: 3,
                getPage: (n: number) => Promise.resolve(makePage(n)),
              }),
            }),
          };
        });
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        mod = require("../utils/pdfProcessor") as PdfProcessorModule;
      });

      await expect(mod.extractPdfPages(Buffer.alloc(0))).resolves.toBeDefined();
    });

    it("returns all 3 pages with page 2 having empty text and pages 1 and 3 retaining their text", async () => {
      let mod!: PdfProcessorModule;

      jest.isolateModules(() => {
        jest.doMock("pdfjs-dist/legacy/build/pdf.mjs", () => {
          const makeItem = (str: string) => ({
            str,
            transform: [1, 0, 0, 1, 10, 700],
          });

          const makePage = (pageNum: number) => ({
            getStructTree: () => Promise.resolve({}),
            getTextContent: () => {
              if (pageNum === 2) {
                return Promise.reject(new Error("getTextContent failure on page 2"));
              }
              return Promise.resolve({
                items: [makeItem(`text from page ${pageNum}`)],
              });
            },
            getOperatorList: () =>
              Promise.resolve({ fnArray: [], argsArray: [] }),
            objs: { get: () => { /* unused — no image ops */ } },
            cleanup: () => { /* no-op */ },
          });

          return {
            GlobalWorkerOptions: { workerSrc: "" },
            OPS: { paintImageXObject: 85, paintInlineImageXObject: 92 },
            getDocument: () => ({
              promise: Promise.resolve({
                numPages: 3,
                getPage: (n: number) => Promise.resolve(makePage(n)),
              }),
            }),
          };
        });
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        mod = require("../utils/pdfProcessor") as PdfProcessorModule;
      });

      const pages = await mod.extractPdfPages(Buffer.alloc(0)) as Array<{
        pageNum: number;
        text: string;
      }>;

      expect(pages).toHaveLength(3);

      // Pages 1 and 3 succeeded — they must carry their text.
      expect(pages[0].text).toContain("text from page 1");
      expect(pages[2].text).toContain("text from page 3");

      // Page 2 failed silently — text must be an empty string, not missing or undefined.
      expect(pages[1].text).toBe("");
    });
  });
});
