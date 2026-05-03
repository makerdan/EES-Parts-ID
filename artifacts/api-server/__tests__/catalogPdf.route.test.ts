/**
 * End-to-end route test for the catalog-PDF enrichment flow (task #119).
 *
 *   POST /api/admin/catalog-pdf/preview
 *   POST /api/admin/catalog-pdf/apply
 *
 * Complements `catalogPdf.integration.test.ts` (which covers auth, content-
 * type, vendor validation, and the multipart preview→apply happy path) by
 * exercising the parts that file does not:
 *
 *   1. The raw `application/pdf` upload path on /preview.
 *   2. The `uncertainDecisions` branch of /apply — picking one candidate,
 *      skipping another, and verifying only the picked row was enriched.
 *   3. Idempotency: re-posting the same report to /apply produces no further
 *      updates (every row reports `skippedNoOp`).
 *   4. Re-asserts the contract called out in the task spec: tier counts are
 *      sane, color-suffixed siblings are NOT collapsed onto the seeded row.
 *
 * Uses the real Bridgeport Fittings 2026 PDF fixture and the real Postgres
 * database. Seeded rows are cleaned up in `afterAll` even on test failure.
 */

// ── Mock OpenAI BEFORE app import (sibling integration tests do the same) ──
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

import path from "node:path";
import fs from "node:fs";
import supertest from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import app from "../src/app";
import { signAdminToken } from "../src/routes/admin";
import { db, inventoryTable, enrichmentRunTable, enrichmentHistoryTable } from "@workspace/db";
import { closePool, cleanupFixtures } from "./helpers/testDb";
import type { PreviewReport } from "../src/routes/catalogPdf";

const ADMIN_SECRET = "jest-catalog-pdf-route-secret";
let adminToken: string;

// Catalogs we'll seed for this suite. We deliberately use catalog numbers
// that the sibling `catalogPdf.integration.test.ts` does NOT seed, so the
// two integration files can run in parallel jest workers without racing on
// each other's INSERT/DELETE of the same vendor+catalog rows. Each anchor
// has a `-SBLU` color sibling in the Bridgeport PDF at Levenshtein distance
// 1, which is exactly what we want to drive the uncertain-tier branch.
const SEEDED_CATALOGS = ["232-SBLK", "234-SBLK"] as const;

const PDF_PATH = path.resolve(
  __dirname,
  "../../../attached_assets/Bridgeport_Fittings_2026_Catalog_Part1_1777767002957.pdf",
);
const haveFixture = fs.existsSync(PDF_PATH);

async function cleanupRows() {
  await db
    .delete(inventoryTable)
    .where(and(eq(inventoryTable.vendor, "BRIDGEPORT"), inArray(inventoryTable.catalog, [...SEEDED_CATALOGS])));
}

async function seedRows() {
  await cleanupRows();
  for (const catalog of SEEDED_CATALOGS) {
    await db.insert(inventoryTable).values({ vendor: "BRIDGEPORT", catalog, description: "" });
  }
}

beforeAll(() => {
  process.env.ADMIN_PASSWORD = ADMIN_SECRET;
  adminToken = signAdminToken(Date.now(), ADMIN_SECRET);
});

afterAll(async () => {
  // Always clean up — even if a test threw mid-suite — then close the pool.
  try {
    await cleanupRows();
    await cleanupFixtures();
  } finally {
    await closePool();
  }
}, 30_000);

const describeIfFixture = haveFixture ? describe : describe.skip;

