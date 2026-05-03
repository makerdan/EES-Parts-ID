/**
 * POST /api/admin/catalog-pdf/preview
 * POST /api/admin/catalog-pdf/apply
 *
 * Vendor-catalog PDF enrichment flow:
 *
 *   preview accepts the catalog PDF (multipart/form-data with `file` + `vendor`
 *   fields, or raw `application/pdf` body with `vendor` query string), parses
 *   it via the vendor profile, classifies each catalog entry against existing
 *   inventory rows, and returns a report of exact / high-confidence (auto-
 *   applicable) / uncertain (needs review) / unmatched entries.
 *
 *   apply accepts the preview `report` plus a map of `uncertainDecisions`
 *   (`{ [catalogNumber]: inventoryId | "skip" }`). The server itself auto-
 *   applies every `exact` and `highConfidence` row, then applies the worker's
 *   choice for each uncertain row. Bins are never touched. Description fills
 *   when empty (or replaces when the catalog text is materially longer);
 *   aiKeywords are merged case-insensitively, and `enrichedAt` is bumped.
 *
 * Schema note — chip dimensions:
 *   The `inventory` table intentionally does not have separate columns for
 *   chip-dimension facets (category, conduitType, colorChip, tradeSize, …).
 *   Chip filtering in `routes/inventory.ts` is implemented as a `tokenMatch`
 *   over `itemFullText(item)` (description + aiKeywords). Therefore the
 *   correct way to "set" a parsed chip dimension on enrichment is to inject
 *   its label as a keyword. We do this with the same case-insensitive merge
 *   used for vendor keywords, so re-runs are idempotent and never overwrite
 *   an existing chip the row already carries.
 *
 * Multipart is the documented client contract; the raw `application/pdf` body
 * is supported as a convenience because the Bridgeport catalog is ~33 MB and
 * some HTTP clients struggle with multipart payloads of that size. Both paths
 * use a 60 MB limit (the global JSON parser's 25 MB limit is bypassed).
 */

import { Router, raw } from "express";
import multer from "multer";
import { sql, desc, eq, and } from "drizzle-orm";
import {
  db,
  inventoryTable,
  enrichmentRunTable,
  enrichmentHistoryTable,
} from "@workspace/db";
import { verifyAdminToken } from "./admin";
import {
  parseCatalogPdf,
  getVendorProfile,
  listVendorProfiles,
  type CatalogEntry,
} from "../utils/catalogPdfParser";
import {
  classifyEntries,
  summarize,
  type MatchResult,
  type MatchTier,
  type MatchSummary,
} from "../utils/catalogMatch";

const router = Router();

const MAX_PDF_BYTES = 60 * 1024 * 1024;

// ── Admin auth (same contract as other admin routes) ────────────────────────
function requireAdminAuth(
  req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction,
): void {
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    res.status(503).json({ error: "Admin access is not configured. Set ADMIN_PASSWORD." });
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

// ── Response shapes ────────────────────────────────────────────────────────
interface PreviewReportRow {
  catalogNumber: string;
  pageNumbers: number[];
  description: string;
  dimensions: Record<string, string>;
  keywords: string[];
  tier: MatchTier;
  candidates: Array<{
    inventoryId: number;
    vendor: string;
    catalog: string;
    description: string;
    distance: number;
    reason: string;
  }>;
}

interface PreviewReport {
  vendor: string;
  summary: MatchSummary;
  rows: PreviewReportRow[];
}

interface ApplyReport {
  runId: number | null;
  updated: number;
  skippedNoOp: number;
  errors: Array<{ inventoryId: number; error: string }>;
}

interface RunSummary {
  id: number;
  vendor: string;
  sourceFilename: string | null;
  startedAt: string;
  finishedAt: string | null;
  updatedCount: number;
  skippedCount: number;
  errorCount: number;
  revertedAt: string | null;
}

// ── Multipart parser (file=catalog PDF, vendor=text field) ─────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PDF_BYTES },
});

/**
 * Branch the request based on Content-Type:
 *   - multipart/form-data → multer parses `file` + `vendor` body field
 *   - application/pdf     → express.raw stuffs the body into req.body Buffer
 *                           and `vendor` comes from the query string
 */
function pdfBodyParser(
  req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction,
): void {
  const ct = (req.headers["content-type"] ?? "").toLowerCase();
  if (ct.startsWith("multipart/form-data")) {
    upload.single("file")(req, res, next);
  } else if (ct.startsWith("application/pdf")) {
    raw({ type: "application/pdf", limit: MAX_PDF_BYTES })(req, res, next);
  } else {
    res.status(415).json({
      error: "Content-Type must be multipart/form-data (file=PDF, vendor=text) or application/pdf.",
    });
  }
}

