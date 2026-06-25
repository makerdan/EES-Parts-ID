/**
 * Targeted tests for chunked-upload edge cases in the PDF resume flow.
 *
 * Covers:
 *   POST /api/admin/catalog-pdf/:jobId/resume — chunkPageOffset correctly
 *     computes startPageWithinChunk and processedPagesBase passed to
 *     processPdfPages, including the clamping-to-zero case.
 *   GET  /api/admin/catalog-pdf/reviews — returns 400 for non-numeric ?jobId=
 *   POST /api/admin/catalog-pdf/:jobId/cancel — cancels all pending/processing
 *     child chunk jobs when the parent is cancelled.
 *   POST /api/admin/catalog-pdf/reviews/:id/revert — clears both imageUrl
 *     AND imageUrl2 (not just imageUrl).
 */

// ── Module mocks ──────────────────────────────────────────────────────────────

jest.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: { chat: { completions: { create: jest.fn() } }, audio: { transcriptions: { create: jest.fn() } } },
  generateImageBuffer: jest.fn(),
  editImages: jest.fn(),
  batchProcess: jest.fn(),
  batchProcessWithSSE: jest.fn(),
  isRateLimitError: jest.fn(() => false),
}));

jest.mock("@workspace/integrations-openai-ai-server/batch", () => ({
  batchProcess: jest.fn(),
  batchProcessWithSSE: jest.fn(),
  isRateLimitError: jest.fn(() => false),
}));

jest.mock("../src/utils/pdfProcessor", () => ({
  extractPdfPages: jest.fn(),
  validatePdf: jest.fn(),
}));

jest.mock("../src/utils/catalogExtractor", () => ({
  extractCatalogPage: jest.fn(),
}));

jest.mock("../src/utils/catalogMatcher", () => ({
  matchCatalogNumber: jest.fn(),
}));

jest.mock("../src/lib/objectStorage", () => ({
  uploadCatalogImage: jest.fn(),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import supertest from "supertest";
import app from "../src/app";
import { signAdminToken } from "../src/routes/admin";
import { closePool } from "./helpers/testDb";
import { db, catalogPdfJobTable, inventoryTable } from "@workspace/db";
import { eq, inArray, and } from "drizzle-orm";
import { extractPdfPages } from "../src/utils/pdfProcessor";
import { extractCatalogPage } from "../src/utils/catalogExtractor";

// ── Typed mocks ───────────────────────────────────────────────────────────────

const mockExtractPdfPages = extractPdfPages as jest.MockedFunction<typeof extractPdfPages>;
const mockExtractCatalogPage = extractCatalogPage as jest.MockedFunction<typeof extractCatalogPage>;

// ── Shared constants ──────────────────────────────────────────────────────────

const ADMIN_SECRET = "jest-chunked-edge-cases-secret";
const VENDOR = "JEST-CHUNKED-EDGE-VENDOR";
const STUB_PDF_B64 = Buffer.from("%PDF-1.4\n%%EOF").toString("base64");

// ── State ─────────────────────────────────────────────────────────────────────

let adminToken: string;
const seededJobIds: number[] = [];
const seededInventoryIds: number[] = [];

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFakePages(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    pageNum: i,
    text: `chunk-page-${i}`,
    images: [] as Buffer[],
    isRendered: false,
    pageWidth: 0,
    pageHeight: 0,
  }));
}

async function seedJob(
  overrides: Partial<typeof catalogPdfJobTable.$inferInsert>,
): Promise<number> {
  const [row] = await db
    .insert(catalogPdfJobTable)
    .values({
      vendor: VENDOR,
      filename: "jest-chunked-edge.pdf",
      status: "pending",
      processedPages: 0,
      matchedParts: 0,
      ...overrides,
    })
    .returning({ id: catalogPdfJobTable.id });
  if (!row) throw new Error("Failed to seed job");
  seededJobIds.push(row.id);
  return row.id;
}

async function readJobRow(jobId: number) {
  const [row] = await db
    .select({
      status: catalogPdfJobTable.status,
      processedPages: catalogPdfJobTable.processedPages,
      finishedAt: catalogPdfJobTable.finishedAt,
    })
    .from(catalogPdfJobTable)
    .where(eq(catalogPdfJobTable.id, jobId))
    .limit(1);
  if (!row) throw new Error(`Job ${jobId} not found`);
  return row;
}

