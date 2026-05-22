/**
 * Integration tests for the PDF job resume endpoint:
 *   POST /api/admin/catalog-pdf/:jobId/resume
 *
 * Verifies:
 *   1. Returns 404 for a non-existent job.
 *   2. Returns 409 for jobs that cannot be resumed (done, pending).
 *   3. Processing starts from processedPages (already-processed pages are skipped).
 *   4. Job status is set to "processing" synchronously before async work begins.
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

// ── Typed mock handles ─────────────────────────────────────────────────────────

const mockExtractPdfPages = extractPdfPages as jest.MockedFunction<typeof extractPdfPages>;
const mockExtractCatalogPage = extractCatalogPage as jest.MockedFunction<typeof extractCatalogPage>;

// ── Constants ─────────────────────────────────────────────────────────────────

const ADMIN_SECRET = "jest-pdf-resume-secret";
const VENDOR = "JEST-RESUME-VENDOR";

/** Minimal valid base64 payload (the route only validates presence, not content). */
const FAKE_PDF_BASE64 = Buffer.alloc(16).toString("base64");

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Five fake pages for use across tests. */
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

/** Insert a catalog_pdf_job row directly and register its id for cleanup. */
async function seedJob(opts: SeedJobOptions): Promise<number> {
  const [row] = await db
    .insert(catalogPdfJobTable)
    .values({
      vendor: VENDOR,
      filename: "jest-resume-test.pdf",
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

/** Read status and processedPages for a job directly from the DB. */
async function readJobRow(
  jobId: number,
): Promise<{ status: string; processedPages: number; matchedParts: number }> {
  const [row] = await db
    .select({
      status: catalogPdfJobTable.status,
      processedPages: catalogPdfJobTable.processedPages,
      matchedParts: catalogPdfJobTable.matchedParts,
    })
    .from(catalogPdfJobTable)
    .where(eq(catalogPdfJobTable.id, jobId))
    .limit(1);
  if (!row) throw new Error(`Job ${jobId} not found in DB`);
  return row;
}

/**
 * Poll the status endpoint until the job reaches a terminal state (done or failed).
 * Throws if the job does not settle within the given timeout.
 */
async function waitForJobTerminal(
  jobId: number,
  token: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await supertest(app)
      .get(`/api/admin/catalog-pdf/${jobId}/status`)
      .set("Authorization", `Bearer ${token}`);
    const { status } = res.body as { status: string };
    if (status === "done" || status === "failed") return;
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

describe("POST /api/admin/catalog-pdf/:jobId/resume — 404 for non-existent job", () => {
  it("returns 404 when the jobId does not exist in the database", async () => {
    const res = await supertest(app)
      .post("/api/admin/catalog-pdf/999999999/resume")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pdfBase64: FAKE_PDF_BASE64 })
      .expect(404);

    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toMatch(/not found/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2: 409 for non-resumable statuses
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/admin/catalog-pdf/:jobId/resume — 409 for non-resumable statuses", () => {
  it("returns 409 when the job status is 'done'", async () => {
    const jobId = await seedJob({
      status: "done",
      processedPages: 5,
      totalPages: 5,
    });

    const res = await supertest(app)
      .post(`/api/admin/catalog-pdf/${jobId}/resume`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pdfBase64: FAKE_PDF_BASE64 })
      .expect(409);

    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toMatch(/done/i);
  });

  it("returns 409 when the job status is 'pending'", async () => {
    const jobId = await seedJob({ status: "pending" });

    const res = await supertest(app)
      .post(`/api/admin/catalog-pdf/${jobId}/resume`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pdfBase64: FAKE_PDF_BASE64 })
      .expect(409);

    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toMatch(/pending/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 3: Processing starts from processedPages, not from page 0
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/admin/catalog-pdf/:jobId/resume — skips already-processed pages", () => {
  it("calls extractCatalogPage only for pages after processedPages when resuming a failed job", async () => {
    const TOTAL_PAGES = 5;
    const ALREADY_PROCESSED = 2;

    const jobId = await seedJob({
      status: "failed",
      processedPages: ALREADY_PROCESSED,
      totalPages: TOTAL_PAGES,
      errorMessage: "Simulated crash after page 2",
    });

    mockExtractPdfPages.mockResolvedValueOnce(makeFakePages(TOTAL_PAGES));
    mockExtractCatalogPage.mockResolvedValue([]);

    await supertest(app)
      .post(`/api/admin/catalog-pdf/${jobId}/resume`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pdfBase64: FAKE_PDF_BASE64 })
      .expect(200);

    await waitForJobTerminal(jobId, adminToken);

    const expectedPageCalls = TOTAL_PAGES - ALREADY_PROCESSED;
    expect(mockExtractCatalogPage).toHaveBeenCalledTimes(expectedPageCalls);
  });

  it("processes only the remaining pages and reaches the correct final processedPages count", async () => {
    const TOTAL_PAGES = 4;
    const ALREADY_PROCESSED = 3;

    const jobId = await seedJob({
      status: "failed",
      processedPages: ALREADY_PROCESSED,
      totalPages: TOTAL_PAGES,
      errorMessage: "Crash on page 4",
    });

    mockExtractPdfPages.mockResolvedValueOnce(makeFakePages(TOTAL_PAGES));
    mockExtractCatalogPage.mockResolvedValue([]);

    await supertest(app)
      .post(`/api/admin/catalog-pdf/${jobId}/resume`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pdfBase64: FAKE_PDF_BASE64 })
      .expect(200);

    await waitForJobTerminal(jobId, adminToken);

    const finalRow = await readJobRow(jobId);
    expect(finalRow.status).toBe("done");
    expect(finalRow.processedPages).toBe(TOTAL_PAGES);
  });

  it("does not call extractCatalogPage at all when all pages were already processed (0 remaining)", async () => {
    const TOTAL_PAGES = 3;

    const jobId = await seedJob({
      status: "failed",
      processedPages: TOTAL_PAGES,
      totalPages: TOTAL_PAGES,
      errorMessage: "Crash after final page was saved",
    });

    mockExtractPdfPages.mockResolvedValueOnce(makeFakePages(TOTAL_PAGES));
    mockExtractCatalogPage.mockResolvedValue([]);

    await supertest(app)
      .post(`/api/admin/catalog-pdf/${jobId}/resume`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pdfBase64: FAKE_PDF_BASE64 })
      .expect(200);

    await waitForJobTerminal(jobId, adminToken);

    expect(mockExtractCatalogPage).not.toHaveBeenCalled();

    const finalRow = await readJobRow(jobId);
    expect(finalRow.status).toBe("done");
    expect(finalRow.processedPages).toBe(TOTAL_PAGES);
  });

  it("passes text from the correct remaining page to extractCatalogPage (not from page 0)", async () => {
    const TOTAL_PAGES = 3;
    const ALREADY_PROCESSED = 1;

    const jobId = await seedJob({
      status: "failed",
      processedPages: ALREADY_PROCESSED,
      totalPages: TOTAL_PAGES,
    });

    const pages = makeFakePages(TOTAL_PAGES);
    mockExtractPdfPages.mockResolvedValueOnce(pages);
    mockExtractCatalogPage.mockResolvedValue([]);

    await supertest(app)
      .post(`/api/admin/catalog-pdf/${jobId}/resume`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pdfBase64: FAKE_PDF_BASE64 })
      .expect(200);

    await waitForJobTerminal(jobId, adminToken);

    expect(mockExtractCatalogPage).toHaveBeenCalledTimes(TOTAL_PAGES - ALREADY_PROCESSED);

    const firstCallArgs = mockExtractCatalogPage.mock.calls[0];
    expect(firstCallArgs).toBeDefined();
    expect(firstCallArgs![0]).toBe(pages[ALREADY_PROCESSED]!.text);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 4: Status set to "processing" before async work begins
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/admin/catalog-pdf/:jobId/resume — status transitions to processing before async work", () => {
  it("sets job status to 'processing' in the DB before extractPdfPages is called", async () => {
    const jobId = await seedJob({
      status: "failed",
      processedPages: 0,
      totalPages: 2,
      errorMessage: "Earlier failure",
    });

    let statusWhenExtractCalled: string | null = null;

    mockExtractPdfPages.mockImplementation(async () => {
      const row = await readJobRow(jobId);
      statusWhenExtractCalled = row.status;
      return makeFakePages(2);
    });
    mockExtractCatalogPage.mockResolvedValue([]);

    await supertest(app)
      .post(`/api/admin/catalog-pdf/${jobId}/resume`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pdfBase64: FAKE_PDF_BASE64 })
      .expect(200);

    await waitForJobTerminal(jobId, adminToken);

    expect(statusWhenExtractCalled).toBe("processing");
  });

  it("response body includes the correct resumeFromPage value matching processedPages", async () => {
    const ALREADY_PROCESSED = 3;

    const jobId = await seedJob({
      status: "failed",
      processedPages: ALREADY_PROCESSED,
      totalPages: 5,
    });

    mockExtractPdfPages.mockResolvedValueOnce(makeFakePages(5));
    mockExtractCatalogPage.mockResolvedValue([]);

    const res = await supertest(app)
      .post(`/api/admin/catalog-pdf/${jobId}/resume`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pdfBase64: FAKE_PDF_BASE64 })
      .expect(200);

    expect(res.body).toMatchObject({
      jobId: String(jobId),
      message: "Job resuming",
      resumeFromPage: ALREADY_PROCESSED,
    });

    await waitForJobTerminal(jobId, adminToken);
  });
});