// ── GET /admin/catalog-pdf/vendors ─────────────────────────────────────────
//
// Returns the list of supported vendor profiles so the mobile upload picker
// can render a dropdown instead of a free-text vendor field. Each entry
// includes the canonical vendor code (sent back to /preview), the display
// name, and a hint about which catalog PDF the profile expects.
router.get("/catalog-pdf/vendors", requireAdminAuth, (_req, res) => {
  res.json({ vendors: listVendorProfiles() });
});

// ── POST /admin/catalog-pdf/preview ─────────────────────────────────────────
router.post(
  "/catalog-pdf/preview",
  requireAdminAuth,
  pdfBodyParser,
  async (req, res) => {
    try {
      // Vendor: multipart body field OR query string fallback for raw uploads.
      const vendorParam = (
        (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)
          ? (req.body as Record<string, unknown>)["vendor"]
          : undefined) as string | undefined
        ?? (req.query["vendor"] as string | undefined)
        ?? ""
      ).toString().trim();
      if (!vendorParam) {
        return void res.status(400).json({ error: "vendor is required (multipart field or ?vendor= query)" });
      }
      const profile = getVendorProfile(vendorParam);
      if (!profile) {
        const supported = listVendorProfiles().map(p => p.displayName).join(", ");
        return void res.status(400).json({
          error: `No catalog profile is available for vendor "${vendorParam}". Supported vendors: ${supported}.`,
        });
      }

      // Body: multer file buffer or raw express body buffer.
      const file = (req as { file?: Express.Multer.File }).file;
      const buf: Buffer | undefined =
        file?.buffer ?? (Buffer.isBuffer(req.body) ? req.body : undefined);
      if (!buf || buf.length === 0) {
        return void res.status(400).json({
          error: "Missing PDF. Send multipart `file` or raw application/pdf body.",
        });
      }
      if (buf.length < 4 || buf.slice(0, 4).toString() !== "%PDF") {
        return void res.status(400).json({ error: "Body does not look like a PDF (no %PDF header)." });
      }

      // Parse + classify against the vendor's inventory rows.
      const entries = await parseCatalogPdf(buf, profile, { extractBodySnippets: true });
      const inventory = await db
        .select()
        .from(inventoryTable)
        .where(sql`upper(${inventoryTable.vendor}) = ${profile.vendor}`);
      const results = classifyEntries(entries, inventory);

      const report: PreviewReport = {
        vendor: profile.vendor,
        summary: summarize(results),
        rows: results.map(toReportRow),
      };
      res.json(report);
    } catch (err) {
      console.error("[catalog-pdf/preview]", err);
      res.status(500).json({ error: "Failed to parse catalog PDF" });
    }
  },
);

