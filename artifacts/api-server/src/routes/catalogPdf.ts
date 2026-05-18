/**
 * POST /api/admin/catalog-pdf
 *   Accept a base64-encoded PDF + vendor name. Starts an async background job
 *   that extracts catalog data page-by-page using GPT-4o and updates matched
 *   inventory records. Returns a jobId for polling.
 *
 * GET /api/admin/catalog-pdf/:jobId/status
 *   Return the current progress of a running or completed job.
 *
 * GET /api/admin/catalog-pdf/reviews
 *   List all inventory items where imageSource = 'pdf_extraction', grouped
 *   by job. Supports ?jobId=<n> to filter to a single session.
 *
 * POST /api/admin/catalog-pdf/reviews/:id/revert
 *   Revert a single inventory item: restore previousDescription, clear
 *   imageUrl/imageSource/imageConfidence/catalogPdfJobId.
 */

import { Router } from "express";
import { eq, sql, and, desc } from "drizzle-orm";
import { db } from "@workspace/db";
import { inventoryTable, catalogPdfJobTable } from "@workspace/db";
import { verifyAdminToken } from "./admin";
import { extractPdfPages } from "../utils/pdfProcessor";
import { extractCatalogPage } from "../utils/catalogExtractor";
import { matchCatalogNumber } from "../utils/catalogMatcher";
import { uploadCatalogImage } from "../lib/objectStorage";

const router = Router();

// ── Admin auth middleware ──────────────────────────────────────────────────────
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

// ── In-memory job progress store ──────────────────────────────────────────────
// Jobs are identified by their DB row id (as string) so they survive restarts
// for status queries, but in-memory progress is lost on restart.
interface JobProgress {
  dbId: number;
  vendor: string;
  filename: string;
  status: "pending" | "processing" | "done" | "failed";
  totalPages: number;
  processedPages: number;
  matchedParts: number;
  startedAt: Date;
  finishedAt: Date | null;
  errorMessage: string | null;
}

const activeJobs = new Map<string, JobProgress>();

