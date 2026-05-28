import { Router } from "express";
import { eq, asc } from "drizzle-orm";
import { db } from "@workspace/db";
import { warehouseZoneTable, inventoryTable } from "@workspace/db";
import { devOnly } from "../middlewares/devOnly";
import { CreateWarehouseZoneBody, UpdateWarehouseZoneBody } from "@workspace/api-zod";

const router = Router();

// GET /warehouse-zones
router.get("/", async (_req, res) => {
  try {
    const zones = await db
      .select()
      .from(warehouseZoneTable)
      .orderBy(asc(warehouseZoneTable.sortOrder), asc(warehouseZoneTable.aisleId));
    res.json({ zones });
  } catch {
    res.status(500).json({ error: "Failed to list zones" });
  }
});

// GET /warehouse-zones/coverage
// Returns the count of items with no valid bin and the set of aisle IDs found in
// inventory bins that have no corresponding zone defined.
router.get("/coverage", async (_req, res) => {
  try {
    const [zones, items] = await Promise.all([
      db.select({ aisleId: warehouseZoneTable.aisleId }).from(warehouseZoneTable),
      db.select({ binLocations: inventoryTable.binLocations }).from(inventoryTable),
    ]);

    const BIN_RE = /^(\d{2})-(\d{2})-(\d{3})$/;
    let unsortedCount = 0;
    const inventoryAisleIds = new Set<string>();

    for (const item of items) {
      const bins = item.binLocations ?? [];
      let hasValid = false;
      for (const raw of bins) {
        const m = BIN_RE.exec(raw.trim());
        if (m) {
          hasValid = true;
          // m[1] is already 2-digit zero-padded from the regex
          inventoryAisleIds.add(m[1]!);
        }
      }
      if (!hasValid) unsortedCount++;
    }

    // Normalise zone aisle IDs to 2-digit zero-padded for comparison
    const zoneAisleIds = new Set(
      zones.map((z) => z.aisleId.trim().padStart(2, "0")),
    );
    const uncoveredAisles = [...inventoryAisleIds]
      .filter((a) => !zoneAisleIds.has(a))
      .sort();

    res.json({ unsortedCount, uncoveredAisles });
  } catch {
    res.status(500).json({ error: "Failed to compute coverage" });
  }
});

// POST /warehouse-zones
router.post("/", devOnly, async (req, res) => {
  const parsed = CreateWarehouseZoneBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
    return;
  }
  try {
    const {
      aisleId,
      label,
      sectionParity,
      isInventory,
      svgX,
      svgY,
      svgWidth,
      svgHeight,
      sortOrder,
    } = parsed.data;
    const [zone] = await db
      .insert(warehouseZoneTable)
      .values({
        aisleId,
        label,
        sectionParity: sectionParity ?? "all",
        isInventory: isInventory ?? true,
        svgX,
        svgY,
        svgWidth,
        svgHeight,
        sortOrder: sortOrder ?? 0,
      })
      .returning();
    res.status(201).json({ zone });
  } catch {
    res.status(500).json({ error: "Failed to create zone" });
  }
});

// PATCH /warehouse-zones/:id
router.patch("/:id", devOnly, async (req, res) => {
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
    const [zone] = await db
      .update(warehouseZoneTable)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(warehouseZoneTable.id, id))
      .returning();
    if (!zone) {
      res.status(404).json({ error: "Zone not found" });
      return;
    }
    res.json({ zone });
  } catch {
    res.status(500).json({ error: "Failed to update zone" });
  }
});

// DELETE /warehouse-zones/:id
router.delete("/:id", devOnly, async (req, res) => {
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
  } catch {
    res.status(500).json({ error: "Failed to delete zone" });
  }
});

export default router;
