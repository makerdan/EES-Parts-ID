/**
 * End-to-end pipeline tests for the catalog PDF extraction flow.
 *
 * Exercises the full chain: PDF buffer → extractPdfPages (pdfProcessor.ts)
 * → extractCatalogPage (catalogExtractor.ts) → CatalogEntry[]
 *
 * Low-level dependencies are mocked so no binary tools (pdftoppm) or live
 * API calls are required:
 *   - child_process.execFile  → simulates pdftoppm being unavailable
 *   - pdfjs-dist              → returns known page text / operator lists
 *   - @workspace/integrations-openai-ai-server → returns fixture responses
 */

// ── child_process mock: pdftoppm unavailable ──────────────────────────────────
// Must be set up before pdfProcessor.ts is imported so that promisify(execFile)
// wraps the mocked version.
jest.mock("child_process", () => ({
  execFile: jest.fn((...args: unknown[]) => {
    // Last argument is always the Node.js-style callback (err, stdout, stderr)
    const cb = args[args.length - 1] as (err: Error) => void;
    cb(new Error("pdftoppm: command not found"));
  }),
}));

// ── pdfjs-dist mock: returns a controllable one-page document ─────────────────
const mockGetTextContent = jest.fn();
const mockGetOperatorList = jest.fn();
const mockPageCleanup = jest.fn();
const mockGetPage = jest.fn();
const mockGetDocument = jest.fn();

jest.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: mockGetDocument,
  OPS: {
    paintImageXObject: 85,
    paintInlineImageXObject: 92,
  },
}));

// ── AI provider mock ──────────────────────────────────────────────────────────
// catalogExtractor.ts calls getAiClient() from aiProvider – mock that module
// directly so the factory never references a hoisted variable (safe pattern).
const mockCreate = jest.fn();

jest.mock("../src/lib/aiProvider", () => ({
  getAiClient: () => ({
    chat: {
      completions: {
        create: mockCreate,
      },
    },
  }),
  getCatalogModel: () => "gpt-4o",
}));

// ── Imports (after all mocks are in place) ────────────────────────────────────
import { extractPdfPages } from "../src/utils/pdfProcessor";
import { extractCatalogPage } from "../src/utils/catalogExtractor";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeOpenAIResponse(content: string) {
  return { choices: [{ message: { content } }] };
}

/** Builds a fake pdfjs page object with the given text items. */
function makeFakePage(textItems: Array<{ str: string }>, imageOps = false) {
  mockGetTextContent.mockResolvedValueOnce({ items: textItems });
  mockGetOperatorList.mockResolvedValueOnce({
    fnArray: imageOps ? [85] : [],
    argsArray: imageOps ? [["img0"]] : [],
  });
  return {
    getTextContent: mockGetTextContent,
    getOperatorList: mockGetOperatorList,
    objs: { get: jest.fn() },
    cleanup: mockPageCleanup,
  };
}

