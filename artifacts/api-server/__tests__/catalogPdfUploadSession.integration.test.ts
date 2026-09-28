/**
 * Adversarial contract coverage for the durable catalog PDF upload boundary.
 * Storage is an in-memory private namespace here; the production adapter is
 * exercised by its own integration and deployment checks.
 */
const staged = new Map<string, Buffer>();

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

jest.mock("../src/lib/poeBot", () => {
  const actual = jest.requireActual<typeof import("../src/lib/poeBot")>("../src/lib/poeBot");
  return {
    ...actual,
    tryPoeBotChain: jest.fn(async (_feature: unknown, fn: (client: unknown, model: string) => unknown) =>
      fn({ chat: { completions: { create: jest.fn() } } }, "test-model"),
    ),
  };
});

jest.mock("../src/lib/objectStorage", () => ({
  uploadCatalogImage: jest.fn(),
  writeCatalogPdfPart: jest.fn(async (sessionId: string, index: number, bytes: Buffer) => {
    const key = `${sessionId}/${index}`;
    if (staged.has(key)) throw new Error("already exists");
    staged.set(key, Buffer.from(bytes));
    return `/private/${key}`;
  }),
  readCatalogPdfPart: jest.fn(async (sessionId: string, index: number) => {
    const bytes = staged.get(`${sessionId}/${index}`);
    if (!bytes) throw new Error("missing staged object");
    return bytes;
  }),
  deleteCatalogPdfPart: jest.fn(async (sessionId: string, index: number) => {
    staged.delete(`${sessionId}/${index}`);
  }),
}));

jest.mock("../src/utils/pdfProcessor", () => ({
  extractPdfPages: jest.fn(async () => []),
  validatePdf: jest.fn(),
}));

import { createHash } from "node:crypto";
import supertest from "supertest";
import { eq, inArray } from "drizzle-orm";

import app from "../src/app";
import { deleteCatalogPdfPart } from "../src/lib/objectStorage";
import { awaitJobTermination } from "../src/routes/catalogPdf";
import { recoverCatalogPdfUploadSessions } from "../src/routes/catalogPdfUpload";
import { ADMIN_TEST_USER_ID, signAdminToken } from "./helpers/adminAuth";
import {
  catalogPdfUploadPartTable,
  catalogPdfUploadSessionTable,
  db,
} from "@workspace/db";
import { bestEffortFixtureCleanup } from "./helpers/testDb";

