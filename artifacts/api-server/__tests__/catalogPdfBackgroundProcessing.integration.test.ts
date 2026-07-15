/**
 * Integration tests verifying that POST /admin/catalog-pdf returns immediately
 * even when extractPdfPages and processPdfPages are slow.
 *
 * Both extractPdfPages (full PDF rendering) and the per-page AI loop
 * (extractCatalogPage) now run inside a setImmediate background task. The HTTP
 * handler only does a fast validatePdf check before responding with 200.
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
import { eq, inArray, sql } from "drizzle-orm";
import { extractPdfPages } from "../src/utils/pdfProcessor";
import { extractCatalogPage } from "../src/utils/catalogExtractor";

// ── Typed mock handles ─────────────────────────────────────────────────────────

const mockExtractPdfPages = extractPdfPages as jest.MockedFunction<typeof extractPdfPages>;
const mockExtractCatalogPage = extractCatalogPage as jest.MockedFunction<typeof extractCatalogPage>;

// ── Constants ─────────────────────────────────────────────────────────────────

const ADMIN_SECRET = "jest-bg-processing-secret";
const VENDOR = "JEST-BG-PROC-VENDOR";
const FAKE_PDF_BASE64 = Buffer.alloc(16).toString("base64");

const ONE_FAKE_PAGE = [
  { pageNum: 1, text: "page text", images: [], isRendered: false, pageWidth: 0, pageHeight: 0 },
];

const RESPONSE_DEADLINE_MS = 2_000;

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
    await db.execute(sql`
      UPDATE catalog_pdf_job
      SET status = 'cancelled', finished_at = NOW()
      WHERE id = ANY(${seededJobIds})
        AND status IN ('pending', 'processing')
    `).catch(() => null);

    await db
      .delete(catalogPdfJobTable)
      .where(inArray(catalogPdfJobTable.id, seededJobIds))
      .catch(() => null);
  }
}, 15_000);

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1: POST responds before extractPdfPages finishes
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /catalog-pdf — responds before extractPdfPages finishes", () => {
  it("responds within 2 seconds even when extractPdfPages never resolves within the test window", async () => {
    // validatePdf passes (mocked to no-op), extractPdfPages never resolves —
    // simulating a hung pdftoppm call for a very large PDF.
    mockExtractPdfPages.mockImplementation(() => new Promise(() => {}));

    const start = Date.now();

    const res = await supertest(app)
      .post("/api/admin/catalog-pdf")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pdfBase64: FAKE_PDF_BASE64, vendor: VENDOR })
      .timeout(RESPONSE_DEADLINE_MS + 500);

    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("jobId");
    expect(res.body.message).toMatch(/job started/i);
    expect(elapsed).toBeLessThan(RESPONSE_DEADLINE_MS);

    seededJobIds.push(Number(res.body.jobId));
  });

  it("returns the jobId before extractPdfPages completes on a chunked upload", async () => {
    const [parentRow] = await db
      .insert(catalogPdfJobTable)
      .values({
        vendor: VENDOR,
        filename: "bg-test-slow-extract.pdf",
        status: "pending",
        processedPages: 0,
        matchedParts: 0,
        chunkCount: 2,
      })
      .returning({ id: catalogPdfJobTable.id });
    if (!parentRow) throw new Error("Failed to seed parent job");
    seededJobIds.push(parentRow.id);

    mockExtractPdfPages.mockImplementation(() => new Promise(() => {}));

    const start = Date.now();

    const res = await supertest(app)
      .post("/api/admin/catalog-pdf")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        pdfBase64: FAKE_PDF_BASE64,
        vendor: VENDOR,
        chunkIndex: 0,
        chunkCount: 2,
        parentJobId: parentRow.id,
      })
      .expect(200)
      .timeout(RESPONSE_DEADLINE_MS + 500);

    const elapsed = Date.now() - start;

    expect(res.body.jobId).toBe(String(parentRow.id));
    expect(res.body).toHaveProperty("chunkJobId");
    expect(elapsed).toBeLessThan(RESPONSE_DEADLINE_MS);

    seededJobIds.push(Number(res.body.chunkJobId));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2: POST responds before processPdfPages (extractCatalogPage) finishes
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /catalog-pdf — responds before processPdfPages finishes", () => {
  it("responds within 2 seconds even when extractCatalogPage never resolves", async () => {
    mockExtractPdfPages.mockResolvedValueOnce(ONE_FAKE_PAGE);
    mockExtractCatalogPage.mockImplementation(() => new Promise(() => {}));

    const start = Date.now();

    const res = await supertest(app)
      .post("/api/admin/catalog-pdf")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pdfBase64: FAKE_PDF_BASE64, vendor: VENDOR })
      .timeout(RESPONSE_DEADLINE_MS + 500);

    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("jobId");
    expect(elapsed).toBeLessThan(RESPONSE_DEADLINE_MS);

    seededJobIds.push(Number(res.body.jobId));
  });

  it("job has status=processing immediately after the 200 response is received", async () => {
    mockExtractPdfPages.mockResolvedValueOnce(ONE_FAKE_PAGE);
    let releaseProcessing: (() => void) | null = null;
    mockExtractCatalogPage.mockImplementation(
      () => new Promise<never>((_r) => { releaseProcessing = _r as () => void; }),
    );

    const res = await supertest(app)
      .post("/api/admin/catalog-pdf")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pdfBase64: FAKE_PDF_BASE64, vendor: VENDOR })
      .expect(200)
      .timeout(RESPONSE_DEADLINE_MS + 500);

    const jobId = Number(res.body.jobId);
    seededJobIds.push(jobId);

    // Allow the background setImmediate to fire.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const [row] = await db
      .select({ status: catalogPdfJobTable.status })
      .from(catalogPdfJobTable)
      .where(eq(catalogPdfJobTable.id, jobId))
      .limit(1);

    expect(row?.status).toBe("processing");

    if (releaseProcessing) (releaseProcessing as () => void)();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 3: Resume endpoint also responds immediately
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /catalog-pdf/:jobId/resume — responds immediately", () => {
  async function seedFailedJob(): Promise<number> {
    const [row] = await db
      .insert(catalogPdfJobTable)
      .values({
        vendor: VENDOR,
        filename: "bg-resume-test.pdf",
        status: "failed",
        processedPages: 0,
        matchedParts: 0,
        errorMessage: "Simulated prior failure",
      })
      .returning({ id: catalogPdfJobTable.id });
    if (!row) throw new Error("Failed to seed job");
    seededJobIds.push(row.id);
    return row.id;
  }

  it("responds within 2 seconds even when extractPdfPages never resolves", async () => {
    const jobId = await seedFailedJob();
    mockExtractPdfPages.mockImplementation(() => new Promise(() => {}));

    const start = Date.now();

    const res = await supertest(app)
      .post(`/api/admin/catalog-pdf/${jobId}/resume`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pdfBase64: FAKE_PDF_BASE64 })
      .timeout(RESPONSE_DEADLINE_MS + 500);

    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    expect(String(res.body.jobId)).toBe(String(jobId));
    expect(elapsed).toBeLessThan(RESPONSE_DEADLINE_MS);
  });
});
