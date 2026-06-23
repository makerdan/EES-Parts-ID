/**
 * POST /api/admin/catalog-pdf
 *   Accept a base64-encoded PDF + vendor name. Supports both single-chunk
 *   (legacy) and multi-chunk uploads. For multi-chunk uploads the client
 *   sends chunkIndex / chunkCount / parentJobId / pageOffset fields; the
 *   server creates one parent job and one child job per chunk. Returns a
 *   jobId for polling (always the parent job ID for multi-chunk uploads).
 *
 * GET /api/admin/catalog-pdf/:jobId/status
 *   Return the current progress of a running or completed job. For parent
 *   jobs, aggregates progress across all child jobs in real time.
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
import { eq, sql, and, desc, inArray, isNull } from "drizzle-orm";
import { db } from "@workspace/db";
import { inventoryTable, catalogPdfJobTable } from "@workspace/db";
import { verifyAdminToken } from "./admin";
import { extractPdfPages, validatePdf } from "../utils/pdfProcessor";
import { extractCatalogPage, CatalogAiError } from "../utils/catalogExtractor";
import type { ImageRegion } from "../utils/catalogExtractor";
import { matchCatalogNumber } from "../utils/catalogMatcher";
import { uploadCatalogImage } from "../lib/objectStorage";
import { PoeBotChainExhaustedError } from "../lib/poeBot";
import { isProviderPayloadTooLargeError } from "../utils/aiHelpers";

const router = Router();

// ── Image helper ──────────────────────────────────────────────────────────────
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

// ── Parent-job finalisation (atomic) ──────────────────────────────────────────
// After a child job reaches a terminal state, check whether all siblings are
// also terminal. If so, mark the parent as done or failed using a single
// conditional UPDATE so that two chunks finishing simultaneously cannot both
// (or neither) trigger the parent transition.
async function finalizeParentIfComplete(parentId: number): Promise<void> {
  try {
    await db.execute(sql`
      WITH child_agg AS (
        SELECT
          COUNT(*)                                                          AS total,
          SUM(CASE WHEN status NOT IN ('done','failed','cancelled') THEN 1 ELSE 0 END) AS still_running,
          SUM(CASE WHEN status = 'failed'                           THEN 1 ELSE 0 END) AS failed_count,
          COALESCE(SUM(processed_pages), 0)                                AS sum_pages,
          COALESCE(SUM(parts_found),     0)                                AS sum_found,
          COALESCE(SUM(matched_parts),   0)                                AS sum_matched,
          COALESCE(SUM(images_matched),  0)                                AS sum_images,
          (SELECT error_message FROM catalog_pdf_job
            WHERE parent_job_id = ${parentId} AND status = 'failed'
            LIMIT 1)                                                        AS first_error
        FROM catalog_pdf_job
        WHERE parent_job_id = ${parentId}
      ),
      parent_info AS (
        SELECT chunk_count FROM catalog_pdf_job WHERE id = ${parentId}
      )
      UPDATE catalog_pdf_job
      SET
        status           = CASE WHEN ca.failed_count > 0 THEN 'failed' ELSE 'done' END,
        error_message    = CASE WHEN ca.failed_count > 0 THEN ca.first_error ELSE NULL END,
        processed_pages  = ca.sum_pages,
        parts_found      = ca.sum_found,
        matched_parts    = ca.sum_matched,
        images_matched   = ca.sum_images,
        finished_at      = NOW()
      FROM child_agg ca, parent_info pi
      WHERE catalog_pdf_job.id = ${parentId}
        AND ca.still_running   = 0
        AND ca.total           = pi.chunk_count
        AND catalog_pdf_job.status NOT IN ('done', 'failed')
    `);
  } catch (err) {
    console.error(`[catalog-pdf] finalizeParentIfComplete failed for parent=${parentId}:`, err);
  }
}

// Maximum number of unmatched parts to store per job (prevents unbounded JSON blobs).
const MAX_UNMATCHED_STORED = 300;

// ── Core per-page processing loop ─────────────────────────────────────────────
// Shared by both the POST (new job) and POST /resume routes.
async function processPdfPages(
  jobId: number,
  pages: Awaited<ReturnType<typeof extractPdfPages>>,
  startPage: number,
  normalizedVendor: string,
  parentJobId: number | null,
  pageOffset: number,
  useOpenAiFallback = false,
  processedPagesBase?: number,
): Promise<void> {
  let processedPages = processedPagesBase ?? startPage;
  let partsFound = 0;
  let matchedParts = 0;
  let imagesMatched = 0;
  let wasCancelled = false;
  const unmatchedPartsList: Array<{ catalogNumber: string; description: string }> = [];

  // Load existing counters for resume path
  if ((processedPagesBase ?? startPage) > 0) {
    const [existing] = await db
      .select({
        partsFound: catalogPdfJobTable.partsFound,
        matchedParts: catalogPdfJobTable.matchedParts,
        imagesMatched: catalogPdfJobTable.imagesMatched,
        unmatchedParts: catalogPdfJobTable.unmatchedParts,
      })
      .from(catalogPdfJobTable)
      .where(eq(catalogPdfJobTable.id, jobId))
      .limit(1);
    partsFound = existing?.partsFound ?? 0;
    matchedParts = existing?.matchedParts ?? 0;
    imagesMatched = existing?.imagesMatched ?? 0;
    if (Array.isArray(existing?.unmatchedParts)) {
      unmatchedPartsList.push(...existing.unmatchedParts);
    }
  }

  const remainingPages = pages.slice(startPage);

  for (const page of remainingPages) {
    const [currentRow] = await db
      .select({ status: catalogPdfJobTable.status })
      .from(catalogPdfJobTable)
      .where(eq(catalogPdfJobTable.id, jobId))
      .limit(1);
    if (currentRow?.status === "cancelled") {
      wasCancelled = true;
      break;
    }

    const textPreview = page.text.slice(0, 200).replace(/\n/g, " ");
    console.log(
      `[catalog-pdf] page=${page.pageNum + pageOffset} text=${page.text.length}chars images=${page.images.length} preview="${textPreview}"`,
    );

    let entries: Awaited<ReturnType<typeof extractCatalogPage>>;
    try {
      entries = await extractCatalogPage(page.text, page.images, normalizedVendor, useOpenAiFallback);
    } catch (err) {
      if (err instanceof PoeBotChainExhaustedError) {
        await db
          .update(catalogPdfJobTable)
          .set({ status: "failed", errorMessage: "poe_chain_exhausted", finishedAt: new Date() })
          .where(eq(catalogPdfJobTable.id, jobId));
        if (parentJobId !== null) {
          await db.execute(sql`
            UPDATE catalog_pdf_job
            SET status = 'failed',
                error_message = 'poe_chain_exhausted',
                finished_at = NOW()
            WHERE id = ${parentJobId}
              AND status NOT IN ('done', 'failed')
          `);
        }
        console.warn(`[catalog-pdf] job=${jobId} poe_chain_exhausted on page ${page.pageNum + pageOffset}`);
        return;
      }
      // Payload-too-large: re-throw to fail the entire job (image size won't
      // change on other pages, so all would fail anyway).
      // Transient AI error: log and skip this page so the rest of the job continues.
      if (err instanceof CatalogAiError && err.code !== "ai_payload_too_large") {
        console.warn(`[catalog-pdf] job=${jobId} page=${page.pageNum + pageOffset} transient ai_error — skipping:`, err.originalMessage);
        processedPages++;
        await db.update(catalogPdfJobTable).set({ processedPages }).where(eq(catalogPdfJobTable.id, jobId));
        continue;
      }
      throw err;
    }

    // Count all AI-extracted entries toward partsFound (before confidence filter)
    partsFound += entries.length;

    for (const entry of entries) {
      if (entry.confidence < 0.4) continue;

      const match = await matchCatalogNumber(normalizedVendor, entry.catalogNumber);
      if (!match) {
        // Track unmatched parts (AI found it but no inventory row)
        if (unmatchedPartsList.length < MAX_UNMATCHED_STORED) {
          unmatchedPartsList.push({
            catalogNumber: entry.catalogNumber,
            description: entry.description,
          });
        }
        continue;
      }

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
      .set({
        processedPages,
        partsFound,
        matchedParts,
        imagesMatched,
        unmatchedParts: unmatchedPartsList.length > 0 ? unmatchedPartsList : null,
      })
      .where(eq(catalogPdfJobTable.id, jobId));
  }

  if (wasCancelled) {
    await db
      .update(catalogPdfJobTable)
      .set({ finishedAt: new Date() })
      .where(eq(catalogPdfJobTable.id, jobId));
    console.log(`[catalog-pdf] job=${jobId} cancelled after page ${processedPages} (offset=${pageOffset})`);
    return;
  }

  await db
    .update(catalogPdfJobTable)
    .set({
      status: "done",
      processedPages,
      partsFound,
      matchedParts,
      imagesMatched,
      unmatchedParts: unmatchedPartsList.length > 0 ? unmatchedPartsList : null,
      finishedAt: new Date(),
    })
    .where(eq(catalogPdfJobTable.id, jobId));

  console.log(
    `[catalog-pdf] job=${jobId} done — pages=${processedPages} found=${partsFound} matched=${matchedParts} images=${imagesMatched} unmatched=${unmatchedPartsList.length} (offset=${pageOffset})`,
  );

  if (parentJobId !== null) {
    await finalizeParentIfComplete(parentJobId);
  }
}

// ── POST /admin/catalog-pdf ───────────────────────────────────────────────────
router.post("/catalog-pdf", requireAdminAuth, async (req, res) => {
  const {
    pdfBase64,
    vendor,
    filename = "catalog.pdf",
    chunkIndex: rawChunkIndex,
    chunkCount: rawChunkCount,
    parentJobId: rawParentJobId,
    pageOffset: rawPageOffset,
  } = req.body as {
    pdfBase64?: string;
    vendor?: string;
    filename?: string;
    chunkIndex?: number;
    chunkCount?: number;
    parentJobId?: string | number;
    pageOffset?: number;
  };

  if (!pdfBase64 || typeof pdfBase64 !== "string") {
    return void res.status(400).json({ error: "Missing pdfBase64 field" });
  }
  if (!vendor || typeof vendor !== "string") {
    return void res.status(400).json({ error: "Missing vendor field" });
  }

  if (pdfBase64.length > 35_000_000) {
    return void res.status(413).json({ error: "PDF too large (max ~25 MB per chunk)" });
  }

  const isChunked = rawChunkIndex !== undefined && rawChunkIndex !== null;
  const chunkIndex = isChunked ? Number(rawChunkIndex) : null;
  const chunkCount = isChunked ? Number(rawChunkCount) : null;
  const pageOffset = isChunked ? (Number(rawPageOffset) || 0) : 0;
  const normalizedVendor = vendor.trim().toUpperCase();

  // ── Validate chunk parameters ──────────────────────────────────────────────
  if (isChunked) {
    if (
      !Number.isFinite(chunkIndex) ||
      !Number.isFinite(chunkCount) ||
      chunkCount! < 1 ||
      chunkIndex! < 0 ||
      chunkIndex! >= chunkCount!
    ) {
      return void res.status(400).json({
        error: `Invalid chunkIndex (${chunkIndex}) or chunkCount (${chunkCount})`,
      });
    }
  }

  // ── Lightweight synchronous pre-validation ────────────────────────────────
  // validatePdf checks magic bytes and encryption in microseconds (no spawned
  // processes, no heavy parsing). Corrupt or encrypted uploads get an immediate
  // 400 before any DB record is written. Full page rendering (extractPdfPages)
  // runs in the background after the 200 response has been sent.
  const pdfBuffer = Buffer.from(pdfBase64, "base64");
  try {
    validatePdf(pdfBuffer);
  } catch (preErr) {
    const msg = preErr instanceof Error ? preErr.message : String(preErr);
    console.warn(`[catalog-pdf] PDF pre-validation failed: ${msg}`);
    return void res.status(400).json({ error: msg });
  }

  // ── Parent job handling ────────────────────────────────────────────────────
  let resolvedParentJobId: number | null = null;

  if (isChunked) {
    if (chunkIndex === 0 && (rawParentJobId === undefined || rawParentJobId === null)) {
      // First chunk with no parent yet — create the parent job
      const [parentRow] = await db
        .insert(catalogPdfJobTable)
        .values({
          vendor: normalizedVendor,
          filename: filename.trim(),
          status: "pending",
          processedPages: 0,
          matchedParts: 0,
          chunkCount: chunkCount!,
        })
        .returning({ id: catalogPdfJobTable.id });

      if (!parentRow) {
        return void res.status(500).json({ error: "Failed to create parent job record" });
      }
      resolvedParentJobId = parentRow.id;
    } else {
      // Subsequent chunk — validate that the parent exists
      const pid = Number(rawParentJobId);
      if (!Number.isFinite(pid)) {
        return void res.status(400).json({ error: "Invalid parentJobId" });
      }

      const [parentRow] = await db
        .select({ id: catalogPdfJobTable.id, chunkCount: catalogPdfJobTable.chunkCount })
        .from(catalogPdfJobTable)
        .where(eq(catalogPdfJobTable.id, pid))
        .limit(1);

      if (!parentRow) {
        return void res.status(404).json({ error: "Parent job not found" });
      }

      if (chunkIndex! >= (parentRow.chunkCount ?? 0)) {
        return void res.status(400).json({
          error: `chunkIndex ${chunkIndex} is out of range for chunkCount ${parentRow.chunkCount}`,
        });
      }

      resolvedParentJobId = pid;
    }
  }

  // ── Chunk retry: clean up previous zero-progress failed child and reset parent ──
  // When re-uploading a chunk (retry after failure), delete any previous failed or
  // cancelled child job for this (parentJobId, chunkIndex) slot that processed 0
  // pages — safe to remove because no inventory data was written. Then reset the
  // parent from 'failed' → 'processing' so polling reflects the resumed work.
  if (resolvedParentJobId !== null && chunkIndex !== null) {
    await db
      .delete(catalogPdfJobTable)
      .where(
        and(
          eq(catalogPdfJobTable.parentJobId, resolvedParentJobId),
          eq(catalogPdfJobTable.chunkIndex, chunkIndex),
          inArray(catalogPdfJobTable.status, ["failed", "cancelled"]),
          eq(catalogPdfJobTable.processedPages, 0),
        ),
      );

    await db.execute(sql`
      UPDATE catalog_pdf_job
      SET status = 'processing', error_message = NULL, finished_at = NULL
      WHERE id = ${resolvedParentJobId}
        AND status = 'failed'
    `);
  }

  // ── Create child (or legacy) job record ───────────────────────────────────
  const [jobRow] = await db
    .insert(catalogPdfJobTable)
    .values({
      vendor: normalizedVendor,
      filename: filename.trim(),
      status: "pending",
      processedPages: 0,
      matchedParts: 0,
      ...(isChunked
        ? {
            parentJobId: resolvedParentJobId,
            chunkIndex: chunkIndex!,
            chunkCount: chunkCount!,
            pageOffset,
          }
        : {}),
    })
    .returning({ id: catalogPdfJobTable.id });

  if (!jobRow) {
    return void res.status(500).json({ error: "Failed to create job record" });
  }

  const jobId = String(jobRow.id);

  const useOpenAiFallback = req.headers["x-use-openai-fallback"] === "true";

  // ── Mark job as processing ─────────────────────────────────────────────────
  await db
    .update(catalogPdfJobTable)
    .set({ status: "processing", startedAt: new Date() })
    .where(eq(catalogPdfJobTable.id, jobRow.id));

  // ── Respond immediately ────────────────────────────────────────────────────
  // Processing continues in the background; the client polls the status endpoint.
  if (isChunked) {
    res.json({ jobId: String(resolvedParentJobId), chunkJobId: jobId, message: "Chunk job started" });
  } else {
    res.json({ jobId, message: "Job started" });
  }

  // ── Background processing ──────────────────────────────────────────────────
  // extractPdfPages (full rendering via pdftoppm) runs here, off the request
  // thread. pdfBuffer was decoded synchronously before the 200 response, so
  // no re-parsing of the base64 payload is needed.
  setImmediate(async () => {
    try {
      const pages = await extractPdfPages(pdfBuffer);
      await db
        .update(catalogPdfJobTable)
        .set({ totalPages: pages.length })
        .where(eq(catalogPdfJobTable.id, jobRow.id));

      await processPdfPages(
        jobRow.id,
        pages,
        0,
        normalizedVendor,
        resolvedParentJobId,
        pageOffset,
        useOpenAiFallback,
      );
    } catch (err) {
      // Translate raw provider payload-too-large errors to the canonical job
      // error code so the status endpoint surfaces a consistent value.
      const isCatalogAiError = err instanceof Error && err.name === "CatalogAiError";
      const errorCode =
        !isCatalogAiError && isProviderPayloadTooLargeError(err)
          ? "ai_payload_too_large"
          : err instanceof Error
            ? err.message
            : String(err);

      await db
        .update(catalogPdfJobTable)
        .set({ status: "failed", errorMessage: errorCode, finishedAt: new Date() })
        .where(eq(catalogPdfJobTable.id, jobRow.id));

      if (!isCatalogAiError && isProviderPayloadTooLargeError(err)) {
        console.warn(`[catalog-pdf] job=${jobId} provider rejected payload as too large`);
      } else {
        console.error(`[catalog-pdf] job=${jobId} background processing failed:`, err);
      }

      if (resolvedParentJobId !== null) {
        await db.execute(sql`
          UPDATE catalog_pdf_job
          SET status = 'failed',
              error_message = ${errorCode},
              finished_at = NOW()
          WHERE id = ${resolvedParentJobId}
            AND status NOT IN ('done', 'failed')
        `);
      }
    }
  });
});

// ── POST /admin/catalog-pdf/:jobId/cancel ─────────────────────────────────────
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

  await db.execute(sql`
    UPDATE catalog_pdf_job
    SET status = 'cancelled', finished_at = NOW()
    WHERE parent_job_id = ${jobId}
      AND status IN ('pending', 'processing')
  `);

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

  // ── Parent job: aggregate progress from children ──────────────────────────
  if (row.chunkCount !== null && row.parentJobId === null) {
    const children = await db
      .select({
        id: catalogPdfJobTable.id,
        chunkIndex: catalogPdfJobTable.chunkIndex,
        status: catalogPdfJobTable.status,
        totalPages: catalogPdfJobTable.totalPages,
        processedPages: catalogPdfJobTable.processedPages,
        partsFound: catalogPdfJobTable.partsFound,
        matchedParts: catalogPdfJobTable.matchedParts,
        imagesMatched: catalogPdfJobTable.imagesMatched,
        unmatchedParts: catalogPdfJobTable.unmatchedParts,
        errorMessage: catalogPdfJobTable.errorMessage,
      })
      .from(catalogPdfJobTable)
      .where(eq(catalogPdfJobTable.parentJobId, Number(jobId)));

    const totalPages = children.reduce((s, c) => s + (c.totalPages ?? 0), 0);
    const processedPages = children.reduce((s, c) => s + c.processedPages, 0);
    const partsFound = children.reduce((s, c) => s + c.partsFound, 0);
    const matchedParts = children.reduce((s, c) => s + c.matchedParts, 0);
    const imagesMatched = children.reduce((s, c) => s + c.imagesMatched, 0);

    // Aggregate unmatched parts from all children (cap total at MAX_UNMATCHED_STORED)
    const aggregatedUnmatched: Array<{ catalogNumber: string; description: string }> = [];
    for (const child of children) {
      if (Array.isArray(child.unmatchedParts)) {
        for (const p of child.unmatchedParts) {
          if (aggregatedUnmatched.length >= MAX_UNMATCHED_STORED) break;
          aggregatedUnmatched.push(p);
        }
      }
    }

    // Derive aggregated status
    let aggStatus = row.status;
    if (row.status === "pending" || row.status === "processing") {
      const anyProcessing = children.some(
        (c) => c.status === "processing" || c.status === "pending",
      );
      if (anyProcessing) {
        aggStatus = "processing";
      } else if (children.length > 0) {
        // All children are terminal. Compute the parent's effective status from
        // them — guards against the race where finalizeParentIfComplete failed
        // or hasn't run yet, which would leave the parent stuck at "processing".
        const anyFailed = children.some((c) => c.status === "failed");
        aggStatus = anyFailed ? "failed" : "done";
      }
    }

    const failedChild = children.find((c) => c.status === "failed");
    const errorMessage = failedChild?.errorMessage ?? row.errorMessage;

    // Expose which chunk jobs failed so the client can offer targeted retry
    const failedChunks = children
      .filter((c) => c.status === "failed")
      .map((c) => ({ chunkJobId: String(c.id), chunkIndex: c.chunkIndex }));

    return void res.json({
      jobId,
      vendor: row.vendor,
      status: aggStatus,
      totalPages: totalPages > 0 ? totalPages : null,
      processedPages,
      partsFound,
      matchedParts,
      imagesMatched,
      unmatchedParts: aggregatedUnmatched,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      errorMessage: errorMessage ?? null,
      ...(failedChunks.length > 0 ? { failedChunks } : {}),
    });
  }

  // ── Non-parent (child or legacy) job: return directly ────────────────────
  res.json({
    jobId,
    vendor: row.vendor,
    status: row.status,
    totalPages: row.totalPages,
    processedPages: row.processedPages,
    partsFound: row.partsFound,
    matchedParts: row.matchedParts,
    imagesMatched: row.imagesMatched,
    unmatchedParts: row.unmatchedParts ?? [],
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    errorMessage: row.errorMessage,
  });
});

// ── GET /admin/catalog-pdf/failed-jobs ────────────────────────────────────────
// Returns jobs in `failed` or `cancelled` status that are not dismissed and not child jobs
// (child jobs are hidden — only the parent appears in admin-facing lists).
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
        inArray(catalogPdfJobTable.status, ["failed", "cancelled"]),
        eq(catalogPdfJobTable.dismissed, false),
        isNull(catalogPdfJobTable.parentJobId),
      ))
      .orderBy(desc(catalogPdfJobTable.createdAt));

    res.json({ jobs: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch failed jobs" });
  }
});

// ── POST /admin/catalog-pdf/:jobId/resume ─────────────────────────────────────
router.post("/catalog-pdf/:jobId/resume", requireAdminAuth, async (req, res) => {
  const jobId = Number(req.params["jobId"]);
  if (!Number.isFinite(jobId)) {
    res.status(400).json({ error: "Invalid jobId" });
    return;
  }

  // ── Job lookup and status checks come first so 404/409 are unambiguous ──────
  const [jobRow] = await db
    .select()
    .from(catalogPdfJobTable)
    .where(eq(catalogPdfJobTable.id, jobId))
    .limit(1);

  if (!jobRow) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  // Parent jobs cannot be resumed — each chunk would need to be re-uploaded individually
  if (jobRow.chunkCount !== null && jobRow.parentJobId === null) {
    res.status(409).json({
      error: "Cannot resume a multi-chunk parent job. Re-upload the affected chunk(s) individually.",
    });
    return;
  }

  // ── Parse chunkPageOffset early so the status guard can allow chunked continuation ──
  // When the client resumes a large file by splitting it into chunks, each chunk is
  // posted sequentially. After chunk N−1 completes the job reaches 'done'; the status
  // guard must allow 'done' so chunk N can continue from where the last chunk left off.
  const { pdfBase64, chunkPageOffset: rawChunkPageOffset, chunkPageCount: rawChunkPageCount } = req.body as { pdfBase64?: string; chunkPageOffset?: number; chunkPageCount?: number };
  const isChunkedContinuation =
    typeof rawChunkPageOffset === "number" && rawChunkPageOffset > 0;

  if (
    jobRow.status !== "failed" &&
    jobRow.status !== "processing" &&
    !(jobRow.status === "done" && isChunkedContinuation)
  ) {
    res.status(409).json({
      error: `Cannot resume a job with status "${jobRow.status}". Only failed or processing jobs can be resumed.`,
    });
    return;
  }

  // ── If this is a child chunk job, reset the parent from 'failed' → 'processing' ──
  // The parent was marked failed when this child failed. Resuming the child means
  // processing is back in-flight, so the parent should reflect that.
  if (jobRow.parentJobId !== null) {
    await db.execute(sql`
      UPDATE catalog_pdf_job
      SET status = 'processing', error_message = NULL, finished_at = NULL
      WHERE id = ${jobRow.parentJobId}
        AND status = 'failed'
    `);
  }

  // ── Validate the PDF payload after confirming the job is resumable ───────────
  // Content validation (magic bytes, /Encrypt) happens asynchronously inside
  // extractPdfPages; the synchronous handler only checks presence and size.
  if (!pdfBase64 || typeof pdfBase64 !== "string") {
    res.status(400).json({ error: "Missing pdfBase64 field" });
    return;
  }
  if (pdfBase64.length > 35_000_000) {
    res.status(413).json({ error: "PDF too large (max ~25 MB)" });
    return;
  }

  const chunkPageOffset = typeof rawChunkPageOffset === "number" && rawChunkPageOffset >= 0 ? rawChunkPageOffset : 0;
  const resumeFromPage = jobRow.processedPages ?? 0;
  const startPageWithinChunk = Math.max(0, resumeFromPage - chunkPageOffset);
  const normalizedVendor = jobRow.vendor;
  const pageOffset = chunkPageOffset > 0 ? chunkPageOffset : (jobRow.pageOffset ?? 0);
  const parentJobId = jobRow.parentJobId ?? null;

  // ── Idempotency guard: skip re-processing if this chunk was already completed ──
  // When a network blip causes the client to retry a chunk, processedPages will
  // already be >= chunkPageOffset + chunkPageCount, meaning every page in this
  // chunk was already ingested. Return 200 with a no-op so the caller can
  // advance to the next chunk without producing duplicate inventory entries.
  const chunkPageCount = typeof rawChunkPageCount === "number" && rawChunkPageCount > 0 ? rawChunkPageCount : null;
  if (chunkPageCount !== null && resumeFromPage >= chunkPageOffset + chunkPageCount) {
    res.json({ jobId: String(jobId), message: "Chunk already processed, no-op", resumeFromPage });
    return;
  }

  await db
    .update(catalogPdfJobTable)
    .set({ status: "processing", errorMessage: null, finishedAt: null })
    .where(eq(catalogPdfJobTable.id, jobId));

  const useOpenAiFallbackResume = req.headers["x-use-openai-fallback"] === "true";

  res.json({ jobId: String(jobId), message: "Job resuming", resumeFromPage });

  // ── Async resume processing ────────────────────────────────────────────────
  setImmediate(async () => {
    try {
      const pdfBuffer = Buffer.from(pdfBase64, "base64");
      const pages = await extractPdfPages(pdfBuffer);

      await db
        .update(catalogPdfJobTable)
        .set({ totalPages: pages.length })
        .where(eq(catalogPdfJobTable.id, jobId));

      await processPdfPages(
        jobId,
        pages,
        startPageWithinChunk,
        normalizedVendor,
        parentJobId,
        pageOffset,
        useOpenAiFallbackResume,
        resumeFromPage,
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
// Marks a failed or cancelled job as dismissed so it no longer appears in the
// failed-jobs list.
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
        inArray(catalogPdfJobTable.status, ["failed", "cancelled"]),
      ))
      .returning({ id: catalogPdfJobTable.id });

    if (updated.length === 0) {
      res.status(404).json({ error: "Job not found or not in a dismissible state" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to dismiss job" });
  }
});

// ── GET /admin/catalog-pdf/reviews ────────────────────────────────────────────
router.get("/catalog-pdf/reviews", requireAdminAuth, async (req, res) => {
  try {
    const jobIdFilter = req.query["jobId"] ? Number(req.query["jobId"]) : null;

    if (jobIdFilter !== null && isNaN(jobIdFilter)) {
      res.status(400).json({ error: "Invalid jobId" });
      return;
    }

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
      imageUrl2: null,
      imageSource: null,
      imageConfidence: null,
      catalogPdfJobId: null,
      updatedAt: new Date(),
    })
    .where(eq(inventoryTable.id, id));

  res.json({ ok: true });
});

export default router;
