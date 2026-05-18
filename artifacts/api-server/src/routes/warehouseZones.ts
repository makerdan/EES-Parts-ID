import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { eq, asc } from "drizzle-orm";
import { db } from "@workspace/db";
import { warehouseZoneTable } from "@workspace/db";
import { verifyAdminToken } from "./admin";

const router = Router();

function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    res.status(503).json({ error: "Admin access not configured on this server." });
    return;
  }
  const authHeader = req.headers["authorization"] ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token || !verifyAdminToken(token, adminPassword)) {
    res.status(401).json({ error: "Unauthorized: valid admin token required" });
    return;
  }
  next();
}

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

// POST /warehouse-zones  (admin)
router.post("/", requireAdminAuth, async (req, res) => {
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
    if (!aisleId || !label || svgX == null || svgY == null || svgWidth == null || svgHeight == null) {
      res.status(400).json({ error: "aisleId, label, svgX, svgY, svgWidth, svgHeight required" });
      return;
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
  } catch {
    res.status(500).json({ error: "Failed to create zone" });
  }
});

// PATCH /warehouse-zones/:id  (admin)
router.patch("/:id", requireAdminAuth, async (req, res) => {
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

// DELETE /warehouse-zones/:id  (admin)
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
  } catch {
    res.status(500).json({ error: "Failed to delete zone" });
  }
});

export default router;