async function waitForJobTerminal(
  jobId: number,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await supertest(app)
      .get(`/api/admin/catalog-pdf/${jobId}/status`)
      .set("Authorization", `Bearer ${adminToken}`);
    const { status } = res.body as { status: string };
    if (status === "done" || status === "failed" || status === "cancelled") return status;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Job ${jobId} did not reach a terminal state within ${timeoutMs}ms`);
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  process.env.ADMIN_PASSWORD = ADMIN_SECRET;
  adminToken = signAdminToken(Date.now(), ADMIN_SECRET);
  mockExtractCatalogPage.mockResolvedValue({ entries: [], rawText: "" });
}, 15_000);

afterEach(() => {
  jest.clearAllMocks();
  mockExtractCatalogPage.mockResolvedValue({ entries: [], rawText: "" });
});

afterAll(async () => {
  if (seededJobIds.length > 0) {
    await db.delete(catalogPdfJobTable).where(inArray(catalogPdfJobTable.id, seededJobIds));
  }
  if (seededInventoryIds.length > 0) {
    await db.delete(inventoryTable).where(inArray(inventoryTable.id, seededInventoryIds));
  }
  await closePool();
}, 15_000);

// =============================================================================
// Suite 1: /resume — chunkPageOffset drives startPageWithinChunk and
//          processedPagesBase correctly
// =============================================================================

describe("POST /api/admin/catalog-pdf/:jobId/resume — chunkPageOffset arithmetic", () => {
  it(
    "skips pages before (processedPages - chunkPageOffset) and starts final counter at processedPages",
    async () => {
      // Job has already processed 5 pages from a prior chunk; the client is
      // uploading the next chunk (which also has 5 pages in the PDF slice) and
      // tells the server the chunk starts at global page offset 3.
      //
      // Expected arithmetic:
      //   resumeFromPage        = 5   (jobRow.processedPages)
      //   startPageWithinChunk  = max(0, 5 - 3) = 2   → skip first 2 pages
      //   processedPagesBase    = 5
      //
      // So processPdfPages is called with pages 2..4 (3 pages), and the final
      // processedPages counter should be 5 + 3 = 8.

      const CHUNK_PAGES = 5;
      const ALREADY_PROCESSED = 5;
      const CHUNK_PAGE_OFFSET = 3;

      const jobId = await seedJob({
        status: "failed",
        processedPages: ALREADY_PROCESSED,
        totalPages: CHUNK_PAGES,
        errorMessage: "Simulated mid-chunk crash",
      });

      mockExtractPdfPages.mockResolvedValueOnce(makeFakePages(CHUNK_PAGES));
      mockExtractCatalogPage.mockResolvedValue({ entries: [], rawText: "" });

      await supertest(app)
        .post(`/api/admin/catalog-pdf/${jobId}/resume`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ pdfBase64: STUB_PDF_B64, chunkPageOffset: CHUNK_PAGE_OFFSET })
        .expect(200);

      await waitForJobTerminal(jobId);

      // Only 3 pages should have been sent to the extractor (indices 2, 3, 4).
      const expectedCalls = CHUNK_PAGES - (ALREADY_PROCESSED - CHUNK_PAGE_OFFSET);
      expect(mockExtractCatalogPage).toHaveBeenCalledTimes(expectedCalls);

      // The counter should begin at processedPagesBase (5) and end at 5 + 3 = 8.
      const finalRow = await readJobRow(jobId);
      expect(finalRow.status).toBe("done");
      expect(finalRow.processedPages).toBe(ALREADY_PROCESSED + expectedCalls);
    },
    20_000,
  );

  it(
    "clamps startPageWithinChunk to 0 when chunkPageOffset > processedPages (resume from start of chunk)",
    async () => {
      // processedPages=2, chunkPageOffset=10 → startPageWithinChunk = max(0, 2-10) = 0
      // All 4 pages in the chunk should be processed.
      // processedPagesBase = 2, so final processedPages = 2 + 4 = 6.

      const CHUNK_PAGES = 4;
      const ALREADY_PROCESSED = 2;
      const CHUNK_PAGE_OFFSET = 10;

      const jobId = await seedJob({
        status: "failed",
        processedPages: ALREADY_PROCESSED,
        totalPages: CHUNK_PAGES,
        errorMessage: "Simulated crash",
      });

      mockExtractPdfPages.mockResolvedValueOnce(makeFakePages(CHUNK_PAGES));
      mockExtractCatalogPage.mockResolvedValue({ entries: [], rawText: "" });

      await supertest(app)
        .post(`/api/admin/catalog-pdf/${jobId}/resume`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ pdfBase64: STUB_PDF_B64, chunkPageOffset: CHUNK_PAGE_OFFSET })
        .expect(200);

      await waitForJobTerminal(jobId);

      expect(mockExtractCatalogPage).toHaveBeenCalledTimes(CHUNK_PAGES);

      const finalRow = await readJobRow(jobId);
      expect(finalRow.status).toBe("done");
      expect(finalRow.processedPages).toBe(ALREADY_PROCESSED + CHUNK_PAGES);
    },
    20_000,
  );

  it(
    "response body includes the correct resumeFromPage matching processedPages",
    async () => {
      const ALREADY_PROCESSED = 7;

      const jobId = await seedJob({
        status: "failed",
        processedPages: ALREADY_PROCESSED,
        totalPages: 10,
        errorMessage: "Crash",
      });

      mockExtractPdfPages.mockResolvedValueOnce(makeFakePages(10));
      mockExtractCatalogPage.mockResolvedValue({ entries: [], rawText: "" });

      const res = await supertest(app)
        .post(`/api/admin/catalog-pdf/${jobId}/resume`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ pdfBase64: STUB_PDF_B64, chunkPageOffset: 5 })
        .expect(200);

      expect(res.body.resumeFromPage).toBe(ALREADY_PROCESSED);

      await waitForJobTerminal(jobId);
    },
    15_000,
  );
});

// =============================================================================
// Suite 2: GET /reviews — 400 for non-numeric ?jobId=
// =============================================================================

describe("GET /api/admin/catalog-pdf/reviews — non-numeric ?jobId= guard", () => {
  it("returns 400 when ?jobId= is a non-numeric string", async () => {
    const res = await supertest(app)
      .get("/api/admin/catalog-pdf/reviews?jobId=abc")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(400);

    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toMatch(/invalid jobid/i);
  });

  it("returns 400 when ?jobId= is a mixed alphanumeric string", async () => {
    const res = await supertest(app)
      .get("/api/admin/catalog-pdf/reviews?jobId=12abc")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(400);

    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toMatch(/invalid jobid/i);
  });

  it("returns 200 (not 400) when ?jobId= is a valid numeric string", async () => {
    // Any numeric jobId is syntactically valid — the response may be an empty
    // list if no items belong to that job, but it must not be a 400.
    await supertest(app)
      .get("/api/admin/catalog-pdf/reviews?jobId=99999999")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
  });

  it("returns 200 (not 400) when ?jobId= is absent", async () => {
    await supertest(app)
      .get("/api/admin/catalog-pdf/reviews")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
  });
});

// =============================================================================
// Suite 3: cancel — also cancels child chunk jobs
// =============================================================================

describe("POST /api/admin/catalog-pdf/:jobId/cancel — cascades to child chunk jobs", () => {
  it("cancels pending child jobs when the parent is cancelled", async () => {
    const parentId = await seedJob({ chunkCount: 2, status: "processing" });
    const child0 = await seedJob({
      parentJobId: parentId,
      chunkIndex: 0,
      chunkCount: 2,
      pageOffset: 0,
      status: "pending",
    });
    const child1 = await seedJob({
      parentJobId: parentId,
      chunkIndex: 1,
      chunkCount: 2,
      pageOffset: 10,
      status: "pending",
    });

    await supertest(app)
      .post(`/api/admin/catalog-pdf/${parentId}/cancel`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    const parentRow = await readJobRow(parentId);
    expect(parentRow.status).toBe("cancelled");

    const child0Row = await readJobRow(child0);
    expect(child0Row.status).toBe("cancelled");
    expect(child0Row.finishedAt).not.toBeNull();

    const child1Row = await readJobRow(child1);
    expect(child1Row.status).toBe("cancelled");
    expect(child1Row.finishedAt).not.toBeNull();
  });

  it("cancels processing child jobs when the parent is cancelled", async () => {
    const parentId = await seedJob({ chunkCount: 2, status: "processing" });
    const child0 = await seedJob({
      parentJobId: parentId,
      chunkIndex: 0,
      chunkCount: 2,
      pageOffset: 0,
      status: "processing",
    });
    const child1 = await seedJob({
      parentJobId: parentId,
      chunkIndex: 1,
      chunkCount: 2,
      pageOffset: 10,
      status: "processing",
    });

    await supertest(app)
      .post(`/api/admin/catalog-pdf/${parentId}/cancel`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    const child0Row = await readJobRow(child0);
    expect(child0Row.status).toBe("cancelled");

    const child1Row = await readJobRow(child1);
    expect(child1Row.status).toBe("cancelled");
  });

  it("does not change already-terminal child jobs (done or failed)", async () => {
    const parentId = await seedJob({ chunkCount: 3, status: "processing" });
    const doneChild = await seedJob({
      parentJobId: parentId,
      chunkIndex: 0,
      chunkCount: 3,
      pageOffset: 0,
      status: "done",
      processedPages: 10,
    });
    const failedChild = await seedJob({
      parentJobId: parentId,
      chunkIndex: 1,
      chunkCount: 3,
      pageOffset: 10,
      status: "failed",
      errorMessage: "Crashed",
    });
    const pendingChild = await seedJob({
      parentJobId: parentId,
      chunkIndex: 2,
      chunkCount: 3,
      pageOffset: 20,
      status: "pending",
    });

    await supertest(app)
      .post(`/api/admin/catalog-pdf/${parentId}/cancel`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    // Terminal children must keep their original status.
    const doneRow = await readJobRow(doneChild);
    expect(doneRow.status).toBe("done");

    const failedRow = await readJobRow(failedChild);
    expect(failedRow.status).toBe("failed");

    // The pending child should have been cancelled.
    const pendingRow = await readJobRow(pendingChild);
    expect(pendingRow.status).toBe("cancelled");
  });
});

// =============================================================================
// Suite 4: revert — clears both imageUrl and imageUrl2
// =============================================================================

describe("POST /api/admin/catalog-pdf/reviews/:id/revert — clears imageUrl and imageUrl2", () => {
  async function seedInventoryItem(overrides: {
    imageUrl?: string | null;
    imageUrl2?: string | null;
    catalogPdfJobId?: number | null;
  }): Promise<number> {
    const [row] = await db
      .insert(inventoryTable)
      .values({
        vendor: VENDOR,
        catalog: `JEST-REVERT-${Date.now()}-${Math.random()}`,
        description: "Original description",
        previousDescription: "Prior description",
        binLocations: [],
        aiKeywords: [],
        imageSource: "pdf_extraction",
        imageConfidence: 0.85,
        imageUrl: overrides.imageUrl ?? null,
        imageUrl2: overrides.imageUrl2 ?? null,
        catalogPdfJobId: overrides.catalogPdfJobId ?? null,
      })
      .returning({ id: inventoryTable.id });
    if (!row) throw new Error("Failed to seed inventory item");
    seededInventoryIds.push(row.id);
    return row.id;
  }

  it("sets imageUrl to null after revert", async () => {
    const itemId = await seedInventoryItem({ imageUrl: "https://cdn.example.com/img1.png" });

    await supertest(app)
      .post(`/api/admin/catalog-pdf/reviews/${itemId}/revert`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    const [row] = await db
      .select({ imageUrl: inventoryTable.imageUrl })
      .from(inventoryTable)
      .where(eq(inventoryTable.id, itemId))
      .limit(1);
    expect(row?.imageUrl).toBeNull();
  });

  it("sets imageUrl2 to null after revert", async () => {
    const itemId = await seedInventoryItem({
      imageUrl: "https://cdn.example.com/img1.png",
      imageUrl2: "https://cdn.example.com/img2.png",
    });

    await supertest(app)
      .post(`/api/admin/catalog-pdf/reviews/${itemId}/revert`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    const [row] = await db
      .select({ imageUrl: inventoryTable.imageUrl, imageUrl2: inventoryTable.imageUrl2 })
      .from(inventoryTable)
      .where(eq(inventoryTable.id, itemId))
      .limit(1);
    expect(row?.imageUrl).toBeNull();
    expect(row?.imageUrl2).toBeNull();
  });

  it("clears both imageUrl and imageUrl2 even when only imageUrl2 is set", async () => {
    const itemId = await seedInventoryItem({
      imageUrl: null,
      imageUrl2: "https://cdn.example.com/secondary.png",
    });

    await supertest(app)
      .post(`/api/admin/catalog-pdf/reviews/${itemId}/revert`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    const [row] = await db
      .select({ imageUrl: inventoryTable.imageUrl, imageUrl2: inventoryTable.imageUrl2 })
      .from(inventoryTable)
      .where(eq(inventoryTable.id, itemId))
      .limit(1);
    expect(row?.imageUrl).toBeNull();
    expect(row?.imageUrl2).toBeNull();
  });

  it("also clears imageSource, imageConfidence, and catalogPdfJobId after revert", async () => {
    const jobId = await seedJob({ status: "done", processedPages: 5 });
    const itemId = await seedInventoryItem({
      imageUrl: "https://cdn.example.com/img.png",
      catalogPdfJobId: jobId,
    });

    await supertest(app)
      .post(`/api/admin/catalog-pdf/reviews/${itemId}/revert`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    const [row] = await db
      .select({
        imageSource: inventoryTable.imageSource,
        imageConfidence: inventoryTable.imageConfidence,
        catalogPdfJobId: inventoryTable.catalogPdfJobId,
        previousDescription: inventoryTable.previousDescription,
      })
      .from(inventoryTable)
      .where(eq(inventoryTable.id, itemId))
      .limit(1);
    expect(row?.imageSource).toBeNull();
    expect(row?.imageConfidence).toBeNull();
    expect(row?.catalogPdfJobId).toBeNull();
    expect(row?.previousDescription).toBeNull();
  });

  it("restores the original description from previousDescription", async () => {
    const itemId = await seedInventoryItem({ imageUrl: "https://cdn.example.com/img.png" });

    await supertest(app)
      .post(`/api/admin/catalog-pdf/reviews/${itemId}/revert`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    const [row] = await db
      .select({ description: inventoryTable.description })
      .from(inventoryTable)
      .where(eq(inventoryTable.id, itemId))
      .limit(1);
    expect(row?.description).toBe("Prior description");
  });
});
