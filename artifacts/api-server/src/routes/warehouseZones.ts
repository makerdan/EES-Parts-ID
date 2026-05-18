import { Router } from "express";
import { eq, asc } from "drizzle-orm";
import { db } from "@workspace/db";
import { warehouseZoneTable } from "@workspace/db";
import { verifyAdminToken } from "./admin";

const router = Router();

// GET /warehouse-zones
router.get("/", async (_req, res) => {
  try {
    const zones = await db
      .select()
      .from(warehouseZoneTable)
      .orderBy(asc(warehouseZoneTable.sortOrder), asc(warehouseZoneTable.aisleId));
    res.json({ zones });
  } catch (err) {
    res.status(500).json({ error: "Failed to list zones" });
  }
});

// POST /warehouse-zones  (admin)
router.post("/", async (req, res) => {
  const authErr = verifyAdminToken(req);
  if (authErr) return res.status(401).json({ error: authErr });
  try {
    const { aisleId, label, sectionParity, isInventory, svgX, svgY, svgWidth, svgHeight, sortOrder } = req.body as {
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
    if (!aisleId || !label || svgX == null || svgY == null || svgWidth == null || svgHeight == null) {
      return res.status(400).json({ error: "aisleId, label, svgX, svgY, svgWidth, svgHeight required" });
    }
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
  } catch (err) {
    res.status(500).json({ error: "Failed to create zone" });
  }
});

// PATCH /warehouse-zones/:id  (admin)
router.patch("/:id", async (req, res) => {
  const authErr = verifyAdminToken(req);
  if (authErr) return res.status(401).json({ error: authErr });
  const id = parseInt(req.params["id"]!);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
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
    const [zone] = await db
      .update(warehouseZoneTable)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(warehouseZoneTable.id, id))
      .returning();
    if (!zone) return res.status(404).json({ error: "Zone not found" });
    res.json({ zone });
  } catch (err) {
    res.status(500).json({ error: "Failed to update zone" });
  }
});

// DELETE /warehouse-zones/:id  (admin)
router.delete("/:id", async (req, res) => {
  const authErr = verifyAdminToken(req);
  if (authErr) return res.status(401).json({ error: authErr });
  const id = parseInt(req.params["id"]!);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  try {
    const [zone] = await db
      .delete(warehouseZoneTable)
      .where(eq(warehouseZoneTable.id, id))
      .returning();
    if (!zone) return res.status(404).json({ error: "Zone not found" });
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete zone" });
  }
});

export default router;