describeIfFixture("catalog-pdf route flow (raw upload + uncertainDecisions + idempotency)", () => {
  it(
    "raw application/pdf preview → apply with explicit uncertainDecisions → idempotent re-apply",
    async () => {
      await seedRows();

      // ── 1. /preview via raw application/pdf body (vendor on querystring) ──
      const pdfBuffer = fs.readFileSync(PDF_PATH);
      const previewRes = await supertest(app)
        .post("/api/admin/catalog-pdf/preview?vendor=Bridgeport")
        .set("Authorization", `Bearer ${adminToken}`)
        .set("Content-Type", "application/pdf")
        .send(pdfBuffer)
        .expect(200);

      const report = previewRes.body as PreviewReport;

      // Sane tier counts on the real fixture.
      expect(report.vendor).toBe("BRIDGEPORT");
      expect(report.summary.total).toBeGreaterThan(3000);
      expect(report.summary.exact).toBeGreaterThanOrEqual(2); // 232-SBLK + 234-SBLK are seeded
      expect(report.summary.uncertain).toBeGreaterThan(0);    // their -SBLU siblings land here
      expect(report.summary.unmatched).toBeGreaterThan(0);

      // Look up the seeded row IDs once so we can assert pick-vs-skip behavior.
      const seeded = await db
        .select()
        .from(inventoryTable)
        .where(and(eq(inventoryTable.vendor, "BRIDGEPORT"), inArray(inventoryTable.catalog, [...SEEDED_CATALOGS])));
      const seededByCatalog = new Map(seeded.map(r => [r.catalog, r]));
      const pickAnchor = seededByCatalog.get("232-SBLK")!;
      const skipAnchor = seededByCatalog.get("234-SBLK")!;
      expect(pickAnchor).toBeDefined();
      expect(skipAnchor).toBeDefined();

      // Both seeded SKUs must be exact-tier — proves the exact branch ran
      // and the matcher pre-indexed the vendor's seeded rows.
      for (const cat of SEEDED_CATALOGS) {
        const exact = report.rows.find(r => r.catalogNumber === cat && r.tier === "exact");
        expect(exact).toBeDefined();
        expect(exact!.candidates[0]?.inventoryId).toBe(seededByCatalog.get(cat)!.id);
      }

      // Find the uncertain `-SBLU` siblings whose top candidate is each
      // seeded anchor. They sit at Levenshtein distance 1 (BLK→BLU) from
      // their respective seeded -SBLK row, so they must classify as
      // uncertain — never exact or highConfidence (color-no-collapse).
      const pickRow = report.rows.find(
        r =>
          r.catalogNumber === "232-SBLU" &&
          r.tier === "uncertain" &&
          r.candidates[0]?.inventoryId === pickAnchor.id,
      );
      const skipRow = report.rows.find(
        r =>
          r.catalogNumber === "234-SBLU" &&
          r.tier === "uncertain" &&
          r.candidates[0]?.inventoryId === skipAnchor.id,
      );
      expect(pickRow).toBeDefined();
      expect(skipRow).toBeDefined();

      // ── 2. /apply with explicit uncertainDecisions ──
      // PICK 232-SBLU onto 232-SBLK; SKIP 234-SBLU. /apply must respect both.
      const uncertainDecisions: Record<string, number | "skip"> = {
        [pickRow!.catalogNumber]: pickAnchor.id,
        [skipRow!.catalogNumber]: "skip",
      };
      const applyRes = await supertest(app)
        .post("/api/admin/catalog-pdf/apply")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ report, uncertainDecisions })
        .expect(200);

      const applyBody = applyRes.body as {
        updated: number;
        skippedNoOp: number;
        errors: Array<{ inventoryId: number; error: string }>;
      };
      expect(applyBody.errors).toEqual([]);
      // Both exact rows + the picked uncertain row should have produced
      // distinct DB writes (the pick lands on the 232-SBLK row which is
      // also the exact row, so it may collapse into one update — either
      // way at least the two exact anchors are updated).
      expect(applyBody.updated).toBeGreaterThanOrEqual(2);

      // ── 3. Verify enrichment landed on the seeded rows ──
      const enriched = await db
        .select()
        .from(inventoryTable)
        .where(and(eq(inventoryTable.vendor, "BRIDGEPORT"), inArray(inventoryTable.catalog, [...SEEDED_CATALOGS])));
      expect(enriched).toHaveLength(SEEDED_CATALOGS.length);
      for (const row of enriched) {
        expect(row.enrichedAt).not.toBeNull();
        expect(row.aiKeywords.length).toBeGreaterThan(0);
      }
      // 232-SBLK (the PICK target) must carry "blue" — that proves the
      // picked uncertainDecision was applied (the 232-SBLU PDF entry's
      // dimension keywords were merged onto the seeded 232-SBLK row).
      const pickAfter = enriched.find(r => r.catalog === "232-SBLK")!;
      const pickKws = pickAfter.aiKeywords.map(k => k.toLowerCase());
      expect(pickKws).toContain("blue");

      // 234-SBLK (the SKIP target) must NOT carry "blue" — the 234-SBLU
      // entry was skipped, so its color label must not have leaked onto the
      // anchor row. The anchor still gets "black" from its own exact match.
      const skipAfter = enriched.find(r => r.catalog === "234-SBLK")!;
      const skipKws = skipAfter.aiKeywords.map(k => k.toLowerCase());
      expect(skipKws).toContain("black");
      expect(skipKws).not.toContain("blue");

      // ── 4. Idempotency: re-applying the SAME report+decisions produces
      //    no further updates. Every row should be reported as skippedNoOp.
      const reapplyRes = await supertest(app)
        .post("/api/admin/catalog-pdf/apply")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ report, uncertainDecisions })
        .expect(200);
      const reapplyBody = reapplyRes.body as {
        updated: number;
        skippedNoOp: number;
        errors: Array<{ inventoryId: number; error: string }>;
      };
      expect(reapplyBody.errors).toEqual([]);
      expect(reapplyBody.updated).toBe(0);
      // Exact cardinality: every decision the first /apply touched (whether
      // it produced an UPDATE or was already a no-op) must come back as a
      // no-op on the second pass — no decisions silently dropped.
      expect(reapplyBody.skippedNoOp).toBe(applyBody.updated + applyBody.skippedNoOp);

      // ── 5. Run history + revert (task #118) ────────────────────────────
      // The two /apply calls above each opened an enrichment_run row; the
      // first one wrote per-inventory history. Listing runs must surface
      // them, and reverting the first run must restore the seeded rows to
      // their pre-enrichment state (empty description + empty aiKeywords).
      const runsRes = await supertest(app)
        .get("/api/admin/catalog-pdf/runs?limit=5&sourceFilename=route-test.pdf")
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);
      const runs = (runsRes.body as { runs: Array<{ id: number; vendor: string; updatedCount: number; revertedAt: string | null }> }).runs;
      expect(runs.length).toBeGreaterThanOrEqual(2);
      // Newest first; pick the run with updatedCount > 0 (the first apply).
      const writingRun = runs.find(r => r.updatedCount > 0 && r.revertedAt === null);
      expect(writingRun).toBeDefined();

      const revertRes = await supertest(app)
        .post(`/api/admin/catalog-pdf/runs/${writingRun!.id}/revert`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);
      const revertBody = revertRes.body as { runId: number; restored: number };
      expect(revertBody.runId).toBe(writingRun!.id);
      expect(revertBody.restored).toBeGreaterThanOrEqual(2);

      // Seeded rows must be back to their pre-enrichment state.
      const reverted = await db
        .select()
        .from(inventoryTable)
        .where(and(eq(inventoryTable.vendor, "BRIDGEPORT"), inArray(inventoryTable.catalog, [...SEEDED_CATALOGS])));
      for (const row of reverted) {
        expect(row.description).toBe("");
        expect(row.aiKeywords).toEqual([]);
      }

      // Double-revert must be rejected (409).
      await supertest(app)
        .post(`/api/admin/catalog-pdf/runs/${writingRun!.id}/revert`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(409);

      // Clean up the run rows we created so this suite leaves no trace.
      const ourRunIds = runs.map(r => r.id);
      if (ourRunIds.length) {
        await db.delete(enrichmentHistoryTable).where(inArray(enrichmentHistoryTable.runId, ourRunIds));
        await db.delete(enrichmentRunTable).where(inArray(enrichmentRunTable.id, ourRunIds));
      }
    },
    120_000,
  );
});