/** Sets up the pdfjs-dist mock to return a document with `pages` pages. */
function setupPdfjsDoc(pages: Array<{ str: string }[]>) {
  for (const pageTextItems of pages) {
    mockGetPage.mockResolvedValueOnce(makeFakePage(pageTextItems));
  }
  mockGetDocument.mockReturnValueOnce({
    promise: Promise.resolve({
      numPages: pages.length,
      getPage: mockGetPage,
    }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.resetAllMocks();
  // Restore the child_process mock implementation after resetAllMocks
  const { execFile } = jest.requireMock<{ execFile: jest.Mock }>("child_process");
  execFile.mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: Error) => void;
    cb(new Error("pdftoppm: command not found"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractPdfPages – pdfjs-dist fallback path
// ─────────────────────────────────────────────────────────────────────────────

describe("extractPdfPages (pdfjs-dist fallback)", () => {
  it("returns one PageData entry per page in the PDF", async () => {
    setupPdfjsDoc([
      [{ str: "Part A" }, { str: " " }, { str: "description A" }],
      [{ str: "Part B" }, { str: " " }, { str: "description B" }],
    ]);

    const pages = await extractPdfPages(Buffer.alloc(16));

    expect(pages).toHaveLength(2);
    expect(pages[0].pageNum).toBe(1);
    expect(pages[1].pageNum).toBe(2);
  });

  it("joins text items into a single string for each page", async () => {
    setupPdfjsDoc([
      [{ str: "BR120" }, { str: " " }, { str: "20A Breaker" }],
    ]);

    const pages = await extractPdfPages(Buffer.alloc(16));

    expect(pages[0].text).toContain("BR120");
    expect(pages[0].text).toContain("20A Breaker");
  });

  it("sets isRendered to false on the fallback path", async () => {
    setupPdfjsDoc([[{ str: "text" }]]);

    const pages = await extractPdfPages(Buffer.alloc(16));

    expect(pages[0].isRendered).toBe(false);
  });

  it("sets pageWidth and pageHeight to 0 on the fallback path", async () => {
    setupPdfjsDoc([[{ str: "text" }]]);

    const pages = await extractPdfPages(Buffer.alloc(16));

    expect(pages[0].pageWidth).toBe(0);
    expect(pages[0].pageHeight).toBe(0);
  });

  it("returns an empty images array when the page has no embedded images", async () => {
    setupPdfjsDoc([[{ str: "text only page" }]]);

    const pages = await extractPdfPages(Buffer.alloc(16));

    expect(pages[0].images).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Full pipeline: PDF buffer → page data → catalog entries
// ─────────────────────────────────────────────────────────────────────────────

describe("full pipeline: PDF → extractPdfPages → extractCatalogPage", () => {
  it("extracts catalog entries from a single-page PDF with known text content", async () => {
    // Fixture: a single-page Eaton BR-series catalog page
    setupPdfjsDoc([
      [
        { str: "EATON BR SERIES" },
        { str: " " },
        { str: "BR120" },
        { str: " " },
        { str: "Single-Pole 20A 120/240V Breaker" },
        { str: " " },
        { str: "BR220" },
        { str: " " },
        { str: "Two-Pole 20A 240V Breaker" },
      ],
    ]);

    const gptEntries = [
      { catalogNumber: "BR120", description: "Single-Pole 20A 120/240V Breaker", confidence: 0.97, hasPartImage: false, imageRegion: null },
      { catalogNumber: "BR220", description: "Two-Pole 20A 240V Breaker", confidence: 0.95, hasPartImage: false, imageRegion: null },
    ];
    mockCreate.mockResolvedValueOnce(makeOpenAIResponse(JSON.stringify(gptEntries)));

    const pages = await extractPdfPages(Buffer.alloc(64));
    expect(pages).toHaveLength(1);

    const entries = await extractCatalogPage(pages[0].text, pages[0].images, "Eaton");

    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.catalogNumber)).toContain("BR120");
    expect(entries.map((e) => e.catalogNumber)).toContain("BR220");

    // Verify the text extracted from the PDF was forwarded to the AI
    const callArg = mockCreate.mock.calls[0][0];
    const userContent = callArg.messages[1].content as Array<{ type: string; text?: string }>;
    const textEntry = userContent.find((c) => c.type === "text");
    expect(textEntry?.text).toContain("BR120");
  });

  it("returns an empty catalog when a page has no extractable text and no images", async () => {
    // Simulates a page where pdfjs-dist finds no text (e.g. text rendered as paths)
    setupPdfjsDoc([[{ str: "" }]]);

    const pages = await extractPdfPages(Buffer.alloc(64));
    const entries = await extractCatalogPage(pages[0].text, pages[0].images, "Eaton");

    // Both text and images are empty – no AI call should be made
    expect(entries).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("correctly passes page number metadata through the full pipeline", async () => {
    setupPdfjsDoc([
      [{ str: "cover page" }],
      [{ str: "BR120 20A Breaker" }],
    ]);

    mockCreate.mockResolvedValueOnce(makeOpenAIResponse("[]"));
    mockCreate.mockResolvedValueOnce(makeOpenAIResponse(
      JSON.stringify([{ catalogNumber: "BR120", description: "20A Breaker", confidence: 0.9, hasPartImage: false, imageRegion: null }]),
    ));

    const pages = await extractPdfPages(Buffer.alloc(64));
    expect(pages[0].pageNum).toBe(1);
    expect(pages[1].pageNum).toBe(2);

    // Process each page independently (as the catalog job would)
    const page1Entries = await extractCatalogPage(pages[0].text, pages[0].images, "Eaton");
    const page2Entries = await extractCatalogPage(pages[1].text, pages[1].images, "Eaton");

    expect(page1Entries).toEqual([]);
    expect(page2Entries).toHaveLength(1);
    expect(page2Entries[0].catalogNumber).toBe("BR120");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scanned / image-only PDF page handling
// ─────────────────────────────────────────────────────────────────────────────

describe("full pipeline: scanned page (text empty, page image provided)", () => {
  it("calls the AI with the rendered page image when text extraction yields nothing", async () => {
    // pdfjs-dist returns a page with no text items
    setupPdfjsDoc([[{ str: "" }]]);

    const pages = await extractPdfPages(Buffer.alloc(64));

    // Simulate a scenario where the caller supplies a rendered page image
    // (as the pdftoppm path would) even though pdfjs found no text
    const fakeRenderedImage = Buffer.alloc(32, 0xcc);
    mockCreate.mockResolvedValueOnce(makeOpenAIResponse(
      JSON.stringify([{ catalogNumber: "HBL5262I", description: "20A Receptacle", confidence: 0.88, hasPartImage: true, imageRegion: { x: 0.05, y: 0.1, width: 0.4, height: 0.3 } }]),
    ));

    const entries = await extractCatalogPage(pages[0].text, [fakeRenderedImage], "Hubbell");

    expect(entries).toHaveLength(1);
    expect(entries[0].catalogNumber).toBe("HBL5262I");
    expect(entries[0].hasPartImage).toBe(true);
    expect(entries[0].imageRegion).not.toBeNull();

    // Verify the image was sent to the AI as a base64 data URI
    const callArg = mockCreate.mock.calls[0][0];
    const userContent = callArg.messages[1].content as Array<{ type: string; image_url?: { url: string } }>;
    const imageEntry = userContent.find((c) => c.type === "image_url");
    expect(imageEntry).toBeDefined();
    expect(imageEntry!.image_url!.url).toMatch(/^data:image\/png;base64,/);
  });

  it("processes a multi-page PDF where some pages are text and some are image-only", async () => {
    setupPdfjsDoc([
      [{ str: "BR120 Single Pole 20A Breaker" }],  // page 1: text page
      [{ str: "" }],                                // page 2: scanned/image-only
    ]);

    const pages = await extractPdfPages(Buffer.alloc(64));

    expect(pages[0].text).toContain("BR120");
    expect(pages[1].text.trim()).toBe("");
  });
});
