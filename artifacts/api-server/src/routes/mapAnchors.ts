/**
 * Map anchor-point calibration endpoints.
 *
 * GET  /api/admin/map-anchors          — list all 0–3 saved anchors
 * PUT  /api/admin/map-anchors/:slot    — upsert slot 1, 2, or 3
 * DELETE /api/admin/map-anchors/:slot  — clear a slot
 *
 * All write endpoints are protected by requireAdminAuth.
 * The GET endpoint is also admin-only; the anchor data is only used in the
 * admin calibration screen and by WarehouseMapView when an admin is present.
 */
import { mapAnchorPointsTable } from "@workspace/db";
import { db } from "@workspace/db";
import { eq } from "drizzle-orm";
import { Router } from "express";

import { requireAdminAuth } from "../middlewares/requireAdminAuth";

const router = Router();

function parseSlot(raw: string): number | null {
  const n = parseInt(raw, 10);
  if (n === 1 || n === 2 || n === 3) return n;
  return null;
}

interface UpsertBody {
  name: string;
  svgX: number;
  svgY: number;
  worldX: number;
  worldY: number;
}

function parseUpsertBody(body: unknown): UpsertBody | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const name = typeof b["name"] === "string" ? b["name"].slice(0, 80) : "";
  const svgX = typeof b["svgX"] === "number" && isFinite(b["svgX"]) ? b["svgX"] : null;
  const svgY = typeof b["svgY"] === "number" && isFinite(b["svgY"]) ? b["svgY"] : null;
  const worldX = typeof b["worldX"] === "number" && isFinite(b["worldX"]) ? b["worldX"] : null;
  const worldY = typeof b["worldY"] === "number" && isFinite(b["worldY"]) ? b["worldY"] : null;
  if (svgX === null || svgY === null || worldX === null || worldY === null) return null;
  return { name, svgX, svgY, worldX, worldY };
}

// GET /admin/map-anchors
router.get("/map-anchors", requireAdminAuth, async (_req, res) => {
  try {
    const anchors = await db
      .select()
      .from(mapAnchorPointsTable)
      .orderBy(mapAnchorPointsTable.id);
    res.json({ anchors });
  } catch {
    res.status(500).json({ error: "Failed to list map anchors" });
  }
});

// PUT /admin/map-anchors/:slot
router.put("/map-anchors/:slot", requireAdminAuth, async (req, res) => {
  const slot = parseSlot(String(req.params["slot"]));
  if (slot === null) {
    res.status(400).json({ error: "Slot must be 1, 2, or 3" });
    return;
  }

  const parsed = parseUpsertBody(req.body);
  if (!parsed) {
    res.status(400).json({ error: "Invalid request body: name (string), svgX/svgY/worldX/worldY (finite numbers) required" });
    return;
  }

  const { name, svgX, svgY, worldX, worldY } = parsed;

  try {
    const [anchor] = await db
      .insert(mapAnchorPointsTable)
      .values({ id: slot, name, svgX, svgY, worldX, worldY, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: mapAnchorPointsTable.id,
        set: { name, svgX, svgY, worldX, worldY, updatedAt: new Date() },
      })
      .returning();
    res.json({ anchor });
  } catch {
    res.status(500).json({ error: "Failed to save map anchor" });
  }
});

// DELETE /admin/map-anchors/:slot
router.delete("/map-anchors/:slot", requireAdminAuth, async (req, res) => {
  const slot = parseSlot(String(req.params["slot"]));
  if (slot === null) {
    res.status(400).json({ error: "Slot must be 1, 2, or 3" });
    return;
  }

  try {
    const [deleted] = await db
      .delete(mapAnchorPointsTable)
      .where(eq(mapAnchorPointsTable.id, slot))
      .returning();
    res.json({ deleted: deleted != null });
  } catch {
    res.status(500).json({ error: "Failed to delete map anchor" });
  }
});

export default router;
