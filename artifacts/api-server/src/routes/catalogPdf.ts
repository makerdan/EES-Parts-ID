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
import type { ImageRegion } from "../utils/catalogExtractor";
import { matchCatalogNumber } from "../utils/catalogMatcher";
import { uploadCatalogImage } from "../lib/objectStorage";

const router = Router();

// ── PDF validation helper ──────────────────────────────────────────────────────
// Decodes a small prefix of the base64 payload and validates it looks like a
// real, non-encrypted PDF before we do any database work or async processing.
//
// Returns null if the payload is valid, or an error descriptor if it is not:
//   { status: 400, message: string }
function validatePdfBase64(pdfBase64: string): { status: 400; message: string } | null {
  // Decode enough bytes to cover the magic bytes + a reasonable header scan.
  // 4 KB of base64 ≈ ~3 KB of binary, more than enough to find %PDF- and /Encrypt.
  const PREFIX_B64_LEN = 5500; // ~4 KB decoded
  const prefix = Buffer.from(pdfBase64.slice(0, PREFIX_B64_LEN), "base64");

  // Check PDF magic bytes — every valid PDF starts with "%PDF-"
  if (prefix.length < 5 || prefix.slice(0, 5).toString("ascii") !== "%PDF-") {
    return { status: 400, message: "Invalid file: not a PDF (missing %PDF- header)" };
  }

  // Check for password protection — encrypted PDFs contain an /Encrypt dictionary
  if (prefix.includes("/Encrypt")) {
    return { status: 400, message: "Invalid file: PDF is password-protected. Remove the password and try again." };
  }

  return null;
}

