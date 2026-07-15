/**
 * Integration tests for per-chunk resume / retry support.
 *
 * Covers:
 *   POST /api/admin/catalog-pdf — chunk retry cleans up the old zero-progress
 *     failed child job and resets the parent from 'failed' → 'processing'
 *   POST /api/admin/catalog-pdf/:jobId/resume — works for child chunk jobs
 *     (must NOT return 409) and resets parent from 'failed' → 'processing'
 *   GET  /api/admin/catalog-pdf/:jobId/status — exposes failedChunks when
 *     one or more child jobs are in 'failed' state
 *   Full flow: parent finalises correctly after a chunk is retried via resume
 */

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockCreate = jest.fn();

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

// ── Mock the Poe bot chain so tests never make real network calls ─────────────
jest.mock("../src/lib/poeBot", () => {
  const actual = jest.requireActual<typeof import("../src/lib/poeBot")>("../src/lib/poeBot");
  return {
    ...actual,
    tryPoeBotChain: jest.fn(async (_feature: unknown, fn: (client: unknown, model: string) => unknown) =>
      fn({ chat: { completions: { create: mockCreate } } }, "test-model"),
    ),
  };
});

jest.mock("../src/utils/pdfProcessor", () => ({
  extractPdfPages: jest.fn(),
  validatePdf: jest.fn(),
}));

jest.mock("../src/utils/catalogExtractor", () => {
  const actual = jest.requireActual<typeof import("../src/utils/catalogExtractor")>(
    "../src/utils/catalogExtractor",
  );
  return {
    ...actual,
    extractCatalogPage: jest.fn(),
  };
});

jest.mock("../src/utils/catalogMatcher", () => ({
  matchCatalogNumber: jest.fn(),
}));

jest.mock("../src/lib/objectStorage", () => ({
  uploadCatalogImage: jest.fn(),
}));

// ── Imports ───────────────────────────────────────────────────────────────────
import supertest from "supertest";
import app from "../src/app";
import { signAdminToken } from "./helpers/adminAuth";
import { db, catalogPdfJobTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { extractPdfPages } from "../src/utils/pdfProcessor";
import { extractCatalogPage } from "../src/utils/catalogExtractor";

// ── Typed mocks ───────────────────────────────────────────────────────────────
const mockExtractPdfPages = extractPdfPages as jest.MockedFunction<typeof extractPdfPages>;
const mockExtractCatalogPage = extractCatalogPage as jest.MockedFunction<typeof extractCatalogPage>;

// ── Minimal valid PDF stub ────────────────────────────────────────────────────
const STUB_PDF_HEADER = "%PDF-1.4\n%%EOF";
const STUB_PDF_B64 = Buffer.from(STUB_PDF_HEADER).toString("base64");

// ── Setup / teardown ──────────────────────────────────────────────────────────
const ADMIN_SECRET = "jest-chunk-resume-secret";
let adminToken: string;
const seededIds: number[] = [];

async function seedJob(
  overrides: Partial<typeof catalogPdfJobTable.$inferInsert>,
): Promise<number> {
  const [row] = await db
    .insert(catalogPdfJobTable)
    .values({
      vendor: "JEST-CR-VENDOR",
      filename: "jest-chunk-resume.pdf",
      status: "pending",
      processedPages: 0,
      matchedParts: 0,
      ...overrides,
    })
    .returning({ id: catalogPdfJobTable.id });
  if (!row) throw new Error("Failed to seed job");
  seededIds.push(row.id);
  return row.id;
}

async function readJobRow(jobId: number) {
  const [row] = await db
    .select({
      status: catalogPdfJobTable.status,
      processedPages: catalogPdfJobTable.processedPages,
      errorMessage: catalogPdfJobTable.errorMessage,
      finishedAt: catalogPdfJobTable.finishedAt,
    })
    .from(catalogPdfJobTable)
    .where(eq(catalogPdfJobTable.id, jobId))
    .limit(1);
  if (!row) throw new Error(`Job ${jobId} not found`);
  return row;
}

async function waitForDb(
  check: () => Promise<boolean>,
  maxMs = 8000,
  intervalMs = 150,
): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitForDb timed out");
}

beforeAll(async () => {
  process.env.ADMIN_PASSWORD = ADMIN_SECRET;
  adminToken = signAdminToken(Date.now(), ADMIN_SECRET);
  mockExtractCatalogPage.mockResolvedValue({ entries: [], rawText: "" });
}, 15_000);

afterAll(async () => {
  if (seededIds.length > 0) {
    await db.delete(catalogPdfJobTable).where(inArray(catalogPdfJobTable.id, seededIds));
  }
}, 15_000);

