/**
 * Integration tests for the PDF job cancel endpoint:
 *   POST /api/admin/catalog-pdf/:jobId/cancel
 *
 * Verifies:
 *   1. Returns 404 for a non-existent job.
 *   2. Returns 409 for jobs that cannot be cancelled (done, failed).
 *   3. Returns 200 and marks a processing job as cancelled.
 *   4. The processing loop detects cancellation and stops without marking the job "done".
 *
 * All heavy dependencies are mocked so no real PDF parsing, AI calls, or
 * object-storage uploads are required.
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

jest.mock("../src/lib/webSearch", () => ({
  callGemini: jest.fn(),
  callGeminiWithHistory: jest.fn(),
  WEB_REFERENCE_MODEL: "gemini-2.5-flash",
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import supertest from "supertest";
import app from "../src/app";
import { signAdminToken } from "./helpers/adminAuth";
import { closePool } from "./helpers/testDb";
import { db, catalogPdfJobTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { extractPdfPages } from "../src/utils/pdfProcessor";
import { extractCatalogPage } from "../src/utils/catalogExtractor";

// ── Typed mock handles ─────────────────────────────────────────────────────────

const mockExtractPdfPages = extractPdfPages as jest.MockedFunction<typeof extractPdfPages>;
const mockExtractCatalogPage = extractCatalogPage as jest.MockedFunction<typeof extractCatalogPage>;

// ── Constants ─────────────────────────────────────────────────────────────────

const ADMIN_SECRET = "jest-pdf-cancel-secret";
const VENDOR = "JEST-CANCEL-VENDOR";

/**
 * Minimal valid PDF payload: starts with the required %PDF- magic bytes and
 * contains no /Encrypt keyword so the route's PDF validation passes.
 * The pdfProcessor mock intercepts any actual parsing, so content beyond the
 * header is irrelevant.
 */
const FAKE_PDF_BASE64 = Buffer.from(
  "%PDF-1.4 fake content for cancel integration tests",
).toString("base64");

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFakePages(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    pageNum: i + 1,
    text: `page ${i + 1} text`,
    images: [] as Buffer[],
    isRendered: false,
    pageWidth: 0,
    pageHeight: 0,
  }));
}

interface SeedJobOptions {
  status: string;
  processedPages?: number;
  totalPages?: number | null;
  matchedParts?: number;
  errorMessage?: string | null;
}

async function seedJob(opts: SeedJobOptions): Promise<number> {
  const [row] = await db
    .insert(catalogPdfJobTable)
    .values({
      vendor: VENDOR,
      filename: "jest-cancel-test.pdf",
      status: opts.status,
      processedPages: opts.processedPages ?? 0,
      matchedParts: opts.matchedParts ?? 0,
      totalPages: opts.totalPages ?? null,
      errorMessage: opts.errorMessage ?? null,
    })
    .returning({ id: catalogPdfJobTable.id });
  if (!row) throw new Error("Failed to seed job");
  seededJobIds.push(row.id);
  return row.id;
}

async function readJobRow(
  jobId: number,
): Promise<{ status: string; processedPages: number; matchedParts: number; finishedAt: Date | null }> {
  const [row] = await db
    .select({
      status: catalogPdfJobTable.status,
      processedPages: catalogPdfJobTable.processedPages,
      matchedParts: catalogPdfJobTable.matchedParts,
      finishedAt: catalogPdfJobTable.finishedAt,
    })
    .from(catalogPdfJobTable)
    .where(eq(catalogPdfJobTable.id, jobId))
    .limit(1);
  if (!row) throw new Error(`Job ${jobId} not found in DB`);
  return row;
}

/**
 * Poll the status endpoint until the job reaches a terminal state
 * (done, failed, or cancelled). Throws if the job does not settle within
 * the given timeout.
 */