// ── POST /admin/catalog-pdf/apply ───────────────────────────────────────────
//
// Body: { report: PreviewReport, uncertainDecisions: { [catalogNumber]: id | "skip" } }
//
// The server is the source of truth for which rows are auto-applied: every
// row with tier = "exact" or "highConfidence" is applied to its top candidate,
// and each "uncertain" row is applied only when the worker picked a candidate
// in `uncertainDecisions`. "unmatched" rows are always skipped. This keeps
// auto-apply semantics consistent regardless of the client.
router.post("/catalog-pdf/apply", requireAdminAuth, async (req, res) => {
  try {
    const body = req.body as {
      report?: PreviewReport;
      uncertainDecisions?: Record<string, number | "skip">;
      sourceFilename?: string;
    };
    const report = body?.report;
    const uncertainDecisions = body?.uncertainDecisions ?? {};
    const sourceFilename =
      typeof body?.sourceFilename === "string" && body.sourceFilename.trim()
        ? body.sourceFilename.trim().slice(0, 200)
        : null;
    if (!report || !Array.isArray(report.rows)) {
      return void res.status(400).json({ error: "request body must include a `report` from /preview" });
    }

    // Build the effective decision list server-side from the report + picks.
    type Decision = {
      catalogNumber: string;
      inventoryId: number;
      description: string;
      keywords: string[];
      dimensions: Record<string, string>;
    };
    const decisions: Decision[] = [];
    for (const row of report.rows) {
      let inventoryId: number | undefined;
      if (row.tier === "exact" || row.tier === "highConfidence") {
        inventoryId = row.candidates[0]?.inventoryId;
      } else if (row.tier === "uncertain") {
        const pick = uncertainDecisions[row.catalogNumber];
        if (typeof pick === "number" && Number.isFinite(pick)) {
          inventoryId = pick;
        }
      }
      if (inventoryId == null) continue;
      decisions.push({
        catalogNumber: row.catalogNumber,
        inventoryId,
        description: row.description,
        keywords: row.keywords,
        dimensions: row.dimensions,
      });
    }

    // Open the run upfront so every history row references a real id even if
    // the request crashes midway. The summary counts are written at the end.
    const [run] = await db
      .insert(enrichmentRunTable)
      .values({ vendor: report.vendor, sourceFilename })
      .returning({ id: enrichmentRunTable.id });
    const runId = run!.id;

    const result: ApplyReport = { runId, updated: 0, skippedNoOp: 0, errors: [] };

    for (const d of decisions) {
      try {
        // Per-row transaction: the SELECT-then-UPDATE on inventory and the
        // history INSERT must succeed or fail together. Wrapping the whole
        // request in one tx would cause a single bad row to roll back every
        // earlier update — that's not the contract this route had before.
        await db.transaction(async (tx) => {
          const rows = await tx
            .select()
            .from(inventoryTable)
            .where(sql`${inventoryTable.id} = ${d.inventoryId}`)
            .limit(1);
          const existing = rows[0];
          if (!existing) {
            throw new Error("inventory row not found");
          }

          // description: fill when empty, replace when catalog text is
          // materially longer (≥ 1.5× and at least 30 chars).
          const newDesc = (d.description ?? "").trim();
          let nextDesc = existing.description;
          if (newDesc) {
            if (!existing.description.trim()) {
              nextDesc = newDesc;
            } else if (newDesc.length >= 30 && newDesc.length >= existing.description.length * 1.5) {
              nextDesc = newDesc;
            }
          }

          // aiKeywords: case-insensitive merge of catalog keywords +
          // chip-dimension labels. See "Schema note" in the file header.
          const allTokens = [
            ...(d.keywords ?? []),
            ...Object.values(d.dimensions ?? {}),
          ].filter((t): t is string => typeof t === "string" && t.trim().length > 0);
          const merged = mergeKeywordsCaseInsensitive(existing.aiKeywords ?? [], allTokens);

          const beforeKeywords = [...(existing.aiKeywords ?? [])];
          const noChange =
            nextDesc === existing.description &&
            merged.length === beforeKeywords.length &&
            merged.every((v, i) => v === beforeKeywords[i]);
          if (noChange) {
            result.skippedNoOp++;
            return;
          }

          await tx
            .update(inventoryTable)
            .set({
              description: nextDesc,
              aiKeywords: merged,
              enrichedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(sql`${inventoryTable.id} = ${d.inventoryId}`);

          await tx.insert(enrichmentHistoryTable).values({
            runId,
            inventoryId: d.inventoryId,
            catalogNumber: d.catalogNumber,
            beforeDescription: existing.description,
            afterDescription: nextDesc,
            beforeKeywords,
            afterKeywords: merged,
          });

          result.updated++;
        });
      } catch (err) {
        result.errors.push({
          inventoryId: d.inventoryId,
          error: err instanceof Error ? err.message : "update failed",
        });
      }
    }

    // Stamp summary counts so the history UI doesn't need to re-aggregate.
    await db
      .update(enrichmentRunTable)
      .set({
        finishedAt: new Date(),
        updatedCount: result.updated,
        skippedCount: result.skippedNoOp,
        errorCount: result.errors.length,
      })
      .where(eq(enrichmentRunTable.id, runId));

    res.json(result);
  } catch (err) {
    console.error("[catalog-pdf/apply]", err);
    res.status(500).json({ error: "Failed to apply catalog updates" });
  }
});

// ── GET /admin/catalog-pdf/runs ─────────────────────────────────────────────
//
// Lists the most recent catalog-PDF apply runs (newest first). The mobile
// admin UI shows these in a "Recent enrichment runs" section and renders a
// Revert button for each non-reverted run.
router.get("/catalog-pdf/runs", requireAdminAuth, async (req, res) => {
  try {
    const limitParam = req.query["limit"];
    const limitStr = typeof limitParam === "string" ? limitParam : "20";
    const limitRaw = Number.parseInt(limitStr, 10);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, limitRaw)) : 20;

    // Optional filters — both string-equal matches. `vendor` is upper-cased
    // because runs always store the canonical vendor code; `sourceFilename`
    // matches the trimmed value the apply route stored.
    const vendorParam = req.query["vendor"];
    const vendorFilter = typeof vendorParam === "string" && vendorParam.trim()
      ? vendorParam.trim().toUpperCase()
      : null;
    const filenameParam = req.query["sourceFilename"];
    const filenameFilter = typeof filenameParam === "string" && filenameParam.trim()
      ? filenameParam.trim()
      : null;

    const conditions = [];
    if (vendorFilter) conditions.push(eq(enrichmentRunTable.vendor, vendorFilter));
    if (filenameFilter) conditions.push(eq(enrichmentRunTable.sourceFilename, filenameFilter));
    const where = conditions.length === 0
      ? undefined
      : conditions.length === 1
        ? conditions[0]
        : and(...conditions);

    const baseQuery = db.select().from(enrichmentRunTable);
    const filtered = where ? baseQuery.where(where) : baseQuery;
    const rows = await filtered
      .orderBy(desc(enrichmentRunTable.startedAt))
      .limit(limit);
    const runs: RunSummary[] = rows.map((r) => ({
      id: r.id,
      vendor: r.vendor,
      sourceFilename: r.sourceFilename,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      updatedCount: r.updatedCount,
      skippedCount: r.skippedCount,
      errorCount: r.errorCount,
      revertedAt: r.revertedAt?.toISOString() ?? null,
    }));
    res.json({ runs });
  } catch (err) {
    console.error("[catalog-pdf/runs]", err);
    res.status(500).json({ error: "Failed to load enrichment runs" });
  }
});

