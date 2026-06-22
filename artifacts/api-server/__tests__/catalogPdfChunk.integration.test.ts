/**
 * Integration tests for chunked PDF upload support.
 *
 * Covers:
 *   POST /api/admin/catalog-pdf — chunk fields (chunkIndex / chunkCount / pageOffset)
 *   GET  /api/admin/catalog-pdf/:parentJobId/status — aggregated status for parent jobs
 *   POST /api/admin/catalog-pdf/:jobId/resume — returns 409 for parent jobs
 *   GET  /api/admin/catalog-pdf/failed-jobs — excludes child jobs
 *
 * All heavy processing is mocked so tests are fast and deterministic.
 */

// ── Module mocks ─────────────────────────────────────────────────────────────

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
  class PoeBotChainExhaustedError extends Error {
    constructor() {
      super("All Poe bots in the fallback chain failed");
      this.name = "PoeBotChainExhaustedError";
    }
  }
  return {
    tryPoeBotChain: jest.fn(async (_feature: unknown, fn: (client: unknown, model: string) => unknown) =>
      fn({ chat: { completions: { create: mockCreate } } }, "test-model"),
    ),
    PoeBotChainExhaustedError,
  };
});

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
import { db, catalogPdfJobTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { extractPdfPages } from "../src/utils/pdfProcessor";
import { extractCatalogPage } from "../src/utils/catalogExtractor";
import { matchCatalogNumber } from "../src/utils/catalogMatcher";

// ── Typed mocks ───────────────────────────────────────────────────────────────
const mockExtractPdfPages = extractPdfPages as jest.MockedFunction<typeof extractPdfPages>;
const mockExtractCatalogPage = extractCatalogPage as jest.MockedFunction<typeof extractCatalogPage>;
const mockMatchCatalogNumber = matchCatalogNumber as jest.MockedFunction<typeof matchCatalogNumber>;

// ── Minimal valid PDF stub ────────────────────────────────────────────────────
// A real base64 %PDF-… header so validatePdfBase64 passes.
const STUB_PDF_HEADER = "%PDF-1.4\n%%EOF";
const STUB_PDF_B64 = Buffer.from(STUB_PDF_HEADER).toString("base64");

// ── Setup / teardown ──────────────────────────────────────────────────────────
const ADMIN_SECRET = "jest-chunk-secret";
let adminToken: string;
const seededIds: number[] = [];

async function seedJob(overrides: Partial<typeof catalogPdfJobTable.$inferInsert>): Promise<number> {
  const [row] = await db
    .insert(catalogPdfJobTable)
    .values({
      vendor: "JEST-VENDOR",
      filename: "jest-chunk-test.pdf",
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

/** Wait up to `maxMs` for a DB predicate to become true. */
async function waitForDb(
  check: () => Promise<boolean>,
  maxMs = 6000,
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
  // Default: each page returns no catalog entries (fast path)
  mockExtractCatalogPage.mockResolvedValue([]);
}, 15_000);

afterAll(async () => {
  if (seededIds.length > 0) {
    await db.delete(catalogPdfJobTable).where(inArray(catalogPdfJobTable.id, seededIds));
  }
  await closePool();
}, 15_000);

beforeEach(() => {
  jest.clearAllMocks();
  mockExtractCatalogPage.mockResolvedValue([]);
  mockMatchCatalogNumber.mockResolvedValue(null);
});

// ─────────────────────────────────────────────────────────────────────────────
// POST with chunk fields — request validation
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /api/admin/catalog-pdf — chunk field validation", () => {
  it("returns 400 for a negative chunkIndex", async () => {
    const res = await supertest(app)
      .post("/api/admin/catalog-pdf")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pdfBase64: STUB_PDF_B64, vendor: "EATON", chunkIndex: -1, chunkCount: 3 })
      .expect(400);
    expect(res.body.error).toMatch(/chunkIndex/i);
  });

  it("returns 400 for chunkIndex >= chunkCount", async () => {
    const res = await supertest(app)
      .post("/api/admin/catalog-pdf")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pdfBase64: STUB_PDF_B64, vendor: "EATON", chunkIndex: 3, chunkCount: 3 })
      .expect(400);
    expect(res.body.error).toMatch(/chunkIndex/i);
  });

  it("returns 400 for chunkCount < 1", async () => {
    const res = await supertest(app)
      .post("/api/admin/catalog-pdf")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pdfBase64: STUB_PDF_B64, vendor: "EATON", chunkIndex: 0, chunkCount: 0 })
      .expect(400);
    expect(res.body.error).toMatch(/chunkCount/i);
  });

  it("returns 400 for an invalid parentJobId on a non-first chunk", async () => {
    const res = await supertest(app)
      .post("/api/admin/catalog-pdf")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        pdfBase64: STUB_PDF_B64, vendor: "EATON",
        chunkIndex: 1, chunkCount: 3, parentJobId: "not-a-number",
      })
      .expect(400);
    expect(res.body.error).toMatch(/parentJobId/i);
  });

  it("returns 404 when parentJobId points to a non-existent job", async () => {
    const res = await supertest(app)
      .post("/api/admin/catalog-pdf")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        pdfBase64: STUB_PDF_B64, vendor: "EATON",
        chunkIndex: 1, chunkCount: 3, parentJobId: 999999999,
      })
      .expect(404);
    expect(res.body.error).toMatch(/parent/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST chunk 0 — parent job creation
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /api/admin/catalog-pdf — chunk 0 creates parent job", () => {
  it("returns { jobId, chunkJobId } for chunk 0", async () => {
    mockExtractPdfPages.mockResolvedValueOnce([]);

    const res = await supertest(app)
      .post("/api/admin/catalog-pdf")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        pdfBase64: STUB_PDF_B64,
        vendor: "EATON",
        filename: "chunk-test.pdf",
        chunkIndex: 0,
        chunkCount: 3,
        pageOffset: 0,
      })
      .expect(200);

    expect(res.body).toHaveProperty("jobId");
    expect(res.body).toHaveProperty("chunkJobId");
    expect(res.body.jobId).not.toBe(res.body.chunkJobId);

    const parentId = Number(res.body.jobId);
    const childId = Number(res.body.chunkJobId);
    seededIds.push(parentId, childId);

    // Parent row should have chunkCount set and no parentJobId
    const [parent] = await db
      .select()
      .from(catalogPdfJobTable)
      .where(eq(catalogPdfJobTable.id, parentId))
      .limit(1);
    expect(parent).toBeDefined();
    expect(parent!.chunkCount).toBe(3);
    expect(parent!.parentJobId).toBeNull();

    // Child row should have parentJobId pointing to parent
    const [child] = await db
      .select()
      .from(catalogPdfJobTable)
      .where(eq(catalogPdfJobTable.id, childId))
      .limit(1);
    expect(child).toBeDefined();
    expect(child!.parentJobId).toBe(parentId);
    expect(child!.chunkIndex).toBe(0);
    expect(child!.pageOffset).toBe(0);
  });

  it("stores vendor and filename on both parent and child jobs", async () => {
    mockExtractPdfPages.mockResolvedValueOnce([]);

    const res = await supertest(app)
      .post("/api/admin/catalog-pdf")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        pdfBase64: STUB_PDF_B64,
        vendor: "hubbell",
        filename: "hubbell-cat.pdf",
        chunkIndex: 0,
        chunkCount: 2,
        pageOffset: 0,
      })
      .expect(200);

    const parentId = Number(res.body.jobId);
    const childId = Number(res.body.chunkJobId);
    seededIds.push(parentId, childId);

    const [parent] = await db.select().from(catalogPdfJobTable).where(eq(catalogPdfJobTable.id, parentId)).limit(1);
    const [child] = await db.select().from(catalogPdfJobTable).where(eq(catalogPdfJobTable.id, childId)).limit(1);

    // Vendor is normalized to uppercase
    expect(parent!.vendor).toBe("HUBBELL");
    expect(child!.vendor).toBe("HUBBELL");
    expect(parent!.filename).toBe("hubbell-cat.pdf");
    expect(child!.filename).toBe("hubbell-cat.pdf");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST subsequent chunks — validate parentJobId usage
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /api/admin/catalog-pdf — subsequent chunks use parentJobId", () => {
  it("chunk 1 returns the same parentJobId as chunk 0", async () => {
    mockExtractPdfPages.mockResolvedValue([]);

    // chunk 0
    const r0 = await supertest(app)
      .post("/api/admin/catalog-pdf")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        pdfBase64: STUB_PDF_B64, vendor: "EATON", filename: "big.pdf",
        chunkIndex: 0, chunkCount: 2, pageOffset: 0,
      })
      .expect(200);

    const parentId = r0.body.jobId as string;
    seededIds.push(Number(parentId), Number(r0.body.chunkJobId));

    // chunk 1
    const r1 = await supertest(app)
      .post("/api/admin/catalog-pdf")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        pdfBase64: STUB_PDF_B64, vendor: "EATON", filename: "big.pdf",
        chunkIndex: 1, chunkCount: 2, pageOffset: 20, parentJobId: parentId,
      })
      .expect(200);

    seededIds.push(Number(r1.body.chunkJobId));

    expect(r1.body.jobId).toBe(parentId);
    expect(r1.body.chunkJobId).not.toBe(parentId);

    // Verify child 1 has correct fields
    const [child1] = await db
      .select()
      .from(catalogPdfJobTable)
      .where(eq(catalogPdfJobTable.id, Number(r1.body.chunkJobId)))
      .limit(1);
    expect(child1!.chunkIndex).toBe(1);
    expect(child1!.pageOffset).toBe(20);
    expect(child1!.parentJobId).toBe(Number(parentId));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /status — parent job aggregation
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /api/admin/catalog-pdf/:id/status — parent job aggregation", () => {
  it("aggregates processedPages / matchedParts / imagesMatched from children", async () => {
    // Create parent + 2 child jobs manually in DB
    const parentId = await seedJob({ chunkCount: 2, status: "processing" });
    await seedJob({
      parentJobId: parentId, chunkIndex: 0, chunkCount: 2, pageOffset: 0,
      status: "done", totalPages: 10, processedPages: 10, matchedParts: 5, imagesMatched: 2,
    });
    await seedJob({
      parentJobId: parentId, chunkIndex: 1, chunkCount: 2, pageOffset: 10,
      status: "processing", totalPages: 10, processedPages: 4, matchedParts: 2, imagesMatched: 0,
    });

    const res = await supertest(app)
      .get(`/api/admin/catalog-pdf/${parentId}/status`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.jobId).toBe(String(parentId));
    expect(res.body.processedPages).toBe(14); // 10 + 4
    expect(res.body.matchedParts).toBe(7);    // 5 + 2
    expect(res.body.imagesMatched).toBe(2);   // 2 + 0
    expect(res.body.totalPages).toBe(20);     // 10 + 10
  });

  it("reports status='processing' when any child is still running", async () => {
    const parentId = await seedJob({ chunkCount: 2, status: "processing" });
    await seedJob({
      parentJobId: parentId, chunkIndex: 0, chunkCount: 2, pageOffset: 0,
      status: "done", processedPages: 10, matchedParts: 3,
    });
    await seedJob({
      parentJobId: parentId, chunkIndex: 1, chunkCount: 2, pageOffset: 10,
      status: "pending", processedPages: 0, matchedParts: 0,
    });

    const res = await supertest(app)
      .get(`/api/admin/catalog-pdf/${parentId}/status`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.status).toBe("processing");
  });

  it("reports a child's errorMessage when any child has failed", async () => {
    const parentId = await seedJob({ chunkCount: 2, status: "failed" });
    await seedJob({
      parentJobId: parentId, chunkIndex: 0, chunkCount: 2, pageOffset: 0,
      status: "failed", errorMessage: "AI call timed out", processedPages: 5,
    });
    await seedJob({
      parentJobId: parentId, chunkIndex: 1, chunkCount: 2, pageOffset: 20,
      status: "pending", processedPages: 0,
    });

    const res = await supertest(app)
      .get(`/api/admin/catalog-pdf/${parentId}/status`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.errorMessage).toContain("AI call timed out");
  });

  it("aggregates partsFound and concatenates unmatchedParts from all children", async () => {
    const parentId = await seedJob({ chunkCount: 2, status: "processing" });
    await seedJob({
      parentJobId: parentId, chunkIndex: 0, chunkCount: 2, pageOffset: 0,
      status: "done",
      partsFound: 10,
      unmatchedParts: [
        { catalogNumber: "CHILD1-001", description: "Part A" },
        { catalogNumber: "CHILD1-002", description: "Part B" },
      ],
    });
    await seedJob({
      parentJobId: parentId, chunkIndex: 1, chunkCount: 2, pageOffset: 10,
      status: "done",
      partsFound: 8,
      unmatchedParts: [
        { catalogNumber: "CHILD2-001", description: "Part C" },
      ],
    });

    const res = await supertest(app)
      .get(`/api/admin/catalog-pdf/${parentId}/status`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.partsFound).toBe(18); // 10 + 8
    expect(res.body.unmatchedParts).toHaveLength(3); // 2 + 1
    const catalogNumbers = (res.body.unmatchedParts as Array<{ catalogNumber: string }>).map(
      (p) => p.catalogNumber,
    );
    expect(catalogNumbers).toContain("CHILD1-001");
    expect(catalogNumbers).toContain("CHILD1-002");
    expect(catalogNumbers).toContain("CHILD2-001");
  });

  it("querying a child job directly returns that child's own status", async () => {
    const parentId = await seedJob({ chunkCount: 1, status: "processing" });
    const childId = await seedJob({
      parentJobId: parentId, chunkIndex: 0, chunkCount: 1, pageOffset: 0,
      status: "processing", totalPages: 5, processedPages: 3, matchedParts: 1,
    });

    const res = await supertest(app)
      .get(`/api/admin/catalog-pdf/${childId}/status`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.jobId).toBe(String(childId));
    expect(res.body.processedPages).toBe(3);
    expect(res.body.matchedParts).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /resume — returns 409 for parent jobs
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /api/admin/catalog-pdf/:id/resume — parent jobs cannot be resumed", () => {
  it("returns 409 when resuming a parent job", async () => {
    const parentId = await seedJob({ chunkCount: 2, status: "failed" });

    const res = await supertest(app)
      .post(`/api/admin/catalog-pdf/${parentId}/resume`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pdfBase64: STUB_PDF_B64 })
      .expect(409);

    expect(res.body.error).toMatch(/chunk/i);
  });

  it("allows resuming a regular (non-chunked) failed job", async () => {
    mockExtractPdfPages.mockResolvedValueOnce([]);

    const legacyId = await seedJob({
      status: "failed",
      totalPages: 5, processedPages: 2, matchedParts: 1,
    });

    // Should NOT return 409
    const res = await supertest(app)
      .post(`/api/admin/catalog-pdf/${legacyId}/resume`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pdfBase64: STUB_PDF_B64 })
      .expect(200);

    expect(res.body.jobId).toBe(String(legacyId));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /failed-jobs — child jobs are excluded
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /api/admin/catalog-pdf/failed-jobs — excludes child jobs", () => {
  it("excludes a failed child job from the list", async () => {
    const parentId = await seedJob({ chunkCount: 2, status: "failed" });
    const childId = await seedJob({
      parentJobId: parentId, chunkIndex: 0, chunkCount: 2, pageOffset: 0,
      status: "failed", errorMessage: "AI call failed",
    });

    const res = await supertest(app)
      .get("/api/admin/catalog-pdf/failed-jobs")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    const ids = (res.body.jobs as Array<{ id: number }>).map((j) => j.id);
    // Parent job appears (it has no parentJobId)
    expect(ids).toContain(parentId);
    // Child job must NOT appear
    expect(ids).not.toContain(childId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// partsFound counter and unmatchedParts behavior
// ─────────────────────────────────────────────────────────────────────────────

// Minimal page shape accepted by processPdfPages / extractCatalogPage
const STUB_PAGE = { text: "", images: [] as Buffer[], isRendered: false as const, pageWidth: 0, pageHeight: 0 };

describe("partsFound counter and unmatchedParts behavior", () => {
  it("partsFound counts all AI-extracted entries including those below confidence threshold", async () => {
    mockExtractPdfPages.mockResolvedValueOnce([STUB_PAGE]);
    mockExtractCatalogPage.mockResolvedValueOnce([
      { catalogNumber: "HIGH-001", description: "Part A", confidence: 0.9, hasPartImage: false, imageRegion: null, imageRegion2: null, imageIndex: -1, imageIndex2: -1 },
      { catalogNumber: "HIGH-002", description: "Part B", confidence: 0.5, hasPartImage: false, imageRegion: null, imageRegion2: null, imageIndex: -1, imageIndex2: -1 },
      { catalogNumber: "LOW-003", description: "Part C", confidence: 0.3, hasPartImage: false, imageRegion: null, imageRegion2: null, imageIndex: -1, imageIndex2: -1 },
    ]);

    const res = await supertest(app)
      .post("/api/admin/catalog-pdf")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pdfBase64: STUB_PDF_B64, vendor: "EATON", filename: "partsFound-test.pdf" })
      .expect(200);

    const jobId = Number(res.body.jobId);
    seededIds.push(jobId);

    await waitForDb(async () => {
      const [row] = await db.select({ status: catalogPdfJobTable.status }).from(catalogPdfJobTable).where(eq(catalogPdfJobTable.id, jobId)).limit(1);
      return row?.status === "done";
    });

    const statusRes = await supertest(app)
      .get(`/api/admin/catalog-pdf/${jobId}/status`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(statusRes.body.partsFound).toBe(3);
  }, 15_000);

  it("entries with confidence < 0.4 do not appear in unmatchedParts", async () => {
    mockExtractPdfPages.mockResolvedValueOnce([STUB_PAGE]);
    mockExtractCatalogPage.mockResolvedValueOnce([
      { catalogNumber: "HIGH-001", description: "Part A", confidence: 0.9, hasPartImage: false, imageRegion: null, imageRegion2: null, imageIndex: -1, imageIndex2: -1 },
      { catalogNumber: "HIGH-002", description: "Part B", confidence: 0.4, hasPartImage: false, imageRegion: null, imageRegion2: null, imageIndex: -1, imageIndex2: -1 },
      { catalogNumber: "LOW-003", description: "Part C", confidence: 0.39, hasPartImage: false, imageRegion: null, imageRegion2: null, imageIndex: -1, imageIndex2: -1 },
      { catalogNumber: "LOW-004", description: "Part D", confidence: 0.1, hasPartImage: false, imageRegion: null, imageRegion2: null, imageIndex: -1, imageIndex2: -1 },
    ]);

    const res = await supertest(app)
      .post("/api/admin/catalog-pdf")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pdfBase64: STUB_PDF_B64, vendor: "EATON", filename: "confidence-filter-test.pdf" })
      .expect(200);

    const jobId = Number(res.body.jobId);
    seededIds.push(jobId);

    await waitForDb(async () => {
      const [row] = await db.select({ status: catalogPdfJobTable.status }).from(catalogPdfJobTable).where(eq(catalogPdfJobTable.id, jobId)).limit(1);
      return row?.status === "done";
    });

    const statusRes = await supertest(app)
      .get(`/api/admin/catalog-pdf/${jobId}/status`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    // All 4 entries count toward partsFound before the filter
    expect(statusRes.body.partsFound).toBe(4);

    // Only the 2 entries with confidence >= 0.4 appear in unmatchedParts
    const catalogNumbers = (statusRes.body.unmatchedParts as Array<{ catalogNumber: string }>).map(
      (p) => p.catalogNumber,
    );
    expect(catalogNumbers).toContain("HIGH-001");
    expect(catalogNumbers).toContain("HIGH-002");
    expect(catalogNumbers).not.toContain("LOW-003");
    expect(catalogNumbers).not.toContain("LOW-004");
  }, 15_000);

  it("caps unmatchedParts at 300 entries even when more parts are extracted", async () => {
    const entries = Array.from({ length: 305 }, (_, i) => ({
      catalogNumber: `PART-${String(i).padStart(4, "0")}`,
      description: `Part ${i}`,
      confidence: 0.8,
      hasPartImage: false as const,
      imageRegion: null,
      imageRegion2: null,
      imageIndex: -1,
      imageIndex2: -1,
    }));

    mockExtractPdfPages.mockResolvedValueOnce([STUB_PAGE]);
    mockExtractCatalogPage.mockResolvedValueOnce(entries);

    const res = await supertest(app)
      .post("/api/admin/catalog-pdf")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pdfBase64: STUB_PDF_B64, vendor: "EATON", filename: "cap-test.pdf" })
      .expect(200);

    const jobId = Number(res.body.jobId);
    seededIds.push(jobId);

    await waitForDb(async () => {
      const [row] = await db.select({ status: catalogPdfJobTable.status }).from(catalogPdfJobTable).where(eq(catalogPdfJobTable.id, jobId)).limit(1);
      return row?.status === "done";
    });

    const statusRes = await supertest(app)
      .get(`/api/admin/catalog-pdf/${jobId}/status`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(statusRes.body.partsFound).toBe(305);
    expect(statusRes.body.unmatchedParts).toHaveLength(300);
  }, 15_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Parent job atomic completion via finalizeParentIfComplete
// ─────────────────────────────────────────────────────────────────────────────
describe("parent job completion when all children finish", () => {
  it("marks parent as 'done' after the last child completes", async () => {
    mockExtractPdfPages.mockResolvedValue([]);

    // Upload chunk 0 (creates parent)
    const r0 = await supertest(app)
      .post("/api/admin/catalog-pdf")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        pdfBase64: STUB_PDF_B64, vendor: "EATON", filename: "test.pdf",
        chunkIndex: 0, chunkCount: 1, pageOffset: 0,
      })
      .expect(200);

    const parentId = Number(r0.body.jobId);
    const childId = Number(r0.body.chunkJobId);
    seededIds.push(parentId, childId);

    // Wait for both child and parent to reach 'done'
    await waitForDb(async () => {
      const [parent] = await db
        .select({ status: catalogPdfJobTable.status })
        .from(catalogPdfJobTable)
        .where(eq(catalogPdfJobTable.id, parentId))
        .limit(1);
      return parent?.status === "done";
    });

    const [parent] = await db.select().from(catalogPdfJobTable).where(eq(catalogPdfJobTable.id, parentId)).limit(1);
    expect(parent!.status).toBe("done");
  }, 15_000);

  it("legacy single-upload (no chunk fields) still returns { jobId } and completes", async () => {
    mockExtractPdfPages.mockResolvedValueOnce([]);

    const res = await supertest(app)
      .post("/api/admin/catalog-pdf")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pdfBase64: STUB_PDF_B64, vendor: "EATON", filename: "legacy.pdf" })
      .expect(200);

    // Legacy response shape has no chunkJobId
    expect(res.body).toHaveProperty("jobId");
    expect(res.body).not.toHaveProperty("chunkJobId");

    const jobId = Number(res.body.jobId);
    seededIds.push(jobId);

    await waitForDb(async () => {
      const [row] = await db
        .select({ status: catalogPdfJobTable.status })
        .from(catalogPdfJobTable)
        .where(eq(catalogPdfJobTable.id, jobId))
        .limit(1);
      return row?.status === "done";
    });
  }, 15_000);
});