// ── Image helper ──────────────────────────────────────────────────────────────
// Selects or crops the correct image buffer for one image slot of a catalog entry.
//
// Rendered-page path (page.isRendered = true):
//   page.images[0] is the full rendered page PNG. We crop using the normalised
//   imageRegion bounding box.
//
// Embedded-image path (page.isRendered = false):
//   page.images is an array of individual image objects extracted by pdfjs-dist.
//   We select by index so each part gets the right image, not always images[0].
//
// Returns null when there's nothing valid to upload.
type PageCtx = {
  isRendered: boolean;
  images: Buffer[];
  pageWidth: number;
  pageHeight: number;
};
async function cropOrSelectImage(
  page: PageCtx,
  imageRegion: ImageRegion | null,
  imageIndex: number,
): Promise<Buffer | null> {
  if (page.isRendered) {
    const srcImg = page.images[0];
    if (!srcImg || !imageRegion || page.pageWidth <= 0 || page.pageHeight <= 0) return null;
    const { x, y, width, height } = imageRegion;
    if (width * height < 0.02 || width * height > 0.85) return null;
    try {
      const left = Math.max(0, Math.round(x * page.pageWidth));
      const top = Math.max(0, Math.round(y * page.pageHeight));
      const w = Math.min(page.pageWidth - left, Math.max(1, Math.round(width * page.pageWidth)));
      const h = Math.min(page.pageHeight - top, Math.max(1, Math.round(height * page.pageHeight)));
      const sharp = await import("sharp");
      return await (sharp.default ?? sharp)(srcImg)
        .extract({ left, top, width: w, height: h })
        .png()
        .toBuffer();
    } catch (cropErr) {
      console.warn("[catalog-pdf] Crop failed, skipping image:", cropErr);
      return null;
    }
  } else {
    if (imageIndex < 0 || imageIndex >= page.images.length) return null;
    return page.images[imageIndex] ?? null;
  }
}

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

  // Validate magic bytes and reject encrypted PDFs before touching the DB
  const pdfValidationError = validatePdfBase64(pdfBase64);
  if (pdfValidationError) {
    return void res.status(pdfValidationError.status).json({ error: pdfValidationError.message });
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
      let imagesMatched = 0;
      let wasCancelled = false;

      for (const page of pages) {
        // Check for cancellation before processing each page
        const [currentRow] = await db
          .select({ status: catalogPdfJobTable.status })
          .from(catalogPdfJobTable)
          .where(eq(catalogPdfJobTable.id, jobRow.id))
          .limit(1);
        if (currentRow?.status === "cancelled") {
          wasCancelled = true;
          break;
        }

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

          // Upload up to two images per part using cropOrSelectImage.
          // Slot 1 → imageUrl, Slot 2 → imageUrl2.
          // The helper automatically handles rendered-page crop vs embedded-image index.
          let imageUrl: string | null = null;
          let imageUrl2: string | null = null;
          if (entry.hasPartImage && page.images.length > 0) {
            const buf1 = await cropOrSelectImage(page, entry.imageRegion, entry.imageIndex);
            if (buf1) {
              try { imageUrl = await uploadCatalogImage(buf1, "image/png"); }
              catch (err) { console.warn("[catalog-pdf] Image 1 upload failed:", err); }
            }
            const buf2 = await cropOrSelectImage(page, entry.imageRegion2, entry.imageIndex2);
            if (buf2) {
              try { imageUrl2 = await uploadCatalogImage(buf2, "image/png"); }
              catch (err) { console.warn("[catalog-pdf] Image 2 upload failed:", err); }
            }
          }

          // Update the inventory record
          await db
            .update(inventoryTable)
            .set({
              description: entry.description || existing.description,
              previousDescription: existing.description,
              imageUrl,
              imageUrl2,
              imageSource: "pdf_extraction",
              imageConfidence: match.similarityScore * entry.confidence,
              catalogPdfJobId: jobRow.id,
              updatedAt: new Date(),
            })
            .where(eq(inventoryTable.id, match.inventoryId));

          if (imageUrl) imagesMatched++;
          matchedParts++;
        }

        processedPages++;
        // Persist progress to DB on every page so a restart can recover
        await db
          .update(catalogPdfJobTable)
          .set({
            processedPages,
            matchedParts,
            imagesMatched,
          })
          .where(eq(catalogPdfJobTable.id, jobRow.id));
      }

      if (wasCancelled) {
        await db
          .update(catalogPdfJobTable)
          .set({ finishedAt: new Date() })
          .where(eq(catalogPdfJobTable.id, jobRow.id));
        console.log(`[catalog-pdf] job=${jobId} cancelled after page ${processedPages}`);
        return;
      }

      await db
        .update(catalogPdfJobTable)
        .set({
          status: "done",
          processedPages,
          matchedParts,
          imagesMatched,
          finishedAt: new Date(),
        })
        .where(eq(catalogPdfJobTable.id, jobRow.id));

      console.log(
        `[catalog-pdf] job=${jobId} done — pages=${processedPages} matched=${matchedParts} images=${imagesMatched}`,
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

// ── POST /admin/catalog-pdf/:jobId/cancel ─────────────────────────────────────
// Marks a running job as cancelled. The background processing loop checks for
// this status between pages and stops cleanly without marking the job as done.
router.post("/catalog-pdf/:jobId/cancel", requireAdminAuth, async (req, res) => {
  const jobId = Number(req.params["jobId"]);
  if (!Number.isFinite(jobId)) {
    res.status(400).json({ error: "Invalid jobId" });
    return;
  }

  const [jobRow] = await db
    .select({ id: catalogPdfJobTable.id, status: catalogPdfJobTable.status })
    .from(catalogPdfJobTable)
    .where(eq(catalogPdfJobTable.id, jobId))
    .limit(1);

  if (!jobRow) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  if (jobRow.status !== "pending" && jobRow.status !== "processing") {
    res.status(409).json({
      error: `Cannot cancel a job with status "${jobRow.status}". Only pending or processing jobs can be cancelled.`,
    });
    return;
  }

  await db
    .update(catalogPdfJobTable)
    .set({ status: "cancelled", finishedAt: new Date() })
    .where(eq(catalogPdfJobTable.id, jobId));

  console.log(`[catalog-pdf] job=${jobId} cancel requested`);
  res.json({ ok: true, jobId: String(jobId) });
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
    imagesMatched: row.imagesMatched,
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

  // Validate magic bytes and reject encrypted PDFs before touching the DB
  const pdfValidationError = validatePdfBase64(pdfBase64);
  if (pdfValidationError) {
    res.status(pdfValidationError.status).json({ error: pdfValidationError.message });
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
      let imagesMatched = jobRow.imagesMatched ?? 0;
      let wasCancelled = false;

      for (const page of remainingPages) {
        // Check for cancellation before processing each page
        const [currentRow] = await db
          .select({ status: catalogPdfJobTable.status })
          .from(catalogPdfJobTable)
          .where(eq(catalogPdfJobTable.id, jobId))
          .limit(1);
        if (currentRow?.status === "cancelled") {
          wasCancelled = true;
          break;
        }

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
          let imageUrl2: string | null = null;
          if (entry.hasPartImage && page.images.length > 0) {
            const buf1 = await cropOrSelectImage(page, entry.imageRegion, entry.imageIndex);
            if (buf1) {
              try { imageUrl = await uploadCatalogImage(buf1, "image/png"); }
              catch (err) { console.warn("[catalog-pdf] Image 1 upload failed:", err); }
            }
            const buf2 = await cropOrSelectImage(page, entry.imageRegion2, entry.imageIndex2);
            if (buf2) {
              try { imageUrl2 = await uploadCatalogImage(buf2, "image/png"); }
              catch (err) { console.warn("[catalog-pdf] Image 2 upload failed:", err); }
            }
          }

          await db
            .update(inventoryTable)
            .set({
              description: entry.description || existing.description,
              previousDescription: existing.description,
              imageUrl,
              imageUrl2,
              imageSource: "pdf_extraction",
              imageConfidence: match.similarityScore * entry.confidence,
              catalogPdfJobId: jobId,
              updatedAt: new Date(),
            })
            .where(eq(inventoryTable.id, match.inventoryId));

          if (imageUrl) imagesMatched++;
          matchedParts++;
        }

        processedPages++;
        await db
          .update(catalogPdfJobTable)
          .set({ processedPages, matchedParts, imagesMatched })
          .where(eq(catalogPdfJobTable.id, jobId));
      }

      if (wasCancelled) {
        await db
          .update(catalogPdfJobTable)
          .set({ finishedAt: new Date() })
          .where(eq(catalogPdfJobTable.id, jobId));
        console.log(`[catalog-pdf] job=${jobId} cancelled (resume) after page ${processedPages}`);
        return;
      }

      await db
        .update(catalogPdfJobTable)
        .set({ status: "done", processedPages, matchedParts, imagesMatched, finishedAt: new Date() })
        .where(eq(catalogPdfJobTable.id, jobId));

      console.log(
        `[catalog-pdf] job=${jobId} resumed and done — pages=${processedPages} matched=${matchedParts} images=${imagesMatched}`,
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
