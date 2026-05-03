/**
 * Barcode routes — scan-to-find and scan-to-link for the warehouse.
 *
 *   POST /api/barcode/lookup  — two-stage lookup: catalog match first,
 *                               then mapping table. Returns the part
 *                               (or null) plus a recently-viewed list
 *                               so the no-match panel can render
 *                               immediately.
 *   POST /api/barcode/link    — bind a barcode to an inventory row.
 *                               Idempotent for same (barcode, item);
 *                               409 conflict for re-links unless
 *                               `force: true` is supplied.
 *   GET  /api/barcode/recent  — most recently linked / scanned parts,
 *                               used as the empty-state list.
 *
 * Auth posture mirrors the inventory routes: read paths (`/lookup`,
 * `/recent`) are open like `/inventory/search`; the mutating `/link`
 * endpoint is behind the same `requireAdminAuth` middleware that
 * gates `/inventory/upsert-batch` so an unauthenticated client can't
 * rebind barcodes to arbitrary parts. Workers signed in as admin
 * (the same flow that unlocks the Upload tab) can scan-to-link.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { eq, sql, desc } from "drizzle-orm";
import {
  db,
  inventoryTable,
  inventoryBarcodeTable,
  vendorMapTable,
  type Inventory,
  type BarcodeSource,
} from "@workspace/db";
import { normalizeBarcode } from "../utils/normalizeBarcode";
import { verifyAdminToken } from "./admin";
import {
  buildVendorFullNameMap,
  withVendorFullName,
  type VendorMapRow,
} from "../utils/vendorFullName";

const router = Router();

/** Same admin-token gate used by the inventory upsert/enrich endpoints. */
function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  const adminPassword = process.env["ADMIN_PASSWORD"];
  if (!adminPassword) {
    res.status(503).json({
      error: "Admin access is not configured on this server. Set ADMIN_PASSWORD.",
    });
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

type InventoryRow = Inventory;

/** Load the `vendor_map` once per request and return a code → full-name map. */
async function loadVendorMap(): Promise<Map<string, string>> {
  const vendors: VendorMapRow[] = await db
    .select({ code: vendorMapTable.code, names: vendorMapTable.names })
    .from(vendorMapTable);
  return buildVendorFullNameMap(vendors);
}

/** Hydrate a raw inventory row into the API-shaped item the mobile client expects. */
function hydrate(item: InventoryRow, vendorMap: Map<string, string>) {
  return withVendorFullName(
    {
      ...item,
      binLocations: item.binLocations ?? [],
      aiKeywords: item.aiKeywords ?? [],
    },
    vendorMap,
  );
}

/**
 * Find the most-recently active inventory rows. Prefers items that have
 * recently been linked through the barcode table (clear "scanned"
 * signal), then falls back to recently updated inventory rows so the
 * empty-state list is never empty on a fresh deployment.
 */
async function loadRecent(limit: number, vendorMap: Map<string, string>) {
  const recentLinked = await db
    .select({ inv: inventoryTable, linked: inventoryBarcodeTable.createdAt })
    .from(inventoryBarcodeTable)
    .innerJoin(inventoryTable, eq(inventoryBarcodeTable.inventoryId, inventoryTable.id))
    .orderBy(desc(inventoryBarcodeTable.createdAt))
    .limit(limit);

  const seen = new Set<number>();
  const items: ReturnType<typeof hydrate>[] = [];
  for (const r of recentLinked) {
    if (seen.has(r.inv.id)) continue;
    seen.add(r.inv.id);
    items.push(hydrate(r.inv, vendorMap));
    if (items.length >= limit) return items;
  }

  if (items.length < limit) {
    const fill = await db
      .select()
      .from(inventoryTable)
      .orderBy(desc(inventoryTable.updatedAt))
      .limit(limit - items.length + seen.size);
    for (const row of fill) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      items.push(hydrate(row, vendorMap));
      if (items.length >= limit) break;
    }
  }
  return items;
}

