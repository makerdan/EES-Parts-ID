/**
 * Integration tests for the idempotency guard in the PDF resume endpoint.
 *
 * Covers:
 *   POST /api/admin/catalog-pdf/:jobId/resume — idempotency guard behaviour
 *     when a client retries a chunk that was already fully processed.
 *
 *   Three scenarios:
 *     1. Fully-processed chunk retried: second POST returns 200
 *        "Chunk already processed, no-op" with no additional DB writes.
 *     2. Partial chunk (processedPages < chunkPageOffset + chunkPageCount):
 *        normal processing is triggered (guard does NOT fire).
 *     3. Request omitting chunkPageCount (legacy client): guard is bypassed
 *        entirely and normal processing proceeds.
 */

// ── Module mocks — must be declared before any imports ────────────────────────

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
import { db, catalogPdfJobTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { extractPdfPages } from "../src/utils/pdfProcessor";
import { extractCatalogPage } from "../src/utils/catalogExtractor";

// ── Typed mocks ───────────────────────────────────────────────────────────────

const mockExtractPdfPages = extractPdfPages as jest.MockedFunction<typeof extractPdfPages>;
const mockExtractCatalogPage = extractCatalogPage as jest.MockedFunction<typeof extractCatalogPage>;

// ── Shared constants ──────────────────────────────────────────────────────────

const ADMIN_SECRET = "jest-chunk-idempotency-secret";
const VENDOR = "JEST-IDEMPOTENCY-VENDOR";
const STUB_PDF_B64 = Buffer.from("%PDF-1.4\n%%EOF").toString("base64");

// ── State ─────────────────────────────────────────────────────────────────────

let adminToken: string;
const seededJobIds: number[] = [];

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFakePages(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    pageNum: i,
    text: `idempotency-page-${i}`,
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
      filename: "jest-idempotency.pdf",
      status: "failed",
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
  mockExtractCatalogPage.mockResolvedValue([]);
}, 15_000);

afterEach(() => {
  jest.clearAllMocks();
  mockExtractCatalogPage.mockResolvedValue([]);
});

afterAll(async () => {
  if (seededJobIds.length > 0) {
    await db.delete(catalogPdfJobTable).where(inArray(catalogPdfJobTable.id, seededJobIds));
  }
  await closePool();
}, 15_000);

// =============================================================================
// Suite 1: Fully-processed chunk retried → no-op (idempotency guard fires)
// =============================================================================

describe("POST /api/admin/catalog-pdf/:jobId/resume — idempotency guard for duplicate chunk retry", () => {
  it(
    "returns 200 with 'Chunk already processed, no-op' when chunkPageOffset + chunkPageCount <= processedPages",
    async () => {
      // processedPages=5, chunkPageOffset=0, chunkPageCount=5 → 5 >= 0+5, guard fires.
      const jobId = await seedJob({
        status: "failed",
        processedPages: 5,
        totalPages: 5,
        errorMessage: "Simulated network retry",
      });

      const res = await supertest(app)
        .post(`/api/admin/catalog-pdf/${jobId}/resume`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ pdfBase64: STUB_PDF_B64, chunkPageOffset: 0, chunkPageCount: 5 })
        .expect(200);

      expect(res.body.message).toBe("Chunk already processed, no-op");
      expect(res.body.jobId).toBe(String(jobId));
      expect(res.body.resumeFromPage).toBe(5);
    },
    15_000,
  );

  it(
    "makes no additional DB writes (status stays 'failed', extractCatalogPage not called) on no-op",
    async () => {
      // Guard must return before the status update to 'processing' and before
      // any async PDF processing — confirming zero duplicate inventory inserts.
      const jobId = await seedJob({
        status: "failed",
        processedPages: 3,
        totalPages: 3,
        errorMessage: "Simulated retry",
      });

      await supertest(app)
        .post(`/api/admin/catalog-pdf/${jobId}/resume`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ pdfBase64: STUB_PDF_B64, chunkPageOffset: 0, chunkPageCount: 3 })
        .expect(200);

      // extractPdfPages and extractCatalogPage must not have been called —
      // if either fires, pages would have been re-processed and inventory
      // duplicates could result.
      expect(mockExtractPdfPages).not.toHaveBeenCalled();
      expect(mockExtractCatalogPage).not.toHaveBeenCalled();

      // The job status must remain 'failed'; the guard short-circuits before
      // the synchronous status update to 'processing'.
      const row = await readJobRow(jobId);
      expect(row.status).toBe("failed");
      expect(row.processedPages).toBe(3);
    },
    15_000,
  );

  it(
    "fires the guard when processedPages strictly exceeds chunkPageOffset + chunkPageCount",
    async () => {
      // processedPages=10, offset=2, count=5 → 10 >= 2+5=7, guard fires.
      const jobId = await seedJob({
        status: "failed",
        processedPages: 10,
        totalPages: 7,
        errorMessage: "Simulated over-processed retry",
      });

      const res = await supertest(app)
        .post(`/api/admin/catalog-pdf/${jobId}/resume`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ pdfBase64: STUB_PDF_B64, chunkPageOffset: 2, chunkPageCount: 5 })
        .expect(200);

      expect(res.body.message).toBe("Chunk already processed, no-op");
      expect(mockExtractPdfPages).not.toHaveBeenCalled();
    },
    15_000,
  );
});

// =============================================================================
// Suite 2: Partial chunk — guard does NOT fire, normal processing continues
// =============================================================================

