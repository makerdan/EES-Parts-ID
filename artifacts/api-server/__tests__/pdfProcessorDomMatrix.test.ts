/**
 * Regression test: extractPdfPages must not throw
 * "ReferenceError: DOMMatrix is not defined" when pdfjs-dist is imported in a
 * Node.js environment that lacks browser globals.
 *
 * Uses jest.isolateModules so each case gets a fresh module registry,
 * guaranteeing the pdfjs-dist mock's DOMMatrix access runs in a cold state.
 */

import { execFile } from "child_process";

const execFileMock = execFile as jest.MockedFunction<typeof execFile>;

jest.mock("child_process", () => ({
  execFile: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
});

// ── Case 1: DOMMatrix absent at import time ───────────────────────────────────

it("extractPdfPages does not throw ReferenceError when DOMMatrix is absent from global scope", async () => {
  const originalDOMMatrix = (globalThis as Record<string, unknown>).DOMMatrix;

  try {
    delete (globalThis as Record<string, unknown>).DOMMatrix;

    await jest.isolateModulesAsync(async () => {
      jest.mock("pdfjs-dist/legacy/build/pdf.mjs", () => {
        const DOMMatrixCtor = (globalThis as Record<string, unknown>)["DOMMatrix"] as new () => unknown;
        new DOMMatrixCtor();
        return {
          GlobalWorkerOptions: { workerSrc: "" },
          getDocument: jest.fn(() => ({
            promise: Promise.resolve({
              numPages: 1,
              getPage: jest.fn(() =>
                Promise.resolve({
                  getTextContent: jest.fn(() => Promise.resolve({ items: [] })),
                  getOperatorList: jest.fn(() => Promise.resolve({ fnArray: [], argsArray: [] })),
                  getStructTree: jest.fn(() => Promise.resolve(null)),
                  objs: { get: jest.fn() },
                  cleanup: jest.fn(),
                }),
              ),
            }),
          })),
          OPS: { paintImageXObject: 82, paintInlineImageXObject: 83 },
        };
      });

      const minimalPdf = Buffer.from("%PDF-1.4\n%%EOF");
      execFileMock.mockImplementation((...args: unknown[]) => {
        const cb = args[args.length - 1] as (err: Error) => void;
        cb(new Error("pdftoppm: not found"));
        return {} as ReturnType<typeof execFile>;
      });

      const { extractPdfPages } = await import("../src/utils/pdfProcessor");
      await expect(extractPdfPages(minimalPdf)).resolves.not.toThrow();
    });
  } finally {
    if (originalDOMMatrix !== undefined) {
      (globalThis as Record<string, unknown>).DOMMatrix = originalDOMMatrix;
    }
  }
});

// ── Case 2: pdfjs fallback path runs when pdftoppm is unavailable ─────────────

it("extractPdfPages resolves when pdftoppm is unavailable and falls through to the pdfjs path", async () => {
  await jest.isolateModulesAsync(async () => {
    jest.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
      GlobalWorkerOptions: { workerSrc: "" },
      getDocument: jest.fn(() => ({
        promise: Promise.resolve({
          numPages: 2,
          getPage: jest.fn(() =>
            Promise.resolve({
              getTextContent: jest.fn(() =>
                Promise.resolve({ items: [{ str: "Widget ABC-001", transform: [1, 0, 0, 1, 72, 600] }] }),
              ),
              getOperatorList: jest.fn(() => Promise.resolve({ fnArray: [], argsArray: [] })),
              getStructTree: jest.fn(() => Promise.resolve(null)),
              objs: { get: jest.fn() },
              cleanup: jest.fn(),
            }),
          ),
        }),
      })),
      OPS: { paintImageXObject: 82, paintInlineImageXObject: 83 },
    }));

    execFileMock.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error) => void;
      cb(new Error("pdftoppm: command not found"));
      return {} as ReturnType<typeof execFile>;
    });

    const { extractPdfPages } = await import("../src/utils/pdfProcessor");
    const minimalPdf = Buffer.from("%PDF-1.4\n%%EOF");

    const pages = await extractPdfPages(minimalPdf);
    expect(Array.isArray(pages)).toBe(true);
    expect(pages.length).toBeGreaterThan(0);
    expect(pages[0]!.isRendered).toBe(false);
  });
});

// ── Case 3: sharp unavailable — text still extracted, isRendered false ────────

it("extractPdfPages returns pages with text and isRendered:false when sharp throws on import", async () => {
  await jest.isolateModulesAsync(async () => {
    jest.mock("sharp", () => {
      throw new Error("sharp: native module not available");
    });

    jest.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
      GlobalWorkerOptions: { workerSrc: "" },
      getDocument: jest.fn(() => ({
        promise: Promise.resolve({
          numPages: 2,
          getPage: jest.fn(() =>
            Promise.resolve({
              getTextContent: jest.fn(() =>
                Promise.resolve({
                  items: [
                    { str: "Part XYZ-999", transform: [1, 0, 0, 1, 72, 600] },
                  ],
                }),
              ),
              getOperatorList: jest.fn(() =>
                Promise.resolve({ fnArray: [], argsArray: [] }),
              ),
              getStructTree: jest.fn(() => Promise.resolve(null)),
              objs: { get: jest.fn() },
              cleanup: jest.fn(),
            }),
          ),
        }),
      })),
      OPS: { paintImageXObject: 82, paintInlineImageXObject: 83 },
    }));

    execFileMock.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error) => void;
      cb(new Error("pdftoppm: command not found"));
      return {} as ReturnType<typeof execFile>;
    });

    const { extractPdfPages } = await import("../src/utils/pdfProcessor");
    const minimalPdf = Buffer.from("%PDF-1.4\n%%EOF");

    const pages = await extractPdfPages(minimalPdf);

    expect(Array.isArray(pages)).toBe(true);
    expect(pages.length).toBe(2);

    for (const page of pages) {
      expect(page.isRendered).toBe(false);
      expect(page.images).toEqual([]);
      expect(typeof page.text).toBe("string");
      expect(page.text.length).toBeGreaterThan(0);
    }
  });
});
