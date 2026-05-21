/**
 * Integration tests for PDF job progress persistence.
 *
 * Verifies that:
 *   1. After each page is processed, the DB row reflects the latest
 *      processedPages and matchedParts counts (not just at the end of the job).
 *   2. The status endpoint returns DB-accurate counts even when there is no
 *      in-memory state (simulating a server restart mid-job, where the old
 *      activeJobs Map would have been lost).
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
import { db, catalogPdfJobTable, inventoryTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { extractPdfPages } from "../src/utils/pdfProcessor";
import { extractCatalogPage } from "../src/utils/catalogExtractor";
import { matchCatalogNumber } from "../src/utils/catalogMatcher";

// ── Typed mock handles ─────────────────────────────────────────────────────────

const mockExtractPdfPages = extractPdfPages as jest.MockedFunction<typeof extractPdfPages>;
const mockExtractCatalogPage = extractCatalogPage as jest.MockedFunction<typeof extractCatalogPage>;
const mockMatchCatalogNumber = matchCatalogNumber as jest.MockedFunction<typeof matchCatalogNumber>;

// ── Constants ─────────────────────────────────────────────────────────────────

const ADMIN_SECRET = "jest-pdf-progress-secret";
const VENDOR = "JEST-PROGRESS-VENDOR";

/** Minimal valid 1-byte base64 payload (POST route only validates presence). */
const FAKE_PDF_BASE64 = Buffer.alloc(16).toString("base64");

// ── Seeded row IDs collected for cleanup ──────────────────────────────────────

let adminToken: string;
const seededJobIds: number[] = [];
const seededInventoryIds: number[] = [];

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Seed a single inventory row and record its id for cleanup. */
async function seedInventoryItem(catalog: string): Promise<number> {
  const [row] = await db
    .insert(inventoryTable)
    .values({
      vendor: VENDOR,
      catalog,
      description: `Jest progress test item ${catalog}`,
      binLocations: [],
      aiKeywords: [],
    })
    .returning({ id: inventoryTable.id });
  if (!row) throw new Error("Failed to seed inventory item");
  seededInventoryIds.push(row.id);
  return row.id;
}

/** Read the current processedPages and matchedParts for a job from the DB. */
async function readJobProgress(
  jobId: number,
): Promise<{ processedPages: number; matchedParts: number; status: string }> {
  const [row] = await db
    .select({
      processedPages: catalogPdfJobTable.processedPages,
      matchedParts: catalogPdfJobTable.matchedParts,
      status: catalogPdfJobTable.status,
    })
    .from(catalogPdfJobTable)
    .where(eq(catalogPdfJobTable.id, jobId))
    .limit(1);
  if (!row) throw new Error(`Job ${jobId} not found in DB`);
  return row;
}

/**
 * Poll the status endpoint until the job reaches a terminal state.
 * Throws if the job does not complete within the given timeout.
 */