const adminToken = signAdminToken();
const auth = { Authorization: `Bearer ${adminToken}` };

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("durable catalog PDF upload session", () => {
  const sessionIds: string[] = [];

  afterEach(async () => {
    if (sessionIds.length > 0) {
      await bestEffortFixtureCleanup("catalog PDF upload parts", async () => {
        await db.delete(catalogPdfUploadPartTable)
          .where(inArray(catalogPdfUploadPartTable.sessionId, sessionIds));
      });
      await bestEffortFixtureCleanup("catalog PDF upload sessions", async () => {
        await db.delete(catalogPdfUploadSessionTable)
          .where(inArray(catalogPdfUploadSessionTable.id, sessionIds));
      });
    }
    staged.clear();
    sessionIds.length = 0;
  });

  it("validates ranges/checksums, converges identical retries, isolates owners, and completes once", async () => {
    const pdf = Buffer.from("%PDF-1.4\n%%EOF");
    const start = await supertest(app)
      .post("/api/admin/catalog-pdf/upload-sessions")
      .set(auth)
      .send({
        vendor: "EATON",
        filename: "catalog.pdf",
        totalBytes: pdf.length,
        partSize: 4,
        fileSha256: sha256(pdf),
      })
      .expect(201);
    const sessionId = start.body.sessionId as string;
    sessionIds.push(sessionId);
    expect(start.body).toMatchObject({
      status: "open",
      totalBytes: pdf.length,
      partSize: 4,
      partCount: Math.ceil(pdf.length / 4),
    });

    await supertest(app)
      .put(`/api/admin/catalog-pdf/upload-sessions/${sessionId}/parts/0`)
      .set(auth)
      .set("Content-Type", "application/octet-stream")
      .set("Content-Range", `bytes 0-3/${pdf.length}`)
      .set("X-Part-SHA256", sha256(pdf.subarray(0, 4)))
      .send(pdf.subarray(0, 4))
      .expect(201);

    await supertest(app)
      .put(`/api/admin/catalog-pdf/upload-sessions/${sessionId}/parts/0`)
      .set(auth)
      .set("Content-Type", "application/octet-stream")
      .set("Content-Range", `bytes 0-3/${pdf.length}`)
      .set("X-Part-SHA256", sha256(pdf.subarray(0, 4)))
      .send(pdf.subarray(0, 4))
      .expect(200);

    await supertest(app)
      .put(`/api/admin/catalog-pdf/upload-sessions/${sessionId}/parts/0`)
      .set(auth)
      .set("Content-Type", "application/octet-stream")
      .set("Content-Range", `bytes 0-3/${pdf.length}`)
      .set("X-Part-SHA256", sha256(pdf.subarray(0, 4)))
      .send(Buffer.from("nope"))
      .expect((response) => {
        expect(response.status).toBe(400);
        expect(response.body.code).toBe("CHECKSUM_MISMATCH");
      });

    await db.update(catalogPdfUploadSessionTable)
      .set({ ownerClerkUserId: "different-owner" })
      .where(eq(catalogPdfUploadSessionTable.id, sessionId));
    await supertest(app)
      .get(`/api/admin/catalog-pdf/upload-sessions/${sessionId}`)
      .set(auth)
      .expect(404);
    await db.update(catalogPdfUploadSessionTable)
      .set({ ownerClerkUserId: ADMIN_TEST_USER_ID })
      .where(eq(catalogPdfUploadSessionTable.id, sessionId));

    for (let index = 1; index < Math.ceil(pdf.length / 4); index++) {
      const offset = index * 4;
      const part = pdf.subarray(offset, Math.min(pdf.length, offset + 4));
      await supertest(app)
        .put(`/api/admin/catalog-pdf/upload-sessions/${sessionId}/parts/${index}`)
        .set(auth)
        .set("Content-Type", "application/octet-stream")
        .set("Content-Range", `bytes ${offset}-${offset + part.length - 1}/${pdf.length}`)
        .set("X-Part-SHA256", sha256(part))
        .send(part)
        .expect(201);
    }

    const firstComplete = await supertest(app)
      .post(`/api/admin/catalog-pdf/upload-sessions/${sessionId}/complete`)
      .set(auth)
      .send({})
      .expect(200);
    expect(firstComplete.body.jobId).toEqual(expect.any(String));
    await awaitJobTermination(Number(firstComplete.body.jobId));

    const secondComplete = await supertest(app)
      .post(`/api/admin/catalog-pdf/upload-sessions/${sessionId}/complete`)
      .set(auth)
      .send({})
      .expect(200);
    expect(secondComplete.body.jobId).toBe(firstComplete.body.jobId);

    const status = await supertest(app)
      .get(`/api/admin/catalog-pdf/upload-sessions/${sessionId}`)
      .set(auth)
      .expect(200);
    expect(status.body).toMatchObject({
      status: "completed",
      uploadedBytes: pdf.length,
      uploadedParts: Math.ceil(pdf.length / 4),
      processingJobId: firstComplete.body.jobId,
      missingPartIndices: [],
    });
  });

  it("does not finalize an incomplete manifest and cancels staged data repeatably", async () => {
    const pdf = Buffer.from("%PDF-1.4\n%%EOF");
    const start = await supertest(app)
      .post("/api/admin/catalog-pdf/upload-sessions")
      .set(auth)
      .send({ vendor: "EATON", totalBytes: pdf.length, partSize: 4 })
      .expect(201);
    const sessionId = start.body.sessionId as string;
    sessionIds.push(sessionId);

    await supertest(app)
      .post(`/api/admin/catalog-pdf/upload-sessions/${sessionId}/complete`)
      .set(auth)
      .send({})
      .expect((response) => {
        expect(response.status).toBe(409);
        expect(response.body.code).toBe("MISSING_PARTS");
      });

    await supertest(app)
      .post(`/api/admin/catalog-pdf/upload-sessions/${sessionId}/cancel`)
      .set(auth)
      .expect(200);
    await supertest(app)
      .post(`/api/admin/catalog-pdf/upload-sessions/${sessionId}/cancel`)
      .set(auth)
      .expect(200);

    const cancelled = await supertest(app)
      .get(`/api/admin/catalog-pdf/upload-sessions/${sessionId}`)
      .set(auth)
      .expect(200);
    expect(cancelled.body.status).toBe("cancelled");
  });

  it("reconciles a committed cancellation after object deletion fails without a client retry", async () => {
    const part = Buffer.from("%PDF");
    const start = await supertest(app)
      .post("/api/admin/catalog-pdf/upload-sessions")
      .set(auth)
      .send({ vendor: "EATON", totalBytes: part.length, partSize: part.length })
      .expect(201);
    const sessionId = start.body.sessionId as string;
    sessionIds.push(sessionId);

    await supertest(app)
      .put(`/api/admin/catalog-pdf/upload-sessions/${sessionId}/parts/0`)
      .set(auth)
      .set("Content-Type", "application/octet-stream")
      .set("Content-Range", `bytes 0-${part.length - 1}/${part.length}`)
      .set("X-Part-SHA256", sha256(part))
      .send(part)
      .expect(201);

    jest.mocked(deleteCatalogPdfPart).mockRejectedValueOnce(new Error("storage unavailable"));
    const cancelled = await supertest(app)
      .post(`/api/admin/catalog-pdf/upload-sessions/${sessionId}/cancel`)
      .set(auth)
      .expect(202);
    expect(cancelled.body).toMatchObject({ status: "cancelled", cleanupPending: true });
    expect(staged.has(`${sessionId}/0`)).toBe(true);
    const [pending] = await db.select().from(catalogPdfUploadSessionTable)
      .where(eq(catalogPdfUploadSessionTable.id, sessionId));
    expect(pending).toMatchObject({ status: "cancelled", cleanupAt: null });
    expect(await db.select().from(catalogPdfUploadPartTable)
      .where(eq(catalogPdfUploadPartTable.sessionId, sessionId))).toHaveLength(1);

    const status = await supertest(app)
      .get(`/api/admin/catalog-pdf/upload-sessions/${sessionId}`)
      .set(auth)
      .expect(200);
    expect(status.body).toMatchObject({ status: "cancelled", cleanupPending: true });

    // Older cancellations recorded cleanupAt before deleting parts. Their
    // durable part rows must still make them eligible for recovery.
    await db.update(catalogPdfUploadSessionTable)
      .set({ cleanupAt: new Date() })
      .where(eq(catalogPdfUploadSessionTable.id, sessionId));
    const legacyStatus = await supertest(app)
      .get(`/api/admin/catalog-pdf/upload-sessions/${sessionId}`)
      .set(auth)
      .expect(200);
    expect(legacyStatus.body.cleanupPending).toBe(true);

    // This is the same entry point used by the periodic server reconciliation;
    // no second client cancel request is involved in removing the part.
    await recoverCatalogPdfUploadSessions();
    expect(staged.has(`${sessionId}/0`)).toBe(false);
    expect(await db.select().from(catalogPdfUploadPartTable)
      .where(eq(catalogPdfUploadPartTable.sessionId, sessionId))).toHaveLength(0);
    const [recovered] = await db.select().from(catalogPdfUploadSessionTable)
      .where(eq(catalogPdfUploadSessionTable.id, sessionId));
    expect(recovered?.status).toBe("cancelled");
    expect(recovered?.cleanupAt).not.toBeNull();

    await supertest(app)
      .post(`/api/admin/catalog-pdf/upload-sessions/${sessionId}/cancel`)
      .set(auth)
      .expect(200, { sessionId, status: "cancelled", cleanupPending: false });
  });
});