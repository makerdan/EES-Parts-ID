import { Router } from "express";
import { eq, asc } from "drizzle-orm";
import { db } from "@workspace/db";
import { warehouseZoneTable } from "@workspace/db";

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

// POST /warehouse-zones
router.post("/", async (req, res) => {
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
    } = req.body as {
      aisleId: string;
      label: string;
      sectionParity?: string;
      isInventory?: boolean;
      svgX: number;
      svgY: number;
      svgWidth: number;
      svgHeight: number;
      sortOrder?: number;
    };
    const validParities = ["odd", "even", "all"] as const;
    const resolvedParity = sectionParity ?? "all";
    if (!aisleId || !label || svgX == null || svgY == null || svgWidth == null || svgHeight == null) {
      res.status(400).json({ error: "aisleId, label, svgX, svgY, svgWidth, svgHeight required" });
      return;
    }
    if (!validParities.includes(resolvedParity as typeof validParities[number])) {
      res.status(400).json({ error: "sectionParity must be 'odd', 'even', or 'all'" });
      return;
    }
    const [zone] = await db
      .insert(warehouseZoneTable)
      .values({
        aisleId,
        label,
        sectionParity: resolvedParity,
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
router.patch("/:id", async (req, res) => {
  const id = parseInt(String(req.params["id"]));
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  try {
    const updates = req.body as Partial<{
      aisleId: string;
      label: string;
      sectionParity: string;
      isInventory: boolean;
      svgX: number;
      svgY: number;
      svgWidth: number;
      svgHeight: number;
      sortOrder: number;
    }>;
    if (updates.sectionParity !== undefined) {
      const validParities = ["odd", "even", "all"];
      if (!validParities.includes(updates.sectionParity)) {
        res.status(400).json({ error: "sectionParity must be 'odd', 'even', or 'all'" });
        return;
      }
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
    res.json({ zone });
  } catch {
    res.status(500).json({ error: "Failed to update zone" });
  }
});

// DELETE /warehouse-zones/:id
router.delete("/:id", async (req, res) => {
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