async function waitForJobDone(
  jobId: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await supertest(app)
      .get(`/api/admin/catalog-pdf/${jobId}/status`)
      .set("Authorization", `Bearer ${adminToken}`);
    const { status } = res.body as { status: string };
    if (status === "done" || status === "failed") return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Job ${jobId} did not reach a terminal state within ${timeoutMs}ms`);
}

/**
 * POST to the catalog-pdf endpoint and return the jobId.
 * Records the created job ID for cleanup.
 */
async function startJob(): Promise<string> {
  const res = await supertest(app)
    .post("/api/admin/catalog-pdf")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ pdfBase64: FAKE_PDF_BASE64, vendor: VENDOR })
    .expect(200);

  const { jobId } = res.body as { jobId: string };
  seededJobIds.push(Number(jobId));
  return jobId;
}

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
  if (seededInventoryIds.length > 0) {
    await db
      .delete(inventoryTable)
      .where(inArray(inventoryTable.id, seededInventoryIds));
  }
  await closePool();
}, 15_000);

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1: DB row updated after each page
// ─────────────────────────────────────────────────────────────────────────────

describe("PDF job progress — DB updated per page", () => {
  it("persists processedPages=1 to the DB after the first page, before the second page begins", async () => {
    // Two pages, no catalog entries — we only care that page-count is written per page.
    mockExtractPdfPages.mockResolvedValueOnce([
      { pageNum: 1, text: "page one text", images: [], isRendered: false, pageWidth: 0, pageHeight: 0 },
      { pageNum: 2, text: "page two text", images: [], isRendered: false, pageWidth: 0, pageHeight: 0 },
    ]);

    // Capture the DB state at the moment page 2 starts processing.
    // At that point the page-1 DB update must already be committed.
    const stateAtStartOfPage2: { processedPages: number; matchedParts: number } = {
      processedPages: -1,
      matchedParts: -1,
    };
    let callCount = 0;

    mockExtractCatalogPage.mockImplementation(async (_text, _images, _vendor) => {
      callCount++;
      if (callCount === 2) {
        // Page 1 has already finished and its DB update has been awaited.
        const jobId = seededJobIds[seededJobIds.length - 1];
        if (jobId !== undefined) {
          const row = await readJobProgress(jobId);
          stateAtStartOfPage2.processedPages = row.processedPages;
          stateAtStartOfPage2.matchedParts = row.matchedParts;
        }
      }
      return [];
    });

    const jobId = await startJob();
    await waitForJobDone(jobId);

    // The DB state captured at the start of page 2 must show page 1 already counted.
    expect(stateAtStartOfPage2.processedPages).toBe(1);
    expect(stateAtStartOfPage2.matchedParts).toBe(0);

    // After the job is done both pages must be counted.
    const finalState = await readJobProgress(Number(jobId));
    expect(finalState.processedPages).toBe(2);
    expect(finalState.matchedParts).toBe(0);
    expect(finalState.status).toBe("done");
  });

  it("increments matchedParts in the DB after each page that yields a match", async () => {
    // Seed one inventory item that can be matched.
    const inventoryId = await seedInventoryItem("JEST-PGS-PART-001");

    // Two pages: page 1 yields one match, page 2 yields no matches.
    mockExtractPdfPages.mockResolvedValueOnce([
      { pageNum: 1, text: "part info", images: [], isRendered: false, pageWidth: 0, pageHeight: 0 },
      { pageNum: 2, text: "no parts here", images: [], isRendered: false, pageWidth: 0, pageHeight: 0 },
    ]);

    mockMatchCatalogNumber.mockResolvedValueOnce({
      inventoryId,
      similarityScore: 0.9,
    });

    // Capture the DB state at the start of page 2 (after page 1 + its match are persisted).
    // A single mockImplementation handles all page calls so Jest's once-queue never
    // takes precedence and the capturing logic always runs on the second call.
    const stateAtStartOfPage2: { processedPages: number; matchedParts: number } = {
      processedPages: -1,
      matchedParts: -1,
    };
    let callCount = 0;

    mockExtractCatalogPage.mockImplementation(async () => {
      callCount++;
      if (callCount === 2) {
        // Page 1 has already finished and its per-page DB update has been awaited.
        const jobId = seededJobIds[seededJobIds.length - 1];
        if (jobId !== undefined) {
          const row = await readJobProgress(jobId);
          stateAtStartOfPage2.processedPages = row.processedPages;
          stateAtStartOfPage2.matchedParts = row.matchedParts;
        }
        return [];
      }
      // First call: return the fixture entry so matchCatalogNumber fires.
      return [
        { catalogNumber: "JEST-PGS-PART-001", description: "Jest Test Part", confidence: 0.95, hasPartImage: false, imageRegion: null },
      ];
    });

    const jobId = await startJob();
    await waitForJobDone(jobId);

    // After page 1: processedPages=1, matchedParts=1 — captured at start of page 2.
    expect(stateAtStartOfPage2.processedPages).toBe(1);
    expect(stateAtStartOfPage2.matchedParts).toBe(1);

    // Final state after both pages.
    const finalState = await readJobProgress(Number(jobId));
    expect(finalState.processedPages).toBe(2);
    expect(finalState.matchedParts).toBe(1);
    expect(finalState.status).toBe("done");
  });

  it("persists processedPages after every page of a three-page job", async () => {
    mockExtractPdfPages.mockResolvedValueOnce([
      { pageNum: 1, text: "p1", images: [], isRendered: false, pageWidth: 0, pageHeight: 0 },
      { pageNum: 2, text: "p2", images: [], isRendered: false, pageWidth: 0, pageHeight: 0 },
      { pageNum: 3, text: "p3", images: [], isRendered: false, pageWidth: 0, pageHeight: 0 },
    ]);

    // Capture processedPages at the start of pages 2 and 3.
    const capturedCounts: number[] = [];
    let callCount = 0;

    mockExtractCatalogPage.mockImplementation(async () => {
      callCount++;
      if (callCount >= 2) {
        const jobId = seededJobIds[seededJobIds.length - 1];
        if (jobId !== undefined) {
          const row = await readJobProgress(jobId);
          capturedCounts.push(row.processedPages);
        }
      }
      return [];
    });

    const jobId = await startJob();
    await waitForJobDone(jobId);

    // At the start of page 2, processedPages should be 1.
    // At the start of page 3, processedPages should be 2.
    expect(capturedCounts).toEqual([1, 2]);

    const finalState = await readJobProgress(Number(jobId));
    expect(finalState.processedPages).toBe(3);
    expect(finalState.status).toBe("done");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2: Status endpoint returns DB-accurate counts (restart simulation)
// ─────────────────────────────────────────────────────────────────────────────

describe("PDF job status endpoint — DB-accurate counts after simulated restart", () => {
  it("returns the correct processedPages and matchedParts from the DB when no in-memory state exists", async () => {
    // A two-page job with no matches completes and its progress is in the DB.
    mockExtractPdfPages.mockResolvedValueOnce([
      { pageNum: 1, text: "p1", images: [], isRendered: false, pageWidth: 0, pageHeight: 0 },
      { pageNum: 2, text: "p2", images: [], isRendered: false, pageWidth: 0, pageHeight: 0 },
    ]);
    mockExtractCatalogPage.mockResolvedValue([]);

    const jobId = await startJob();
    await waitForJobDone(jobId);

    // Simulate a restart: there is no in-memory state for this job at all.
    // The status endpoint must read exclusively from the DB.
    const res = await supertest(app)
      .get(`/api/admin/catalog-pdf/${jobId}/status`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.jobId).toBe(jobId);
    expect(res.body.status).toBe("done");
    expect(res.body.processedPages).toBe(2);
    expect(res.body.matchedParts).toBe(0);
    expect(res.body.totalPages).toBe(2);
  });

  it("returns DB-accurate matchedParts from the status endpoint after the job completes", async () => {
    const inventoryId = await seedInventoryItem("JEST-PGS-PART-002");

    mockExtractPdfPages.mockResolvedValueOnce([
      { pageNum: 1, text: "part page", images: [], isRendered: false, pageWidth: 0, pageHeight: 0 },
    ]);
    mockExtractCatalogPage.mockResolvedValueOnce([
      { catalogNumber: "JEST-PGS-PART-002", description: "Another Jest Part", confidence: 0.9, hasPartImage: false, imageRegion: null },
    ]);
    mockMatchCatalogNumber.mockResolvedValueOnce({
      inventoryId,
      similarityScore: 0.85,
    });

    const jobId = await startJob();
    await waitForJobDone(jobId);

    const res = await supertest(app)
      .get(`/api/admin/catalog-pdf/${jobId}/status`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.status).toBe("done");
    expect(res.body.processedPages).toBe(1);
    expect(res.body.matchedParts).toBe(1);
  });

  it("returns the DB state for a job that was seeded directly (no POST, simulating restart from persisted row)", async () => {
    // Insert a completed job row directly — as if the server restarted after
    // completion and someone asks for its status with no in-memory entry.
    const [row] = await db
      .insert(catalogPdfJobTable)
      .values({
        vendor: VENDOR,
        filename: "restart-sim.pdf",
        status: "done",
        totalPages: 5,
        processedPages: 5,
        matchedParts: 3,
        errorMessage: null,
      })
      .returning({ id: catalogPdfJobTable.id });
    if (!row) throw new Error("Failed to seed job row");
    seededJobIds.push(row.id);

    const res = await supertest(app)
      .get(`/api/admin/catalog-pdf/${row.id}/status`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.jobId).toBe(String(row.id));
    expect(res.body.status).toBe("done");
    expect(res.body.totalPages).toBe(5);
    expect(res.body.processedPages).toBe(5);
    expect(res.body.matchedParts).toBe(3);
    expect(res.body.errorMessage).toBeNull();
  });
});