beforeEach(() => {
  jest.clearAllMocks();
  mockExtractCatalogPage.mockResolvedValue({ entries: [], rawText: "" });
});

// ─────────────────────────────────────────────────────────────────────────────
// Resume endpoint: child chunk jobs
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /api/admin/catalog-pdf/:jobId/resume — child chunk jobs", () => {
  it("returns 200 (not 409) when resuming a failed child chunk job", async () => {
    mockExtractPdfPages.mockResolvedValueOnce([]);

    const parentId = await seedJob({ chunkCount: 2, status: "failed" });
    const childId = await seedJob({
      parentJobId: parentId,
      chunkIndex: 0,
      chunkCount: 2,
      pageOffset: 0,
      status: "failed",
      errorMessage: "Simulated chunk failure",
    });

    const res = await supertest(app)
      .post(`/api/admin/catalog-pdf/${childId}/resume`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pdfBase64: STUB_PDF_B64 })
      .expect(200);

    expect(res.body.jobId).toBe(String(childId));
  }, 15_000);

  it("resets the parent from 'failed' → 'processing' when resuming a failed child", async () => {
    mockExtractPdfPages.mockResolvedValueOnce([]);

    const parentId = await seedJob({ chunkCount: 1, status: "failed", errorMessage: "child failed" });
    const childId = await seedJob({
      parentJobId: parentId,
      chunkIndex: 0,
      chunkCount: 1,
      pageOffset: 0,
      status: "failed",
      errorMessage: "Simulated chunk failure",
    });

    await supertest(app)
      .post(`/api/admin/catalog-pdf/${childId}/resume`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pdfBase64: STUB_PDF_B64 })
      .expect(200);

    const parentRow = await readJobRow(parentId);
    expect(parentRow.status).toBe("processing");
    expect(parentRow.errorMessage).toBeNull();
  }, 15_000);

  it("parent finalises as 'done' after the only failed child completes its resume", async () => {
    mockExtractPdfPages.mockResolvedValue([]);

    // Create parent + child via the normal POST path so IDs are tracked
    const r0 = await supertest(app)
      .post("/api/admin/catalog-pdf")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        pdfBase64: STUB_PDF_B64, vendor: "EATON", filename: "chunk-resume.pdf",
        chunkIndex: 0, chunkCount: 1, pageOffset: 0,
      })
      .expect(200);

    const parentId = Number(r0.body.jobId);
    const childId = Number(r0.body.chunkJobId);
    seededIds.push(parentId, childId);

    // Wait for child to finish (it processes 0 pages quickly)
    await waitForDb(async () => {
      const [row] = await db
        .select({ status: catalogPdfJobTable.status })
        .from(catalogPdfJobTable)
        .where(eq(catalogPdfJobTable.id, parentId))
        .limit(1);
      return row?.status === "done" || row?.status === "failed";
    });

    // Force child back to failed to simulate a processing failure
    await db
      .update(catalogPdfJobTable)
      .set({ status: "failed", errorMessage: "Forced failure for test", finishedAt: new Date() })
      .where(eq(catalogPdfJobTable.id, childId));
    await db
      .update(catalogPdfJobTable)
      .set({ status: "failed", errorMessage: "Forced failure for test", finishedAt: new Date() })
      .where(eq(catalogPdfJobTable.id, parentId));

    // Resume the child
    mockExtractPdfPages.mockResolvedValueOnce([]);
    await supertest(app)
      .post(`/api/admin/catalog-pdf/${childId}/resume`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pdfBase64: STUB_PDF_B64 })
      .expect(200);

    // Parent should end up as 'done'
    await waitForDb(async () => {
      const [row] = await db
        .select({ status: catalogPdfJobTable.status })
        .from(catalogPdfJobTable)
        .where(eq(catalogPdfJobTable.id, parentId))
        .limit(1);
      return row?.status === "done";
    });

    const finalParent = await readJobRow(parentId);
    expect(finalParent.status).toBe("done");
  }, 20_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Re-uploading a chunk (POST /catalog-pdf with parentJobId) after failure
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /api/admin/catalog-pdf — chunk re-upload after failure", () => {
  it("deletes the old zero-progress failed child and creates a fresh one", async () => {
    mockExtractPdfPages.mockResolvedValue([]);

    // Create parent
    const r0 = await supertest(app)
      .post("/api/admin/catalog-pdf")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        pdfBase64: STUB_PDF_B64, vendor: "EATON", filename: "retry.pdf",
        chunkIndex: 0, chunkCount: 2, pageOffset: 0,
      })
      .expect(200);

    const parentId = Number(r0.body.jobId);
    const firstChildId = Number(r0.body.chunkJobId);
    seededIds.push(parentId, firstChildId);

    // Force child 1 creation with failed status manually
    const staleChildId = await seedJob({
      parentJobId: parentId,
      chunkIndex: 1,
      chunkCount: 2,
      pageOffset: 20,
      status: "failed",
      processedPages: 0,
      errorMessage: "Simulated upload failure",
    });

    // Also mark parent as failed
    await db
      .update(catalogPdfJobTable)
      .set({ status: "failed", errorMessage: "child failed" })
      .where(eq(catalogPdfJobTable.id, parentId));

    // Re-upload chunk 1 (retry)
    const r1 = await supertest(app)
      .post("/api/admin/catalog-pdf")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        pdfBase64: STUB_PDF_B64, vendor: "EATON", filename: "retry.pdf",
        chunkIndex: 1, chunkCount: 2, pageOffset: 20, parentJobId: parentId,
      })
      .expect(200);

    const newChildId = Number(r1.body.chunkJobId);
    seededIds.push(newChildId);

    expect(r1.body.jobId).toBe(String(parentId));
    expect(newChildId).not.toBe(staleChildId); // a fresh child was created

    // Stale child with 0 processedPages should have been deleted
    const [stale] = await db
      .select({ id: catalogPdfJobTable.id })
      .from(catalogPdfJobTable)
      .where(eq(catalogPdfJobTable.id, staleChildId))
      .limit(1);
    expect(stale).toBeUndefined();
  }, 15_000);

  it("resets the parent from 'failed' → 'processing' when re-uploading a chunk", async () => {
    mockExtractPdfPages.mockResolvedValue([]);

    // Create parent and first child
    const r0 = await supertest(app)
      .post("/api/admin/catalog-pdf")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        pdfBase64: STUB_PDF_B64, vendor: "EATON", filename: "retry2.pdf",
        chunkIndex: 0, chunkCount: 2, pageOffset: 0,
      })
      .expect(200);

    const parentId = Number(r0.body.jobId);
    const firstChildId = Number(r0.body.chunkJobId);
    seededIds.push(parentId, firstChildId);

    // Force parent to failed state
    await db
      .update(catalogPdfJobTable)
      .set({ status: "failed", errorMessage: "chunk 1 failed" })
      .where(eq(catalogPdfJobTable.id, parentId));

    // Re-upload chunk 1
    const r1 = await supertest(app)
      .post("/api/admin/catalog-pdf")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        pdfBase64: STUB_PDF_B64, vendor: "EATON", filename: "retry2.pdf",
        chunkIndex: 1, chunkCount: 2, pageOffset: 20, parentJobId: parentId,
      })
      .expect(200);

    seededIds.push(Number(r1.body.chunkJobId));

    const parentRow = await readJobRow(parentId);
    // With synchronous processing, the second chunk may immediately finalise the
    // parent (if all chunks are now done). Accept "processing" OR "done"; either
    // proves the parent was successfully reset from "failed".
    expect(["processing", "done"]).toContain(parentRow.status);
    expect(parentRow.errorMessage).toBeNull();
  }, 15_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /status — failedChunks in parent status response
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /api/admin/catalog-pdf/:id/status — failedChunks field", () => {
  it("includes failedChunks when a child job is in 'failed' state", async () => {
    const parentId = await seedJob({ chunkCount: 2, status: "failed" });
    const child0 = await seedJob({
      parentJobId: parentId, chunkIndex: 0, chunkCount: 2, pageOffset: 0,
      status: "done", processedPages: 10,
    });
    const child1 = await seedJob({
      parentJobId: parentId, chunkIndex: 1, chunkCount: 2, pageOffset: 10,
      status: "failed", errorMessage: "AI call timed out", processedPages: 0,
    });

    const res = await supertest(app)
      .get(`/api/admin/catalog-pdf/${parentId}/status`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.failedChunks).toBeDefined();
    expect(Array.isArray(res.body.failedChunks)).toBe(true);
    expect(res.body.failedChunks).toHaveLength(1);
    expect(res.body.failedChunks[0]).toMatchObject({
      chunkJobId: String(child1),
      chunkIndex: 1,
    });

    // Successful child should not appear in failedChunks
    const ids = res.body.failedChunks.map((c: { chunkJobId: string }) => c.chunkJobId);
    expect(ids).not.toContain(String(child0));
  });

  it("omits failedChunks when all children succeeded", async () => {
    const parentId = await seedJob({ chunkCount: 1, status: "done" });
    await seedJob({
      parentJobId: parentId, chunkIndex: 0, chunkCount: 1, pageOffset: 0,
      status: "done", processedPages: 5,
    });

    const res = await supertest(app)
      .get(`/api/admin/catalog-pdf/${parentId}/status`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.failedChunks).toBeUndefined();
  });
});