// ── POST /admin/catalog-pdf ───────────────────────────────────────────────────
router.post("/catalog-pdf", requireAdminAuth, async (req, res) => {
  const {
    pdfBase64,
    vendor,
    filename = "catalog.pdf",
  } = req.body as {
    pdfBase64?: string;
    vendor?: string;
    filename?: string;
  };

  if (!pdfBase64 || typeof pdfBase64 !== "string") {
    return void res.status(400).json({ error: "Missing pdfBase64 field" });
  }
  if (!vendor || typeof vendor !== "string") {
    return void res.status(400).json({ error: "Missing vendor field" });
  }

  // Sanity-check the payload is reasonable (≤25 MB base64 ≈ ~18 MB PDF)
  if (pdfBase64.length > 35_000_000) {
    return void res.status(413).json({ error: "PDF too large (max ~25 MB)" });
  }

  // Create the DB job record
  const [jobRow] = await db
    .insert(catalogPdfJobTable)
    .values({
      vendor: vendor.trim().toUpperCase(),
      filename: filename.trim(),
      status: "pending",
      processedPages: 0,
      matchedParts: 0,
    })
    .returning({ id: catalogPdfJobTable.id });

  if (!jobRow) {
    return void res.status(500).json({ error: "Failed to create job record" });
  }

  const jobId = String(jobRow.id);
  const progress: JobProgress = {
    dbId: jobRow.id,
    vendor: vendor.trim().toUpperCase(),
    filename: filename.trim(),
    status: "pending",
    totalPages: 0,
    processedPages: 0,
    matchedParts: 0,
    startedAt: new Date(),
    finishedAt: null,
    errorMessage: null,
  };
  activeJobs.set(jobId, progress);

  // Respond immediately with the job ID — processing is async
  res.json({ jobId, message: "Job started" });

  // ── Async processing ──────────────────────────────────────────────────────
  setImmediate(async () => {
    progress.status = "processing";
    await db
      .update(catalogPdfJobTable)
      .set({ status: "processing", startedAt: new Date() })
      .where(eq(catalogPdfJobTable.id, jobRow.id));

    try {
      const pdfBuffer = Buffer.from(pdfBase64, "base64");
      const pages = await extractPdfPages(pdfBuffer);

      progress.totalPages = pages.length;
      await db
        .update(catalogPdfJobTable)
        .set({ totalPages: pages.length })
        .where(eq(catalogPdfJobTable.id, jobRow.id));

      for (const page of pages) {
        // Extract catalog entries from this page
        const entries = await extractCatalogPage(page.text, page.images, progress.vendor);

        for (const entry of entries) {
          if (entry.confidence < 0.4) continue;

          const match = await matchCatalogNumber(progress.vendor, entry.catalogNumber);
          if (!match) continue;

          // Fetch the current inventory row (to save previousDescription)
          const [existing] = await db
            .select({
              id: inventoryTable.id,
              description: inventoryTable.description,
              imageSource: inventoryTable.imageSource,
            })
            .from(inventoryTable)
            .where(eq(inventoryTable.id, match.inventoryId))
            .limit(1);

          if (!existing) continue;

          // Upload part image to GCS if available
          let imageUrl: string | null = null;
          if (
            entry.hasPartImage &&
            entry.imageIndex !== null &&
            entry.imageIndex < page.images.length
          ) {
            const imgBuf = page.images[entry.imageIndex];
            if (imgBuf) {
              try {
                imageUrl = await uploadCatalogImage(imgBuf, "image/png");
              } catch (imgErr) {
                console.warn("[catalog-pdf] Image upload failed:", imgErr);
              }
            }
          }

          // Update the inventory record
          await db
            .update(inventoryTable)
            .set({
              description: entry.description || existing.description,
              previousDescription: existing.description,
              imageUrl,
              imageSource: "pdf_extraction",
              imageConfidence: match.similarityScore * entry.confidence,
              catalogPdfJobId: jobRow.id,
              updatedAt: new Date(),
            })
            .where(eq(inventoryTable.id, match.inventoryId));

          progress.matchedParts++;
        }

        progress.processedPages++;
        // Update DB progress every 5 pages to reduce write load
        if (progress.processedPages % 5 === 0 || progress.processedPages === pages.length) {
          await db
            .update(catalogPdfJobTable)
            .set({
              processedPages: progress.processedPages,
              matchedParts: progress.matchedParts,
            })
            .where(eq(catalogPdfJobTable.id, jobRow.id));
        }
      }

      progress.status = "done";
      progress.finishedAt = new Date();
      await db
        .update(catalogPdfJobTable)
        .set({
          status: "done",
          processedPages: progress.processedPages,
          matchedParts: progress.matchedParts,
          finishedAt: new Date(),
        })
        .where(eq(catalogPdfJobTable.id, jobRow.id));

      console.log(
        `[catalog-pdf] job=${jobId} done — pages=${progress.processedPages} matched=${progress.matchedParts}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      progress.status = "failed";
      progress.errorMessage = msg;
      progress.finishedAt = new Date();
      await db
        .update(catalogPdfJobTable)
        .set({ status: "failed", errorMessage: msg, finishedAt: new Date() })
        .where(eq(catalogPdfJobTable.id, jobRow.id));
      console.error(`[catalog-pdf] job=${jobId} failed:`, err);
    }
  });
});

// ── GET /admin/catalog-pdf/:jobId/status ──────────────────────────────────────
router.get("/catalog-pdf/:jobId/status", requireAdminAuth, async (req, res) => {
  const jobId = String(req.params["jobId"] ?? "");

  // Try in-memory first (faster, more current)
  const progress = activeJobs.get(jobId);
  if (progress) {
    return void res.json({
      jobId,
      status: progress.status,
      totalPages: progress.totalPages,
      processedPages: progress.processedPages,
      matchedParts: progress.matchedParts,
      startedAt: progress.startedAt,
      finishedAt: progress.finishedAt,
      errorMessage: progress.errorMessage,
    });
  }

  // Fall back to DB (handles server restarts)
  const [row] = await db
    .select()
    .from(catalogPdfJobTable)
    .where(eq(catalogPdfJobTable.id, Number(jobId)))
    .limit(1);

  if (!row) {
    return void res.status(404).json({ error: "Job not found" });
  }

  res.json({
    jobId,
    status: row.status,
    totalPages: row.totalPages,
    processedPages: row.processedPages,
    matchedParts: row.matchedParts,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    errorMessage: row.errorMessage,
  });
});

// ── GET /admin/catalog-pdf/reviews ────────────────────────────────────────────
// Returns inventory items updated by PDF extraction, with the job metadata
// and the before/after description for review.
router.get("/catalog-pdf/reviews", requireAdminAuth, async (req, res) => {
  try {
    const jobIdFilter = req.query["jobId"] ? Number(req.query["jobId"]) : null;

    const rows = await db
      .select({
        id: inventoryTable.id,
        vendor: inventoryTable.vendor,
        catalog: inventoryTable.catalog,
        description: inventoryTable.description,
        previousDescription: inventoryTable.previousDescription,
        imageUrl: inventoryTable.imageUrl,
        imageSource: inventoryTable.imageSource,
        imageConfidence: inventoryTable.imageConfidence,
        catalogPdfJobId: inventoryTable.catalogPdfJobId,
        updatedAt: inventoryTable.updatedAt,
      })
      .from(inventoryTable)
      .where(
        jobIdFilter !== null
          ? and(
              sql`${inventoryTable.imageSource} = 'pdf_extraction'`,
              eq(inventoryTable.catalogPdfJobId, jobIdFilter),
            )
          : sql`${inventoryTable.imageSource} = 'pdf_extraction'`,
      )
      .orderBy(desc(inventoryTable.catalogPdfJobId), desc(inventoryTable.updatedAt));

    // Attach job metadata for grouping
    const jobIds = [...new Set(rows.map((r) => r.catalogPdfJobId).filter(Boolean))] as number[];
    let jobs: { id: number; vendor: string; filename: string; status: string; createdAt: Date }[] = [];
    if (jobIds.length > 0) {
      jobs = await db
        .select({
          id: catalogPdfJobTable.id,
          vendor: catalogPdfJobTable.vendor,
          filename: catalogPdfJobTable.filename,
          status: catalogPdfJobTable.status,
          createdAt: catalogPdfJobTable.createdAt,
        })
        .from(catalogPdfJobTable)
        .where(sql`${catalogPdfJobTable.id} = ANY(${jobIds})`);
    }

    const jobMap = new Map(jobs.map((j) => [j.id, j]));

    res.json({
      items: rows.map((r) => ({
        ...r,
        job: r.catalogPdfJobId ? (jobMap.get(r.catalogPdfJobId) ?? null) : null,
        isLowConfidence: (r.imageConfidence ?? 1) < 0.6,
      })),
      total: rows.length,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch reviews" });
  }
});

// ── POST /admin/catalog-pdf/reviews/:id/revert ────────────────────────────────
router.post("/catalog-pdf/reviews/:id/revert", requireAdminAuth, async (req, res) => {
  const id = Number(req.params["id"]);
  if (!id || isNaN(id)) {
    return void res.status(400).json({ error: "Invalid item ID" });
  }

  const [row] = await db
    .select({
      id: inventoryTable.id,
      previousDescription: inventoryTable.previousDescription,
      imageSource: inventoryTable.imageSource,
    })
    .from(inventoryTable)
    .where(eq(inventoryTable.id, id))
    .limit(1);

  if (!row) {
    return void res.status(404).json({ error: "Item not found" });
  }

  if (row.imageSource !== "pdf_extraction") {
    return void res.status(400).json({ error: "Item was not updated by PDF extraction" });
  }

  await db
    .update(inventoryTable)
    .set({
      description: row.previousDescription ?? "",
      previousDescription: null,
      imageUrl: null,
      imageSource: null,
      imageConfidence: null,
      catalogPdfJobId: null,
      updatedAt: new Date(),
    })
    .where(eq(inventoryTable.id, id));

  res.json({ ok: true });
});

export default router;
