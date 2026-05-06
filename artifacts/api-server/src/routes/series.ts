/**
 * Product-series routes — admin-only CRUD for explicit series groupings.
 *
 * Routes:
 *   GET    /api/series                        — list all series with member counts
 *   POST   /api/series                        — create a new series
 *   PATCH  /api/series/:id                    — rename a series
 *   POST   /api/series/auto-assign            — bulk-assign series_id from catalog_parse (SSE)
 *   DELETE /api/series/:id/items/:inventoryId — remove one item from a series
 *   POST   /api/series/:id/items              — add items to a series by inventory ID array
 *   GET    /api/series/:id/items              — list members of a series
 *   GET    /api/series/:id/search             — search inventory to add to a series
 */
import { Router } from "express";
import { eq, sql, and, not, inArray, ilike, or, isNull } from "drizzle-orm";
import { db } from "@workspace/db";
import { inventoryTable, productSeriesTable } from "@workspace/db";
import { verifyAdminToken } from "./admin";

const router = Router();

function requireAdmin(
  req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction,
): void {
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    res.status(503).json({ error: "Admin access not configured." });
    return;
  }
  const token = (req.headers["authorization"] ?? "").replace(/^Bearer /, "");
  if (!verifyAdminToken(token, adminPassword)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// ── GET /series ─────────────────────────────────────────────────────────────
router.get("/", requireAdmin, async (_req, res) => {
  try {
    const rows = await db.execute(sql`
      SELECT
        ps.id,
        ps.name,
        ps.vendor,
        ps.created_at,
        COUNT(i.id)::int AS member_count
      FROM product_series ps
      LEFT JOIN inventory i ON i.series_id = ps.id
      GROUP BY ps.id, ps.name, ps.vendor, ps.created_at
      ORDER BY ps.vendor ASC, ps.name ASC
    `);
    res.json({ series: (rows as { rows: unknown[] }).rows });
  } catch (err) {
    console.error("[series/list]", err);
    res.status(500).json({ error: "Failed to list series" });
  }
});

// ── GET /series/coverage ─────────────────────────────────────────────────────
router.get("/coverage", requireAdmin, async (_req, res) => {
  try {
    const result = await db.execute(sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(series_id)::int AS assigned
      FROM inventory
    `);
    const row = (result as { rows: unknown[] }).rows[0] as { total: number; assigned: number } | undefined;
    res.json({
      total: row?.total ?? 0,
      assigned: row?.assigned ?? 0,
    });
  } catch (err) {
    console.error("[series/coverage]", err);
    res.status(500).json({ error: "Failed to get series coverage" });
  }
});

// ── POST /series ─────────────────────────────────────────────────────────────
router.post("/", requireAdmin, async (req, res) => {
  try {
    const { name, vendor } = req.body as { name?: string; vendor?: string };
    if (!name?.trim() || !vendor?.trim()) {
      res.status(400).json({ error: "name and vendor are required" });
      return;
    }
    const [created] = await db
      .insert(productSeriesTable)
      .values({ name: name.trim(), vendor: vendor.trim().toUpperCase() })
      .onConflictDoNothing()
      .returning();
    if (!created) {
      const existing = await db
        .select()
        .from(productSeriesTable)
        .where(
          and(
            eq(productSeriesTable.vendor, vendor.trim().toUpperCase()),
            eq(productSeriesTable.name, name.trim()),
          ),
        )
        .limit(1);
      res.status(200).json({ series: existing[0] });
      return;
    }
    res.status(201).json({ series: created });
  } catch (err) {
    console.error("[series/create]", err);
    res.status(500).json({ error: "Failed to create series" });
  }
});

// ── PATCH /series/:id ────────────────────────────────────────────────────────
router.patch("/:id", requireAdmin, async (req, res) => {
  try {
    const id = parseInt(String(req.params.id ?? ""), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const { name } = req.body as { name?: string };
    if (!name?.trim()) { res.status(400).json({ error: "name is required" }); return; }
    const [updated] = await db
      .update(productSeriesTable)
      .set({ name: name.trim() })
      .where(eq(productSeriesTable.id, id))
      .returning();
    if (!updated) { res.status(404).json({ error: "Series not found" }); return; }
    res.json({ series: updated });
  } catch (err) {
    console.error("[series/rename]", err);
    res.status(500).json({ error: "Failed to rename series" });
  }
});

// ── GET /series/:id/items ────────────────────────────────────────────────────
router.get("/:id/items", requireAdmin, async (req, res) => {
  try {
    const id = parseInt(String(req.params.id ?? ""), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const items = await db
      .select({
        id: inventoryTable.id,
        vendor: inventoryTable.vendor,
        catalog: inventoryTable.catalog,
        description: inventoryTable.description,
      })
      .from(inventoryTable)
      .where(eq(inventoryTable.seriesId, id))
      .orderBy(inventoryTable.vendor, inventoryTable.catalog);
    res.json({ items });
  } catch (err) {
    console.error("[series/items]", err);
    res.status(500).json({ error: "Failed to list series members" });
  }
});

// ── GET /series/:id/search ───────────────────────────────────────────────────
router.get("/:id/search", requireAdmin, async (req, res) => {
  try {
    const id = parseInt(String(req.params.id ?? ""), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const q = String(req.query["q"] ?? "").trim();
    if (!q) { res.json({ items: [] }); return; }
    const items = await db
      .select({
        id: inventoryTable.id,
        vendor: inventoryTable.vendor,
        catalog: inventoryTable.catalog,
        description: inventoryTable.description,
        seriesId: inventoryTable.seriesId,
      })
      .from(inventoryTable)
      .where(
        and(
          or(
            ilike(inventoryTable.catalog, `%${q}%`),
            ilike(inventoryTable.description, `%${q}%`),
          ),
          or(
            isNull(inventoryTable.seriesId),
            not(eq(inventoryTable.seriesId, id)),
          ),
        ),
      )
      .orderBy(inventoryTable.vendor, inventoryTable.catalog)
      .limit(30);
    res.json({ items });
  } catch (err) {
    console.error("[series/search]", err);
    res.status(500).json({ error: "Failed to search inventory" });
  }
});

// ── DELETE /series/:id/items/:inventoryId ─────────────────────────────────────
router.delete("/:id/items/:inventoryId", requireAdmin, async (req, res) => {
  try {
    const seriesId = parseInt(String(req.params.id ?? ""), 10);
    const inventoryId = parseInt(String(req.params.inventoryId ?? ""), 10);
    if (isNaN(seriesId) || isNaN(inventoryId)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    await db
      .update(inventoryTable)
      .set({ seriesId: null })
      .where(and(eq(inventoryTable.id, inventoryId), eq(inventoryTable.seriesId, seriesId)));
    res.json({ ok: true });
  } catch (err) {
    console.error("[series/remove-item]", err);
    res.status(500).json({ error: "Failed to remove item from series" });
  }
});

// ── POST /series/:id/items ───────────────────────────────────────────────────
router.post("/:id/items", requireAdmin, async (req, res) => {
  try {
    const id = parseInt(String(req.params.id ?? ""), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const { inventoryIds } = req.body as { inventoryIds?: number[] };
    if (!Array.isArray(inventoryIds) || inventoryIds.length === 0) {
      res.status(400).json({ error: "inventoryIds must be a non-empty array" });
      return;
    }
    await db
      .update(inventoryTable)
      .set({ seriesId: id })
      .where(inArray(inventoryTable.id, inventoryIds));
    res.json({ ok: true, updated: inventoryIds.length });
  } catch (err) {
    console.error("[series/add-items]", err);
    res.status(500).json({ error: "Failed to add items to series" });
  }
});

// ── POST /series/auto-assign ─────────────────────────────────────────────────
// Reads all distinct (vendor, catalog_parse->>'series') pairs, upserts a
// product_series row for each, and bulk-sets series_id on matching inventory
// rows. Streams progress via SSE. Idempotent — safe to re-run.
router.post("/auto-assign", requireAdmin, async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const sendEvent = (data: object) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    sendEvent({ status: "started" });

    // 1. Gather all distinct (vendor, series) pairs from catalog_parse
    const pairsResult = await db.execute(sql`
      SELECT DISTINCT
        vendor,
        catalog_parse->>'series' AS series
      FROM inventory
      WHERE catalog_parse IS NOT NULL
        AND catalog_parse->>'series' IS NOT NULL
        AND catalog_parse->>'series' != ''
      ORDER BY vendor, catalog_parse->>'series'
    `);
    const pairs = (pairsResult as unknown as { rows: Array<{ vendor: string; series: string }> }).rows;

    sendEvent({ status: "progress", step: "upsert_series", total: pairs.length, done: 0 });

    // 2. Upsert product_series rows and collect id mappings
    const seriesIdMap = new Map<string, number>(); // "VENDOR|SERIES" → id
    for (const pair of pairs) {
      const key = `${pair.vendor}|${pair.series}`;
      const result = await db.execute(sql`
        INSERT INTO product_series (vendor, name)
        VALUES (${pair.vendor}, ${pair.series})
        ON CONFLICT (vendor, name) DO UPDATE SET name = EXCLUDED.name
        RETURNING id
      `);
      const id = ((result as unknown as { rows: Array<{ id: number }> }).rows[0])?.id;
      if (id !== undefined) seriesIdMap.set(key, id);
    }

    sendEvent({ status: "progress", step: "assign_items", total: seriesIdMap.size, done: 0 });

    // 3. Bulk-assign series_id on inventory rows
    let assigned = 0;
    for (const [key, seriesId] of seriesIdMap) {
      const [vendor, series] = key.split("|");
      if (!vendor || !series) continue;
      const updateResult = await db.execute(sql`
        UPDATE inventory
        SET series_id = ${seriesId}
        WHERE vendor = ${vendor}
          AND catalog_parse IS NOT NULL
          AND catalog_parse->>'series' = ${series}
          AND (series_id IS NULL OR series_id != ${seriesId})
      `);
      const count = (updateResult as { rowCount?: number }).rowCount ?? 0;
      assigned += count;
      sendEvent({ status: "progress", step: "assign_items", seriesId, vendor, series, rowsUpdated: count, totalAssigned: assigned });
    }

    sendEvent({
      status: "done",
      seriesCount: seriesIdMap.size,
      assignedCount: assigned,
    });
  } catch (err) {
    console.error("[series/auto-assign]", err);
    sendEvent({ status: "error", error: err instanceof Error ? err.message : "Unknown error" });
  } finally {
    res.end();
  }
});

export default router;
