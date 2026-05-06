/**
 * Classification review queue — admin endpoints.
 *
 * GET  /admin/classification-review        — paginated low-confidence AI queue
 * POST /admin/classification-review/:id/confirm     — mark reviewed, keep category
 * POST /admin/classification-review/:id/reclassify  — reassign to a different type node
 * POST /admin/classification-review/:id/skip        — defer item to end of queue
 *
 * Auth: all routes require the admin Bearer token (same as other admin routes).
 * The :id parameter is the inventory_id (primary key of inventory_category).
 */
import { Router } from "express";
import { eq, sql } from "drizzle-orm";
import {
  db,
  inventoryCategoryTable,
  categoryNodeTable,
} from "@workspace/db";
import { verifyAdminToken } from "./admin";

const router = Router();

function requireAdminAuth(
  req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction,
): void {
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    res.status(503).json({ error: "Admin access is not configured." });
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

// ── GET /admin/classification-review ────────────────────────────────────────
// Returns the paginated review queue: AI-classified rows where confidence < 0.70
// and reviewed_at IS NULL, oldest-first.
// Query params: page (default 1), limit (default 50, max 100).
router.get("/classification-review", requireAdminAuth, async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(String(req.query["page"]  ?? "1"))  || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query["limit"] ?? "50")) || 50));
    const offset = (page - 1) * limit;

    // Count of pending items (hits the partial index).
    const countResult = await db.execute(sql`
      SELECT count(*)::int AS total
      FROM inventory_category
      WHERE classified_by = 'ai'
        AND reviewed_at IS NULL
        AND confidence < 0.70
    `);
    const pendingCount = Number(
      (countResult as { rows: Record<string, unknown>[] }).rows[0]?.["total"] ?? 0,
    );

    // Fetch queue items with a three-level category breadcrumb.
    // n3 = type (leaf), n2 = subcategory, n1 = category (root).
    const rows = await db.execute(sql`
      SELECT
        ic.inventory_id     AS "inventoryId",
        i.vendor,
        i.catalog,
        i.description,
        ROUND(ic.confidence::numeric * 100, 1)::float AS "confidencePct",
        ic.classified_at    AS "classifiedAt",
        ic.category_node_id AS "categoryNodeId",
        n3.name             AS "typeName",
        n2.name             AS "subcatName",
        n1.name             AS "catName"
      FROM inventory_category ic
      JOIN inventory i       ON i.id    = ic.inventory_id
      JOIN category_node n3  ON n3.id   = ic.category_node_id
      LEFT JOIN category_node n2 ON n2.id = n3.parent_id
      LEFT JOIN category_node n1 ON n1.id = n2.parent_id
      WHERE ic.classified_by = 'ai'
        AND ic.reviewed_at IS NULL
        AND ic.confidence < 0.70
      ORDER BY ic.classified_at ASC, ic.confidence ASC
      LIMIT ${limit} OFFSET ${offset}
    `);

    const items = (rows as { rows: Record<string, unknown>[] }).rows.map(r => ({
      inventoryId:    Number(r["inventoryId"]),
      vendor:         String(r["vendor"] ?? ""),
      catalog:        String(r["catalog"] ?? ""),
      description:    String(r["description"] ?? ""),
      confidencePct:  Number(r["confidencePct"] ?? 0),
      classifiedAt:   r["classifiedAt"] instanceof Date
        ? r["classifiedAt"].toISOString()
        : String(r["classifiedAt"] ?? ""),
      categoryNodeId: Number(r["categoryNodeId"]),
      categoryPath: [r["catName"], r["subcatName"], r["typeName"]]
        .filter(Boolean)
        .join(" › "),
    }));

    res.json({ items, total: pendingCount, page, limit });
  } catch (err) {
    console.error("[classification-review/GET] failed:", err);
    res.status(500).json({ error: "Failed to load review queue" });
  }
});