// ── POST /barcode/lookup ─────────────────────────────────────────────────────
router.post("/lookup", async (req, res) => {
  try {
    const raw = typeof req.body?.barcode === "string" ? req.body.barcode : "";
    const barcode = normalizeBarcode(raw);
    if (!barcode) {
      res.status(400).json({ error: "barcode is required" });
      return;
    }

    const vendorMap = await loadVendorMap();
    const recentlyViewed = await loadRecent(20, vendorMap);

    // Stage 1 — does the scanned string equal an existing inventory.catalog?
    // Case-insensitive so ALU2C2 matches alu2c2. We pick the most recently
    // updated row when multiple vendors carry the same catalog code so the
    // first auto-link wins.
    const catalogHits = await db
      .select()
      .from(inventoryTable)
      .where(sql`upper(${inventoryTable.catalog}) = ${barcode}`)
      .orderBy(desc(inventoryTable.updatedAt))
      .limit(1);
    if (catalogHits.length > 0) {
      const item = catalogHits[0]!;
      // Persist the binding so future scans skip the catalog scan.
      await db
        .insert(inventoryBarcodeTable)
        .values({ barcode, inventoryId: item.id, source: "catalog-auto" })
        .onConflictDoNothing();
      res.json({
        match: hydrate(item, vendorMap),
        source: "catalog-auto" as BarcodeSource,
        recentlyViewed,
      });
      return;
    }

    // Stage 2 — consult the mapping table.
    const mapped = await db
      .select({ inv: inventoryTable, source: inventoryBarcodeTable.source })
      .from(inventoryBarcodeTable)
      .innerJoin(inventoryTable, eq(inventoryBarcodeTable.inventoryId, inventoryTable.id))
      .where(eq(inventoryBarcodeTable.barcode, barcode))
      .limit(1);
    if (mapped.length > 0) {
      const row = mapped[0]!;
      res.json({
        match: hydrate(row.inv, vendorMap),
        source: row.source as BarcodeSource,
        recentlyViewed,
      });
      return;
    }

    // No match — let the client open the scan-to-link picker.
    res.json({ match: null, source: null, recentlyViewed });
  } catch (err) {
    console.error("/barcode/lookup failed", err);
    res.status(500).json({ error: "Failed to look up barcode" });
  }
});

// ── POST /barcode/link ───────────────────────────────────────────────────────
router.post("/link", requireAdminAuth, async (req, res) => {
  try {
    const raw = typeof req.body?.barcode === "string" ? req.body.barcode : "";
    const barcode = normalizeBarcode(raw);
    const inventoryId = Number(req.body?.inventoryId);
    const force = req.body?.force === true;
    const createdBy = typeof req.body?.createdBy === "string" ? req.body.createdBy : null;

    if (!barcode) {
      res.status(400).json({ error: "barcode is required" });
      return;
    }
    if (!Number.isInteger(inventoryId) || inventoryId <= 0) {
      res.status(400).json({ error: "inventoryId must be a positive integer" });
      return;
    }

    const targetRows = await db
      .select()
      .from(inventoryTable)
      .where(eq(inventoryTable.id, inventoryId))
      .limit(1);
    if (targetRows.length === 0) {
      res.status(404).json({ error: "inventory item not found" });
      return;
    }
    const target = targetRows[0]!;

    const vendorMap = await loadVendorMap();

    const existing = await db
      .select()
      .from(inventoryBarcodeTable)
      .where(eq(inventoryBarcodeTable.barcode, barcode))
      .limit(1);

    if (existing.length > 0) {
      const row = existing[0]!;
      // Idempotent re-link to the same item: return ok without writing.
      if (row.inventoryId === inventoryId) {
        res.json({ ok: true, item: hydrate(target, vendorMap) });
        return;
      }
      // Conflict — barcode is already bound to a different active part.
      if (!force) {
        res.status(409).json({
          error: "barcode is already linked to a different part",
          currentInventoryId: row.inventoryId,
        });
        return;
      }
      // Force override: replace the binding.
      await db
        .update(inventoryBarcodeTable)
        .set({
          inventoryId,
          source: "upc-linked",
          createdAt: new Date(),
          createdBy,
        })
        .where(eq(inventoryBarcodeTable.barcode, barcode));
      res.json({ ok: true, item: hydrate(target, vendorMap) });
      return;
    }

    await db
      .insert(inventoryBarcodeTable)
      .values({
        barcode,
        inventoryId,
        source: "upc-linked",
        createdBy,
      });
    res.json({ ok: true, item: hydrate(target, vendorMap) });
  } catch (err) {
    console.error("/barcode/link failed", err);
    res.status(500).json({ error: "Failed to link barcode" });
  }
});

// ── GET /barcode/recent ──────────────────────────────────────────────────────
router.get("/recent", async (req, res) => {
  try {
    const limit = Math.min(50, Math.max(1, Number(req.query["limit"]) || 20));
    const vendorMap = await loadVendorMap();
    const items = await loadRecent(limit, vendorMap);
    res.json({ items });
  } catch (err) {
    console.error("/barcode/recent failed", err);
    res.status(500).json({ error: "Failed to load recent items" });
  }
});

export default router;
