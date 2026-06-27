/**
 * Integration tests for the optimistic-locking guard on the inventory UPDATE
 * inside processPdfPages (catalogPdf.ts).
 *
 * Scenario: two chunk jobs race to enrich the same part at exactly the same
 * time.  The guard — `WHERE image_confidence IS NULL OR image_confidence <
 * incoming_confidence` — must ensure that only the higher-confidence write
 * survives and the lower-confidence write silently loses without corrupting the
 * part's description.
 */

import { and, eq, isNull, lt, or } from "drizzle-orm";
import { db, inventoryTable } from "@workspace/db";
import {
  cleanupFixtures,
  closePool,
  seedFixtures,
} from "../../__tests__/helpers/testDb";

// ── Teardown ──────────────────────────────────────────────────────────────────
afterAll(async () => {
  await cleanupFixtures();
  await closePool();
}, 15_000);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Replicates the exact WHERE clause added to the inventory UPDATE in
 * processPdfPages to prevent duplicate / lower-confidence overwrites.
 */
async function applyPdfEnrichment(
  inventoryId: number,
  jobId: number,
  description: string,
  confidence: number,
): Promise<number> {
  const result = await db
    .update(inventoryTable)
    .set({
      description,
      imageSource: "pdf_extraction",
      imageConfidence: confidence,
      catalogPdfJobId: jobId,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(inventoryTable.id, inventoryId),
        or(
          isNull(inventoryTable.imageConfidence),
          lt(inventoryTable.imageConfidence, confidence),
        ),
      ),
    )
    .returning({ id: inventoryTable.id });

  return result.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe("inventory UPDATE optimistic-locking guard", () => {
  it("first write wins when no confidence is stored yet (imageConfidence IS NULL)", async () => {
    const [row] = await seedFixtures([
      {
        vendor: "EATON",
        catalog: "JEST-ITG-RACE-FIRST",
        description: "Original description",
      },
    ]);

    if (!row) throw new Error("Seed failed");

    const affected = await applyPdfEnrichment(row.id, 100, "First enrichment", 0.8);
    expect(affected).toBe(1);

    const [updated] = await db
      .select({ description: inventoryTable.description, imageConfidence: inventoryTable.imageConfidence })
      .from(inventoryTable)
      .where(eq(inventoryTable.id, row.id))
      .limit(1);

    expect(updated?.description).toBe("First enrichment");
    expect(updated?.imageConfidence).toBeCloseTo(0.8);
  });

  it("higher-confidence job wins when two jobs race for the same part", async () => {
    const [row] = await seedFixtures([
      {
        vendor: "EATON",
        catalog: "JEST-ITG-RACE-HIGHER",
        description: "Original description",
      },
    ]);

    if (!row) throw new Error("Seed failed");

    const LOW_CONFIDENCE = 0.5;
    const HIGH_CONFIDENCE = 0.9;

    const [lowAffected, highAffected] = await Promise.all([
      applyPdfEnrichment(row.id, 201, "Low-confidence enrichment", LOW_CONFIDENCE),
      applyPdfEnrichment(row.id, 202, "High-confidence enrichment", HIGH_CONFIDENCE),
    ]);

    const [final] = await db
      .select({
        description: inventoryTable.description,
        imageConfidence: inventoryTable.imageConfidence,
        catalogPdfJobId: inventoryTable.catalogPdfJobId,
      })
      .from(inventoryTable)
      .where(eq(inventoryTable.id, row.id))
      .limit(1);

    expect(lowAffected + highAffected).toBeGreaterThanOrEqual(1);

    expect(final?.description).toBe("High-confidence enrichment");
    expect(final?.imageConfidence).toBeCloseTo(HIGH_CONFIDENCE);
    expect(final?.catalogPdfJobId).toBe(202);
  });

  it("lower-confidence job does NOT overwrite a higher-confidence existing row", async () => {
    const [row] = await seedFixtures([
      {
        vendor: "EATON",
        catalog: "JEST-ITG-RACE-LOWER",
        description: "Original description",
      },
    ]);

    if (!row) throw new Error("Seed failed");

    await applyPdfEnrichment(row.id, 301, "High-confidence enrichment", 0.95);

    const secondAffected = await applyPdfEnrichment(
      row.id,
      302,
      "Low-confidence enrichment (should be ignored)",
      0.4,
    );

    expect(secondAffected).toBe(0);

    const [final] = await db
      .select({
        description: inventoryTable.description,
        imageConfidence: inventoryTable.imageConfidence,
        catalogPdfJobId: inventoryTable.catalogPdfJobId,
      })
      .from(inventoryTable)
      .where(eq(inventoryTable.id, row.id))
      .limit(1);

    expect(final?.description).toBe("High-confidence enrichment");
    expect(final?.imageConfidence).toBeCloseTo(0.95);
    expect(final?.catalogPdfJobId).toBe(301);
  });

  it("equal-confidence job does NOT overwrite the existing row (existing wins)", async () => {
    const [row] = await seedFixtures([
      {
        vendor: "EATON",
        catalog: "JEST-ITG-RACE-EQUAL",
        description: "Original description",
      },
    ]);

    if (!row) throw new Error("Seed failed");

    await applyPdfEnrichment(row.id, 401, "First enrichment at 0.7", 0.7);

    const secondAffected = await applyPdfEnrichment(row.id, 402, "Second enrichment at 0.7", 0.7);

    expect(secondAffected).toBe(0);

    const [final] = await db
      .select({
        description: inventoryTable.description,
        catalogPdfJobId: inventoryTable.catalogPdfJobId,
      })
      .from(inventoryTable)
      .where(eq(inventoryTable.id, row.id))
      .limit(1);

    expect(final?.description).toBe("First enrichment at 0.7");
    expect(final?.catalogPdfJobId).toBe(401);
  });
});
