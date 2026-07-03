/**
 * Integration tests for GET /api/admin/catalog-pdf/:jobId/status.
 *
 * Seeds catalog_pdf_job rows directly in the DB (bypassing the in-memory
 * activeJobs map, which only exists at POST time) to verify the DB fallback
 * path returns the correct shape for each status value.
 */

// ── Mock OpenAI BEFORE app is imported ────────────────────────────────────────
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

// ── Imports ───────────────────────────────────────────────────────────────────
import supertest from "supertest";
import app from "../src/app";
import { signAdminToken } from "./helpers/adminAuth";
import { closePool } from "./helpers/testDb";
import { db, catalogPdfJobTable } from "@workspace/db";
import { inArray } from "drizzle-orm";

// ── Setup / teardown ──────────────────────────────────────────────────────────
const ADMIN_SECRET = "jest-pdf-status-secret";
let adminToken: string;
const seededIds: number[] = [];

async function seedJob(overrides: {
  status: string;
  totalPages?: number;
  processedPages?: number;
  matchedParts?: number;
  errorMessage?: string | null;
}): Promise<number> {
  const [row] = await db
    .insert(catalogPdfJobTable)
    .values({
      vendor: "JEST-VENDOR",
      filename: "jest-test.pdf",
      status: overrides.status,
      totalPages: overrides.totalPages ?? 0,
      processedPages: overrides.processedPages ?? 0,
      matchedParts: overrides.matchedParts ?? 0,
      errorMessage: overrides.errorMessage ?? null,
    })
    .returning({ id: catalogPdfJobTable.id });
  if (!row) throw new Error("Failed to seed job");
  seededIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  adminToken = signAdminToken(Date.now(), ADMIN_SECRET);
}, 15_000);

afterAll(async () => {
  if (seededIds.length > 0) {
    await db
      .delete(catalogPdfJobTable)
      .where(inArray(catalogPdfJobTable.id, seededIds));
  }
  await closePool();
}, 15_000);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/catalog-pdf/:jobId/status — auth checks
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/admin/catalog-pdf/:jobId/status — auth", () => {
  it("returns 401 when no Authorization header is provided", async () => {
    const res = await supertest(app)
      .get("/api/admin/catalog-pdf/1/status")
      .expect(401);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 403 when an invalid (unknown) token is provided", async () => {
    const res = await supertest(app)
      .get("/api/admin/catalog-pdf/1/status")
      .set("Authorization", "Bearer bad-token-xyz")
      .expect(403);

    expect(res.body).toHaveProperty("error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/catalog-pdf/:jobId/status — DB fallback path
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/admin/catalog-pdf/:jobId/status — DB fallback", () => {
  it("returns 404 for a job ID that does not exist", async () => {
    const res = await supertest(app)
      .get("/api/admin/catalog-pdf/999999999/status")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(404);

    expect(res.body).toHaveProperty("error");
  });

  it("returns correct shape for a 'pending' job", async () => {
    const id = await seedJob({ status: "pending" });

    const res = await supertest(app)
      .get(`/api/admin/catalog-pdf/${id}/status`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.jobId).toBe(String(id));
    expect(res.body.status).toBe("pending");
    expect(typeof res.body.processedPages).toBe("number");
    expect(typeof res.body.matchedParts).toBe("number");
    expect(res.body).toHaveProperty("totalPages");
    expect(res.body).toHaveProperty("startedAt");
    expect(res.body).toHaveProperty("finishedAt");
    expect(res.body).toHaveProperty("errorMessage");
  });

  it("returns correct shape and status for a 'processing' job", async () => {
    const id = await seedJob({
      status: "processing",
      totalPages: 20,
      processedPages: 5,
      matchedParts: 3,
    });

    const res = await supertest(app)
      .get(`/api/admin/catalog-pdf/${id}/status`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.status).toBe("processing");
    expect(res.body.totalPages).toBe(20);
    expect(res.body.processedPages).toBe(5);
    expect(res.body.matchedParts).toBe(3);
  });

  it("returns correct shape for a 'done' job", async () => {
    const id = await seedJob({
      status: "done",
      totalPages: 10,
      processedPages: 10,
      matchedParts: 7,
    });

    const res = await supertest(app)
      .get(`/api/admin/catalog-pdf/${id}/status`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.status).toBe("done");
    expect(res.body.totalPages).toBe(10);
    expect(res.body.processedPages).toBe(10);
    expect(res.body.matchedParts).toBe(7);
    expect(res.body.errorMessage).toBeNull();
  });

  it("returns correct shape for a 'failed' job, including errorMessage", async () => {
    const id = await seedJob({
      status: "failed",
      errorMessage: "PDF could not be parsed",
    });

    const res = await supertest(app)
      .get(`/api/admin/catalog-pdf/${id}/status`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.status).toBe("failed");
    expect(res.body.errorMessage).toBe("PDF could not be parsed");
  });
});