// ── POST /admin/classification-review/:id/confirm ───────────────────────────
// Mark the item as reviewed without changing its category.
router.post("/classification-review/:id/confirm", requireAdminAuth, async (req, res) => {
  try {
    const inventoryId = parseInt(String(req.params["id"] ?? "0"));
    if (!Number.isFinite(inventoryId) || inventoryId <= 0) {
      return void res.status(400).json({ error: "id must be a positive integer" });
    }

    const result = await db
      .update(inventoryCategoryTable)
      .set({ reviewedAt: new Date(), reviewedBy: "admin" })
      .where(eq(inventoryCategoryTable.inventoryId, inventoryId))
      .returning({ inventoryId: inventoryCategoryTable.inventoryId });

    if (result.length === 0) {
      return void res.status(404).json({ error: "Item not found in inventory_category" });
    }
    res.json({ ok: true, inventoryId });
  } catch (err) {
    console.error("[classification-review/confirm] failed:", err);
    res.status(500).json({ error: "Failed to confirm classification" });
  }
});

// ── POST /admin/classification-review/:id/reclassify ────────────────────────
// Reassign to a different leaf category node and mark as manually reviewed.
// Body: { categoryNodeId: number }
router.post("/classification-review/:id/reclassify", requireAdminAuth, async (req, res) => {
  try {
    const inventoryId = parseInt(String(req.params["id"] ?? "0"));
    if (!Number.isFinite(inventoryId) || inventoryId <= 0) {
      return void res.status(400).json({ error: "id must be a positive integer" });
    }

    const { categoryNodeId } = req.body as { categoryNodeId?: number };
    if (!Number.isFinite(categoryNodeId) || (categoryNodeId ?? 0) <= 0) {
      return void res.status(400).json({ error: "categoryNodeId must be a positive integer" });
    }

    // Validate the target node exists and is a leaf type node.
    const [node] = await db
      .select()
      .from(categoryNodeTable)
      .where(eq(categoryNodeTable.id, categoryNodeId!))
      .limit(1);

    if (!node) {
      return void res.status(404).json({ error: "Target category node not found" });
    }
    if (node.level !== "type") {
      return void res.status(400).json({ error: "Inventory must be assigned to a leaf type node" });
    }

    const result = await db
      .update(inventoryCategoryTable)
      .set({
        categoryNodeId: categoryNodeId!,
        classifiedBy: "manual",
        confidence:   "1.0000",
        reviewedAt:   new Date(),
        reviewedBy:   "admin",
      })
      .where(eq(inventoryCategoryTable.inventoryId, inventoryId))
      .returning({ inventoryId: inventoryCategoryTable.inventoryId });

    if (result.length === 0) {
      return void res.status(404).json({ error: "Item not found in inventory_category" });
    }
    res.json({ ok: true, inventoryId, categoryNodeId });
  } catch (err) {
    console.error("[classification-review/reclassify] failed:", err);
    res.status(500).json({ error: "Failed to reclassify item" });
  }
});

// ── POST /admin/classification-review/:id/skip ──────────────────────────────
// Defer the item to the end of the queue by bumping classified_at to now().
// The oldest-first ORDER BY then places it after all current items.
router.post("/classification-review/:id/skip", requireAdminAuth, async (req, res) => {
  try {
    const inventoryId = parseInt(String(req.params["id"] ?? "0"));
    if (!Number.isFinite(inventoryId) || inventoryId <= 0) {
      return void res.status(400).json({ error: "id must be a positive integer" });
    }

    // Bump classified_at to now() so it sorts after all existing queue items.
    const result = await db.execute(sql`
      UPDATE inventory_category
      SET classified_at = now()
      WHERE inventory_id = ${inventoryId}
        AND classified_by = 'ai'
        AND reviewed_at IS NULL
      RETURNING inventory_id
    `);

    const updated = (result as { rows: Record<string, unknown>[] }).rows.length;
    if (updated === 0) {
      return void res.status(404).json({ error: "Item not found or already reviewed" });
    }
    res.json({ ok: true, inventoryId });
  } catch (err) {
    console.error("[classification-review/skip] failed:", err);
    res.status(500).json({ error: "Failed to skip item" });
  }
});

export default router;