// ── POST /admin/catalog-pdf/runs/:id/revert ─────────────────────────────────
//
// Restores `description` + `aiKeywords` for every inventory row touched by
// the run, in a single outer transaction so a partial revert is impossible.
// The run is marked `reverted_at = now()` so the UI can grey it out and
// reject double-reverts. Returns the count of rows restored.
router.post("/catalog-pdf/runs/:id/revert", requireAdminAuth, async (req, res) => {
  try {
    const idParam = req.params["id"];
    const runId = Number.parseInt(typeof idParam === "string" ? idParam : "", 10);
    if (!Number.isFinite(runId) || runId <= 0) {
      return void res.status(400).json({ error: "invalid run id" });
    }

    const result = await db.transaction(async (tx) => {
      const runs = await tx
        .select()
        .from(enrichmentRunTable)
        .where(eq(enrichmentRunTable.id, runId))
        .limit(1);
      const run = runs[0];
      if (!run) {
        return { status: 404 as const, body: { error: "run not found" } };
      }
      if (run.revertedAt) {
        return { status: 409 as const, body: { error: "run already reverted" } };
      }

      // Order DESC by id so multiple history rows touching the same
      // inventory row are restored newest→oldest. The final UPDATE per
      // inventory row is the OLDEST history's `before_*`, which is the
      // true pre-run state. (Sorting ASC would leave a row stuck at the
      // intermediate value its second update saw.)
      const history = await tx
        .select()
        .from(enrichmentHistoryTable)
        .where(eq(enrichmentHistoryTable.runId, runId))
        .orderBy(desc(enrichmentHistoryTable.id));

      let restored = 0;
      for (const h of history) {
        await tx
          .update(inventoryTable)
          .set({
            description: h.beforeDescription,
            aiKeywords: h.beforeKeywords,
            updatedAt: new Date(),
          })
          .where(eq(inventoryTable.id, h.inventoryId));
        restored++;
      }

      await tx
        .update(enrichmentRunTable)
        .set({ revertedAt: new Date() })
        .where(eq(enrichmentRunTable.id, runId));

      return { status: 200 as const, body: { runId, restored } };
    });

    res.status(result.status).json(result.body);
  } catch (err) {
    console.error("[catalog-pdf/runs/revert]", err);
    res.status(500).json({ error: "Failed to revert enrichment run" });
  }
});

function toReportRow(r: MatchResult): PreviewReportRow {
  return {
    catalogNumber: r.entry.catalogNumber,
    pageNumbers: r.entry.pageNumbers,
    description: r.entry.description,
    dimensions: r.entry.dimensions,
    keywords: r.entry.keywords,
    tier: r.tier,
    candidates: r.candidates,
  };
}

/**
 * Case-insensitive keyword merge. New tokens are appended in order; tokens
 * whose lowercase form already exists in `existing` (or has just been added)
 * are dropped. The original casing of `existing` is preserved.
 */
function mergeKeywordsCaseInsensitive(existing: readonly string[], incoming: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of existing) {
    const t = k.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  for (const k of incoming) {
    const t = k.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

export { mergeKeywordsCaseInsensitive };
export default router;
export type { CatalogEntry, PreviewReport, PreviewReportRow, ApplyReport };
