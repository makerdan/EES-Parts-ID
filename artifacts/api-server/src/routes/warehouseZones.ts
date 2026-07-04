import {
  CreateWarehouseZoneBody,
  ListWarehouseZonesResponse,
  UpdateWarehouseZoneBody,
  UpdateWarehouseZoneResponse,
} from "@workspace/api-zod";
import { db } from "@workspace/db";
import { inventoryTable, warehouseZoneTable } from "@workspace/db";
import { asc, eq, sql } from "drizzle-orm";
import { Router } from "express";

import { requireAdminAuth } from "../middlewares/requireAdminAuth";

/** Strips leading zeros from numeric aisle ID strings ("08" → "8", "A1" → "A1"). */
function normalizeAisleId(v: string): string {
  const t = v.trim();
  return /^\d+$/.test(t) ? String(parseInt(t, 10)) : t;
}

const router = Router();

// GET /warehouse-zones
router.get("/", async (_req, res) => {
  try {
    const zones = await db
      .select()
      .from(warehouseZoneTable)
      .orderBy(asc(warehouseZoneTable.sortOrder), asc(warehouseZoneTable.aisleId));
    res.json(ListWarehouseZonesResponse.parse({ zones }));
  } catch {
    res.status(500).json({ error: "Failed to list zones" });
  }
});

// GET /warehouse-zones/coverage
// Returns the count of items with no valid bin and the set of aisle IDs found in
// inventory bins that have no corresponding zone defined.
//
// Canonical aisle ID format: leading-zero-stripped numeric string (e.g. "01" → "1").
// Zones are stored in this format; inventory bin prefixes (zero-padded "01") are
// normalised server-side before comparison so both sides always match.
router.get("/coverage", async (_req, res) => {
  try {
    const result = await db.execute<{
      unsorted_count: number;
      uncovered_aisles: Array<string>;
    }>(sql`
      WITH
      -- Count inventory items that have no valid bin location.
      -- A valid bin matches the 2-digit-2-digit-3-digit warehouse format.
      unsorted AS (
        SELECT COUNT(*)::int AS cnt
        FROM ${inventoryTable} i
        WHERE NOT EXISTS (
          SELECT 1 FROM unnest(i.bin_locations) AS b
          WHERE b ~ '^[0-9]{2}-[0-9]{2}-[0-9]{3}$'
        )
      ),
      -- Distinct aisle IDs present in inventory bins, normalised by stripping
      -- leading zeros (e.g. '01' → '1') to match the canonical zone format.
      inv_aisles AS (
        SELECT DISTINCT
          CAST(CAST(split_part(b, '-', 1) AS integer) AS text) AS aisle_id
        FROM ${inventoryTable}, unnest(bin_locations) AS t(b)
        WHERE b ~ '^[0-9]{2}-[0-9]{2}-[0-9]{3}$'
      ),
      -- Zone aisle IDs, also normalised (zones are already stored stripped,
      -- but we normalise defensively in case any padded values were inserted).
      zone_aisles AS (
        SELECT DISTINCT
          CASE
            WHEN aisle_id ~ '^[0-9]+$'
            THEN CAST(CAST(aisle_id AS integer) AS text)
            ELSE aisle_id
          END AS aisle_id
        FROM ${warehouseZoneTable}
      )
      SELECT
        (SELECT cnt FROM unsorted) AS unsorted_count,
        COALESCE(
          ARRAY(
            SELECT ia.aisle_id
            FROM inv_aisles ia
            WHERE ia.aisle_id NOT IN (SELECT aisle_id FROM zone_aisles)
            ORDER BY ia.aisle_id::integer
          ),
          '{}'::text[]
        ) AS uncovered_aisles
    `);

    const row = result.rows[0];
    res.json({
      unsortedCount: row?.unsorted_count ?? 0,
      uncoveredAisles: row?.uncovered_aisles ?? [],
    });
  } catch {
    res.status(500).json({ error: "Failed to compute coverage" });
  }
});

// POST /warehouse-zones
router.post("/", requireAdminAuth, async (req, res) => {
  const parsed = CreateWarehouseZoneBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
    return;
  }
  try {
    const {
      aisleId: rawAisleId,
      sectionNum,
      isInventory,
      svgX,
      svgY,
      svgWidth,
      svgHeight,
      sortOrder,
    } = parsed.data;
    const aisleId = normalizeAisleId(rawAisleId);
    const [zone] = await db
      .insert(warehouseZoneTable)
      .values({
        aisleId,
        sectionNum: sectionNum ?? null,
        isInventory: isInventory ?? true,
        svgX,
        svgY,
        svgWidth,
        svgHeight,
        sortOrder: sortOrder ?? 0,
      })
      .returning();
    res.status(201).json(UpdateWarehouseZoneResponse.parse({ zone }));
  } catch (err) {
    console.error("[warehouseZones] POST failed:", err);
    res.status(500).json({ error: "Failed to create zone" });
  }
});

// PATCH /warehouse-zones/:id
router.patch("/:id", requireAdminAuth, async (req, res) => {
  const id = parseInt(String(req.params["id"]));
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const parsed = UpdateWarehouseZoneBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
    return;
  }
  try {
    const updates = parsed.data;
    if (updates.aisleId !== undefined) {
      updates.aisleId = normalizeAisleId(updates.aisleId);
    }
    const [zone] = await db
      .update(warehouseZoneTable)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(warehouseZoneTable.id, id))
      .returning();
    if (!zone) {
      res.status(404).json({ error: "Zone not found" });
      return;
    }
    res.json(UpdateWarehouseZoneResponse.parse({ zone }));
  } catch (err) {
    console.error("[warehouseZones] PATCH failed:", err);
    res.status(500).json({ error: "Failed to update zone" });
  }
});

// DELETE /warehouse-zones/:id
router.delete("/:id", requireAdminAuth, async (req, res) => {
  const id = parseInt(String(req.params["id"]));
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  try {
    const [zone] = await db
      .delete(warehouseZoneTable)
      .where(eq(warehouseZoneTable.id, id))
      .returning();
    if (!zone) {
      res.status(404).json({ error: "Zone not found" });
      return;
    }
    res.json({ deleted: true });
  } catch (err) {
    console.error("[warehouseZones] DELETE failed:", err);
    res.status(500).json({ error: "Failed to delete zone" });
  }
});

export default router;
