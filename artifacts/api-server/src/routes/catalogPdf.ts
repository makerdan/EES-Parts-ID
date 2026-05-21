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
  const normalizedVendor = vendor.trim().toUpperCase();

  // Respond immediately with the job ID — processing is async
  res.json({ jobId, message: "Job started" });

  // ── Async processing ──────────────────────────────────────────────────────
  setImmediate(async () => {
    await db
      .update(catalogPdfJobTable)
      .set({ status: "processing", startedAt: new Date() })
      .where(eq(catalogPdfJobTable.id, jobRow.id));

    try {
      const pdfBuffer = Buffer.from(pdfBase64, "base64");
      const pages = await extractPdfPages(pdfBuffer);

      await db
        .update(catalogPdfJobTable)
        .set({ totalPages: pages.length })
        .where(eq(catalogPdfJobTable.id, jobRow.id));

      let processedPages = 0;
      let matchedParts = 0;

      for (const page of pages) {
        // Extract catalog entries from this page
        const entries = await extractCatalogPage(page.text, page.images, normalizedVendor);

        for (const entry of entries) {
          if (entry.confidence < 0.4) continue;

          const match = await matchCatalogNumber(normalizedVendor, entry.catalogNumber);
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

          // Upload part image to GCS if available.
          // Primary: page is rendered (pdftoppm) + entry has imageRegion → crop
          //          the region from the rendered page image using sharp.
          // Fallback: page has embedded images → upload the first one.
          let imageUrl: string | null = null;
          if (entry.hasPartImage && page.images.length > 0) {
            const srcImg = page.images[0];
            if (srcImg) {
              let imgToBuf: Buffer = srcImg;
              if (page.isRendered && entry.imageRegion && page.pageWidth > 0 && page.pageHeight > 0) {
                try {
                  const { x, y, width, height } = entry.imageRegion;
                  // Convert normalised coords to pixel region with safe clamping
                  const left = Math.max(0, Math.round(x * page.pageWidth));
                  const top = Math.max(0, Math.round(y * page.pageHeight));
                  const w = Math.min(page.pageWidth - left, Math.max(1, Math.round(width * page.pageWidth)));
                  const h = Math.min(page.pageHeight - top, Math.max(1, Math.round(height * page.pageHeight)));
                  const sharp = await import("sharp");
                  imgToBuf = await (sharp.default ?? sharp)(srcImg)
                    .extract({ left, top, width: w, height: h })
                    .png()
                    .toBuffer();
                } catch (cropErr) {
                  console.warn("[catalog-pdf] Crop failed, using full page:", cropErr);
                  imgToBuf = srcImg;
                }
              }
              try {
                imageUrl = await uploadCatalogImage(imgToBuf, "image/png");
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

          matchedParts++;
        }

        processedPages++;
        // Persist progress to DB on every page so a restart can recover
        await db
          .update(catalogPdfJobTable)
          .set({
            processedPages,
            matchedParts,
          })
          .where(eq(catalogPdfJobTable.id, jobRow.id));
      }

      await db
        .update(catalogPdfJobTable)
        .set({
          status: "done",
          processedPages,
          matchedParts,
          finishedAt: new Date(),
        })
        .where(eq(catalogPdfJobTable.id, jobRow.id));

      console.log(
        `[catalog-pdf] job=${jobId} done — pages=${processedPages} matched=${matchedParts}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
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

// ── GET /admin/catalog-pdf/failed-jobs ────────────────────────────────────────
// Returns jobs that are in `failed` status and not dismissed, ordered newest-first.
router.get("/catalog-pdf/failed-jobs", requireAdminAuth, async (req, res) => {
  try {
    const rows = await db
      .select({
        id: catalogPdfJobTable.id,
        vendor: catalogPdfJobTable.vendor,
        filename: catalogPdfJobTable.filename,
        status: catalogPdfJobTable.status,
        errorMessage: catalogPdfJobTable.errorMessage,
        createdAt: catalogPdfJobTable.createdAt,
        finishedAt: catalogPdfJobTable.finishedAt,
        processedPages: catalogPdfJobTable.processedPages,
        totalPages: catalogPdfJobTable.totalPages,
        matchedParts: catalogPdfJobTable.matchedParts,
      })
      .from(catalogPdfJobTable)
      .where(and(
        eq(catalogPdfJobTable.status, "failed"),
        eq(catalogPdfJobTable.dismissed, false),
      ))
      .orderBy(desc(catalogPdfJobTable.createdAt));

    res.json({ jobs: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch failed jobs" });
  }
});

// ── POST /admin/catalog-pdf/:jobId/resume ─────────────────────────────────────
// Resume a failed (or stuck-processing) job from the last persisted page.
// Body: { pdfBase64: string }
router.post("/catalog-pdf/:jobId/resume", requireAdminAuth, async (req, res) => {
  const jobId = Number(req.params["jobId"]);
  if (!Number.isFinite(jobId)) {
    res.status(400).json({ error: "Invalid jobId" });
    return;
  }

  const { pdfBase64 } = req.body as { pdfBase64?: string };
  if (!pdfBase64 || typeof pdfBase64 !== "string") {
    res.status(400).json({ error: "Missing pdfBase64 field" });
    return;
  }
  if (pdfBase64.length > 35_000_000) {
    res.status(413).json({ error: "PDF too large (max ~25 MB)" });
    return;
  }

  // Fetch the existing job
  const [jobRow] = await db
    .select()
    .from(catalogPdfJobTable)
    .where(eq(catalogPdfJobTable.id, jobId))
    .limit(1);

  if (!jobRow) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  if (jobRow.status !== "failed" && jobRow.status !== "processing") {
    res.status(409).json({
      error: `Cannot resume a job with status "${jobRow.status}". Only failed or processing jobs can be resumed.`,
    });
    return;
  }

  const resumeFromPage = jobRow.processedPages ?? 0;
  const normalizedVendor = jobRow.vendor;

  // Transition back to processing
  await db
    .update(catalogPdfJobTable)
    .set({ status: "processing", errorMessage: null, finishedAt: null })
    .where(eq(catalogPdfJobTable.id, jobId));

  res.json({ jobId: String(jobId), message: "Job resuming", resumeFromPage });

  // ── Async resume processing ────────────────────────────────────────────────
  setImmediate(async () => {
    try {
      const pdfBuffer = Buffer.from(pdfBase64, "base64");
      const pages = await extractPdfPages(pdfBuffer);

      // Update total pages in case it was unknown
      await db
        .update(catalogPdfJobTable)
        .set({ totalPages: pages.length })
        .where(eq(catalogPdfJobTable.id, jobId));

      // Skip already-processed pages
      const remainingPages = pages.slice(resumeFromPage);

      let processedPages = resumeFromPage;
      let matchedParts = jobRow.matchedParts ?? 0;

      for (const page of remainingPages) {
        const entries = await extractCatalogPage(page.text, page.images, normalizedVendor);

        for (const entry of entries) {
          if (entry.confidence < 0.4) continue;

          const match = await matchCatalogNumber(normalizedVendor, entry.catalogNumber);
          if (!match) continue;

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

          let imageUrl: string | null = null;
          if (entry.hasPartImage && page.images.length > 0) {
            const srcImg = page.images[0];
            if (srcImg) {
              let imgToBuf: Buffer = srcImg;
              if (page.isRendered && entry.imageRegion && page.pageWidth > 0 && page.pageHeight > 0) {
                try {
                  const { x, y, width, height } = entry.imageRegion;
                  const left = Math.max(0, Math.round(x * page.pageWidth));
                  const top = Math.max(0, Math.round(y * page.pageHeight));
                  const w = Math.min(page.pageWidth - left, Math.max(1, Math.round(width * page.pageWidth)));
                  const h = Math.min(page.pageHeight - top, Math.max(1, Math.round(height * page.pageHeight)));
                  const sharp = await import("sharp");
                  imgToBuf = await (sharp.default ?? sharp)(srcImg)
                    .extract({ left, top, width: w, height: h })
                    .png()
                    .toBuffer();
                } catch (cropErr) {
                  console.warn("[catalog-pdf] Crop failed, using full page:", cropErr);
                  imgToBuf = srcImg;
                }
              }
              try {
                imageUrl = await uploadCatalogImage(imgToBuf, "image/png");
              } catch (imgErr) {
                console.warn("[catalog-pdf] Image upload failed:", imgErr);
              }
            }
          }

          await db
            .update(inventoryTable)
            .set({
              description: entry.description || existing.description,
              previousDescription: existing.description,
              imageUrl,
              imageSource: "pdf_extraction",
              imageConfidence: match.similarityScore * entry.confidence,
              catalogPdfJobId: jobId,
              updatedAt: new Date(),
            })
            .where(eq(inventoryTable.id, match.inventoryId));

          matchedParts++;
        }

        processedPages++;
        await db
          .update(catalogPdfJobTable)
          .set({ processedPages, matchedParts })
          .where(eq(catalogPdfJobTable.id, jobId));
      }

      await db
        .update(catalogPdfJobTable)
        .set({ status: "done", processedPages, matchedParts, finishedAt: new Date() })
        .where(eq(catalogPdfJobTable.id, jobId));

      console.log(
        `[catalog-pdf] job=${jobId} resumed and done — pages=${processedPages} matched=${matchedParts}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await db
        .update(catalogPdfJobTable)
        .set({ status: "failed", errorMessage: msg, finishedAt: new Date() })
        .where(eq(catalogPdfJobTable.id, jobId));
      console.error(`[catalog-pdf] job=${jobId} resume failed:`, err);
    }
  });
});

// ── POST /admin/catalog-pdf/:jobId/dismiss ────────────────────────────────────
// Marks a failed job as dismissed so it no longer appears in the failed list.
router.post("/catalog-pdf/:jobId/dismiss", requireAdminAuth, async (req, res) => {
  const jobId = Number(req.params["jobId"]);
  if (!Number.isFinite(jobId)) {
    res.status(400).json({ error: "Invalid jobId" });
    return;
  }
  try {
    const updated = await db
      .update(catalogPdfJobTable)
      .set({ dismissed: true })
      .where(and(
        eq(catalogPdfJobTable.id, jobId),
        eq(catalogPdfJobTable.status, "failed"),
      ))
      .returning({ id: catalogPdfJobTable.id });

    if (updated.length === 0) {
      res.status(404).json({ error: "Job not found or not in failed state" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to dismiss job" });
  }
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