describe("POST /api/admin/catalog-pdf/:jobId/resume — partial chunk bypasses idempotency guard", () => {
  it(
    "processes remaining pages when processedPages < chunkPageOffset + chunkPageCount",
    async () => {
      // processedPages=2, chunkPageOffset=0, chunkPageCount=5 → 2 < 5, guard does not fire.
      // The chunk has 5 pages; the first 2 were already processed, so 3 remain.
      const CHUNK_PAGES = 5;
      const ALREADY_PROCESSED = 2;

      const jobId = await seedJob({
        status: "failed",
        processedPages: ALREADY_PROCESSED,
        totalPages: CHUNK_PAGES,
        errorMessage: "Crash after partial processing",
      });

      mockExtractPdfPages.mockResolvedValueOnce(makeFakePages(CHUNK_PAGES));

      await supertest(app)
        .post(`/api/admin/catalog-pdf/${jobId}/resume`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ pdfBase64: STUB_PDF_B64, chunkPageOffset: 0, chunkPageCount: CHUNK_PAGES })
        .expect(200);

      const finalStatus = await waitForJobTerminal(jobId);
      expect(finalStatus).toBe("done");

      // Processing should have resumed from page 2, so 3 pages are extracted.
      const remainingPages = CHUNK_PAGES - ALREADY_PROCESSED;
      expect(mockExtractCatalogPage).toHaveBeenCalledTimes(remainingPages);

      const row = await readJobRow(jobId);
      expect(row.processedPages).toBe(ALREADY_PROCESSED + remainingPages);
    },
    20_000,
  );

  it(
    "does not return 'Chunk already processed, no-op' for a partial chunk",
    async () => {
      // processedPages=1, chunkPageOffset=0, chunkPageCount=4 → 1 < 4, no guard.
      const jobId = await seedJob({
        status: "failed",
        processedPages: 1,
        totalPages: 4,
        errorMessage: "Early crash",
      });

      mockExtractPdfPages.mockResolvedValueOnce(makeFakePages(4));

      const res = await supertest(app)
        .post(`/api/admin/catalog-pdf/${jobId}/resume`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ pdfBase64: STUB_PDF_B64, chunkPageOffset: 0, chunkPageCount: 4 })
        .expect(200);

      expect(res.body.message).not.toBe("Chunk already processed, no-op");
      expect(res.body.message).toBe("Job resuming");

      await waitForJobTerminal(jobId);
    },
    20_000,
  );
});

// =============================================================================
// Suite 3: Legacy client omitting chunkPageCount — guard is fully bypassed
// =============================================================================

describe("POST /api/admin/catalog-pdf/:jobId/resume — legacy client omitting chunkPageCount", () => {
  it(
    "bypasses the idempotency guard and resumes normally when chunkPageCount is absent",
    async () => {
      // Even though processedPages already equals the total pages, omitting
      // chunkPageCount means the guard cannot fire (chunkPageCount is null).
      // This preserves compatibility with older clients that don't send it.
      const CHUNK_PAGES = 3;
      const ALREADY_PROCESSED = 3;

      const jobId = await seedJob({
        status: "failed",
        processedPages: ALREADY_PROCESSED,
        totalPages: CHUNK_PAGES,
        errorMessage: "Legacy client retry",
      });

      mockExtractPdfPages.mockResolvedValueOnce(makeFakePages(CHUNK_PAGES));

      const res = await supertest(app)
        .post(`/api/admin/catalog-pdf/${jobId}/resume`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ pdfBase64: STUB_PDF_B64, chunkPageOffset: 0 })
        .expect(200);

      // Must not return the no-op message — guard was bypassed.
      expect(res.body.message).not.toBe("Chunk already processed, no-op");
      expect(res.body.message).toBe("Job resuming");

      await waitForJobTerminal(jobId);

      // extractPdfPages must have been called — the resume proceeded normally.
      expect(mockExtractPdfPages).toHaveBeenCalledTimes(1);
    },
    20_000,
  );

  it(
    "bypasses the guard when chunkPageCount is explicitly null",
    async () => {
      const jobId = await seedJob({
        status: "failed",
        processedPages: 5,
        totalPages: 5,
        errorMessage: "Null chunkPageCount retry",
      });

      mockExtractPdfPages.mockResolvedValueOnce(makeFakePages(5));

      const res = await supertest(app)
        .post(`/api/admin/catalog-pdf/${jobId}/resume`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ pdfBase64: STUB_PDF_B64, chunkPageOffset: 0, chunkPageCount: null })
        .expect(200);

      expect(res.body.message).not.toBe("Chunk already processed, no-op");

      await waitForJobTerminal(jobId);
    },
    20_000,
  );

  it(
    "bypasses the guard when chunkPageCount is zero (treated as absent)",
    async () => {
      // chunkPageCount=0 is not a valid positive count so is treated as null.
      const jobId = await seedJob({
        status: "failed",
        processedPages: 5,
        totalPages: 5,
        errorMessage: "Zero chunkPageCount retry",
      });

      mockExtractPdfPages.mockResolvedValueOnce(makeFakePages(5));

      const res = await supertest(app)
        .post(`/api/admin/catalog-pdf/${jobId}/resume`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ pdfBase64: STUB_PDF_B64, chunkPageOffset: 0, chunkPageCount: 0 })
        .expect(200);

      expect(res.body.message).not.toBe("Chunk already processed, no-op");

      await waitForJobTerminal(jobId);
    },
    20_000,
  );
});
