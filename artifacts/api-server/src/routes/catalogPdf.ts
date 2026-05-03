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
import { sql } from "drizzle-orm";
import { db, inventoryTable } from "@workspace/db";
import { verifyAdminToken } from "./admin";
import {
  parseCatalogPdf,
  getVendorProfile,
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
  updated: number;
  skippedNoOp: number;
  errors: Array<{ inventoryId: number; error: string }>;
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
        return void res.status(400).json({
          error: `No catalog profile is available for vendor "${vendorParam}". Currently only Bridgeport is supported.`,
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
    };
    const report = body?.report;
    const uncertainDecisions = body?.uncertainDecisions ?? {};
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

    const result: ApplyReport = { updated: 0, skippedNoOp: 0, errors: [] };

    for (const d of decisions) {
      try {
        const rows = await db
          .select()
          .from(inventoryTable)
          .where(sql`${inventoryTable.id} = ${d.inventoryId}`)
          .limit(1);
        const existing = rows[0];
        if (!existing) {
          result.errors.push({ inventoryId: d.inventoryId, error: "inventory row not found" });
          continue;
        }

        // ── description: fill when empty, replace when catalog text is
        //    materially longer (≥ 1.5× and at least 30 chars).
        const newDesc = (d.description ?? "").trim();
        let nextDesc = existing.description;
        if (newDesc) {
          if (!existing.description.trim()) {
            nextDesc = newDesc;
          } else if (newDesc.length >= 30 && newDesc.length >= existing.description.length * 1.5) {
            nextDesc = newDesc;
          }
        }

        // ── aiKeywords: case-insensitive merge of catalog keywords +
        //    chip-dimension labels. See "Schema note" in the file header for
        //    why dimension chips are stored as keywords on this schema.
        const allTokens = [
          ...(d.keywords ?? []),
          ...Object.values(d.dimensions ?? {}),
        ].filter((t): t is string => typeof t === "string" && t.trim().length > 0);
        const merged = mergeKeywordsCaseInsensitive(existing.aiKeywords ?? [], allTokens);

        const noChange =
          nextDesc === existing.description &&
          merged.length === (existing.aiKeywords?.length ?? 0) &&
          merged.every((v, i) => v === existing.aiKeywords?.[i]);
        if (noChange) {
          result.skippedNoOp++;
          continue;
        }

        await db
          .update(inventoryTable)
          .set({
            description: nextDesc,
            aiKeywords: merged,
            enrichedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(sql`${inventoryTable.id} = ${d.inventoryId}`);
        result.updated++;
      } catch (err) {
        result.errors.push({
          inventoryId: d.inventoryId,
          error: err instanceof Error ? err.message : "update failed",
        });
      }
    }

    res.json(result);
  } catch (err) {
    console.error("[catalog-pdf/apply]", err);
    res.status(500).json({ error: "Failed to apply catalog updates" });
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