async function waitForJobTerminal(
  jobId: number,
  token: string,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await supertest(app)
      .get(`/api/admin/catalog-pdf/${jobId}/status`)
      .set("Authorization", `Bearer ${token}`);
    const { status } = res.body as { status: string };
    if (status === "done" || status === "failed" || status === "cancelled") return status;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Job ${jobId} did not reach a terminal state within ${timeoutMs}ms`);
}

// ── State ─────────────────────────────────────────────────────────────────────

let adminToken: string;
const seededJobIds: number[] = [];

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  process.env.ADMIN_PASSWORD = ADMIN_SECRET;
  adminToken = signAdminToken(Date.now(), ADMIN_SECRET);
}, 15_000);

afterEach(() => {
  jest.resetAllMocks();
});

afterAll(async () => {
  if (seededJobIds.length > 0) {
    await db
      .delete(catalogPdfJobTable)
      .where(inArray(catalogPdfJobTable.id, seededJobIds));
  }
  await closePool();
}, 15_000);

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1: 404 for non-existent jobs
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/admin/catalog-pdf/:jobId/cancel — 404 for non-existent job", () => {
  it("returns 404 when the jobId does not exist in the database", async () => {
    const res = await supertest(app)
      .post("/api/admin/catalog-pdf/999999999/cancel")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(404);

    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toMatch(/not found/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2: 409 for non-cancellable statuses
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/admin/catalog-pdf/:jobId/cancel — 409 for non-cancellable statuses", () => {
  it("returns 409 when the job status is 'done'", async () => {
    const jobId = await seedJob({
      status: "done",
      processedPages: 5,
      totalPages: 5,
    });

    const res = await supertest(app)
      .post(`/api/admin/catalog-pdf/${jobId}/cancel`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(409);

    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toMatch(/done/i);
  });

  it("returns 409 when the job status is 'failed'", async () => {
    const jobId = await seedJob({
      status: "failed",
      processedPages: 2,
      totalPages: 5,
      errorMessage: "Simulated crash",
    });

    const res = await supertest(app)
      .post(`/api/admin/catalog-pdf/${jobId}/cancel`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(409);

    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toMatch(/failed/i);
  });

  it("returns 409 when the job status is already 'cancelled'", async () => {
    const jobId = await seedJob({ status: "cancelled", processedPages: 1, totalPages: 5 });

    const res = await supertest(app)
      .post(`/api/admin/catalog-pdf/${jobId}/cancel`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(409);

    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toMatch(/cancelled/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 3: Successful cancellation of processing jobs
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/admin/catalog-pdf/:jobId/cancel — cancels processing jobs", () => {
  it("returns 200 and marks a processing job as cancelled", async () => {
    const jobId = await seedJob({
      status: "processing",
      processedPages: 2,
      totalPages: 5,
    });

    const res = await supertest(app)
      .post(`/api/admin/catalog-pdf/${jobId}/cancel`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body).toMatchObject({ ok: true, jobId: String(jobId) });

    const row = await readJobRow(jobId);
    expect(row.status).toBe("cancelled");
    expect(row.finishedAt).not.toBeNull();
  });

  it("returns 200 and marks a pending job as cancelled", async () => {
    const jobId = await seedJob({ status: "pending" });

    const res = await supertest(app)
      .post(`/api/admin/catalog-pdf/${jobId}/cancel`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body).toMatchObject({ ok: true, jobId: String(jobId) });

    const row = await readJobRow(jobId);
    expect(row.status).toBe("cancelled");
    expect(row.finishedAt).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 4: Processing loop respects cancellation flag
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/admin/catalog-pdf/:jobId/cancel — processing loop stops on cancellation", () => {
  it("loop does not mark the job done when cancellation is set during processing", async () => {
    const TOTAL_PAGES = 3;

    const jobId = await seedJob({
      status: "failed",
      processedPages: 0,
      totalPages: TOTAL_PAGES,
      errorMessage: "Earlier failure",
    });

    /**
     * Cancel the job inside the extractPdfPages mock, which runs while the
     * async loop is "in flight" but before the per-page loop begins. The loop
     * will then see status = "cancelled" on the very first page and break
     * without ever reaching "done".
     */
    mockExtractPdfPages.mockImplementation(async () => {
      await supertest(app)
        .post(`/api/admin/catalog-pdf/${jobId}/cancel`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);
      return makeFakePages(TOTAL_PAGES);
    });
    mockExtractCatalogPage.mockResolvedValue({ entries: [], rawText: "" });

    await supertest(app)
      .post(`/api/admin/catalog-pdf/${jobId}/resume`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pdfBase64: FAKE_PDF_BASE64 })
      .expect(200);

    const finalStatus = await waitForJobTerminal(jobId, adminToken);

    expect(finalStatus).toBe("cancelled");
    expect(mockExtractCatalogPage).not.toHaveBeenCalled();
  });

  it("loop stops mid-way and does not process further pages after cancellation", async () => {
    const TOTAL_PAGES = 4;

    const jobId = await seedJob({
      status: "failed",
      processedPages: 0,
      totalPages: TOTAL_PAGES,
      errorMessage: "Earlier failure",
    });

    let extractCallCount = 0;

    /**
     * Cancel inside extractCatalogPage on the first call. The loop will finish
     * page 1 (cancellation is checked at the top of each iteration), then on
     * page 2's cancellation check it will see "cancelled" and break.
     * Pages 3 and 4 should never be processed.
     */
    mockExtractPdfPages.mockResolvedValueOnce(makeFakePages(TOTAL_PAGES));
    mockExtractCatalogPage.mockImplementation(async () => {
      extractCallCount++;
      if (extractCallCount === 1) {
        await supertest(app)
          .post(`/api/admin/catalog-pdf/${jobId}/cancel`)
          .set("Authorization", `Bearer ${adminToken}`)
          .expect(200);
      }
      return { entries: [], rawText: "" };
    });

    await supertest(app)
      .post(`/api/admin/catalog-pdf/${jobId}/resume`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pdfBase64: FAKE_PDF_BASE64 })
      .expect(200);

    const finalStatus = await waitForJobTerminal(jobId, adminToken);

    expect(finalStatus).toBe("cancelled");

    // Only the first page's extractCatalogPage call should have run; the loop
    // should break before processing subsequent pages.
    expect(mockExtractCatalogPage).toHaveBeenCalledTimes(1);

    const row = await readJobRow(jobId);
    expect(row.status).toBe("cancelled");
  });

  it("cancelled job retains its processedPages count up to the point of cancellation", async () => {
    const TOTAL_PAGES = 3;

    const jobId = await seedJob({
      status: "failed",
      processedPages: 0,
      totalPages: TOTAL_PAGES,
      errorMessage: "Earlier failure",
    });

    /**
     * Cancel only on the second extractCatalogPage call so that page 1 is
     * fully processed and its processedPages increment is written to the DB
     * before the loop breaks on page 2.
     */
    let extractCallCount = 0;
    mockExtractPdfPages.mockResolvedValueOnce(makeFakePages(TOTAL_PAGES));
    mockExtractCatalogPage.mockImplementation(async () => {
      extractCallCount++;
      if (extractCallCount === 2) {
        await supertest(app)
          .post(`/api/admin/catalog-pdf/${jobId}/cancel`)
          .set("Authorization", `Bearer ${adminToken}`)
          .expect(200);
      }
      return { entries: [], rawText: "" };
    });

    await supertest(app)
      .post(`/api/admin/catalog-pdf/${jobId}/resume`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pdfBase64: FAKE_PDF_BASE64 })
      .expect(200);

    await waitForJobTerminal(jobId, adminToken);

    const row = await readJobRow(jobId);
    expect(row.status).toBe("cancelled");
    // Pages 1 and 2 were processed (page 2 extracted entries, incremented count,
    // then page 3 check saw cancelled and broke).
    expect(row.processedPages).toBeGreaterThanOrEqual(1);
    expect(row.processedPages).toBeLessThan(TOTAL_PAGES);
  });
});
