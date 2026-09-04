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

import { getAuth } from "@clerk/express";
import { catalogPdfJobTable,db,inventoryTable } from "@workspace/db";
import { and, desc, eq, inArray, isNull,lt, or, sql } from "drizzle-orm";
import { Router } from "express";

import { getLogger, logger } from "../lib/logger";
import { deletePrivateObjects, uploadCatalogImage } from "../lib/objectStorage";
import { PoeBotChainExhaustedError } from "../lib/poeBot";
import { catalogPdfUploadLimiter } from "../lib/rateLimiter";
import { requireAdminAuth } from "../middlewares/requireAdminAuth";
import { isProviderPayloadTooLargeError } from "../utils/aiHelpers";
import type { ImageRegion } from "../utils/catalogExtractor";
import { CatalogAiError,extractCatalogPage } from "../utils/catalogExtractor";
import { matchCatalogNumber } from "../utils/catalogMatcher";
import { extractPdfPages, validatePdf } from "../utils/pdfProcessor";

// ── Background-job concurrency semaphore ──────────────────────────────────────
// Limits the number of PDF processing jobs that can run simultaneously in the
// background to prevent a single admin (or a stolen admin token) from
// enqueuing unlimited parallel AI and pdftoppm work.
const MAX_CONCURRENT_PDF_JOBS = Number(process.env.MAX_CONCURRENT_PDF_JOBS ?? 3);
let activePdfJobs = 0;

// ── In-memory AI raw log store (in-session only, not persisted to DB) ─────────
// Keyed by job ID (child job or single-upload job). Entries are appended as
// each page is processed. The status endpoint aggregates across child jobs for
// parent (multi-chunk) jobs.
//
// Each record carries a createdAt timestamp so the TTL sweep below can evict
// orphaned entries (e.g. jobs whose client never polled for their logs).
interface AiRawLogRecord {
  createdAt: number;
  entries: Array<{ page: number; text: string }>;
}
const aiRawLogStore = new Map<number, AiRawLogRecord>();

function appendAiRawLog(jobId: number, page: number, text: string): void {
  let record = aiRawLogStore.get(jobId);
  if (!record) {
    record = { createdAt: Date.now(), entries: [] };
    aiRawLogStore.set(jobId, record);
  }
  record.entries.push({ page, text });
}

// Evict entries older than 1 hour every 10 minutes to bound memory on
// long-lived server instances (jobs whose client never polled for their logs).
const AI_RAW_LOG_TTL_MS = 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [jobId, record] of aiRawLogStore) {
    if (now - record.createdAt > AI_RAW_LOG_TTL_MS) {
      aiRawLogStore.delete(jobId);
    }
  }
}, 10 * 60 * 1000).unref();

const router = Router();

async function cleanupPrivateObjects(
  paths: Array<string | null | undefined>,
): Promise<void> {
  // Isolated route tests may provide a reduced storage mock. Production always
  // has the helper, while this guard keeps those tests focused on DB behavior.
  if (typeof deletePrivateObjects === "function") {
    await deletePrivateObjects(paths);
  }
}

// ── Image helper ──────────────────────────────────────────────────────────────
type PageCtx = {
  isRendered: boolean;
  images: Array<Buffer>;
  pageWidth: number;
  pageHeight: number;
};
async function cropOrSelectImage(
  page: PageCtx,
  imageRegion: ImageRegion | null,
  imageIndex: number,
  log: typeof logger = logger,
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
      log.warn({ err: cropErr }, "[catalog-pdf] Crop failed, skipping image");
      return null;
    }
  } else {
    if (imageIndex < 0 || imageIndex >= page.images.length) return null;
    return page.images[imageIndex] ?? null;
  }
}

// ── Parent-job finalisation (atomic) ──────────────────────────────────────────
// After a child job reaches a terminal state, check whether all siblings are
// also terminal. If so, mark the parent as done or failed using a single
// conditional UPDATE so that two chunks finishing simultaneously cannot both
// (or neither) trigger the parent transition.
async function finalizeParentIfComplete(parentId: number, log: typeof logger = logger): Promise<void> {
  try {
    await db.execute(sql`
      WITH child_agg AS (
        SELECT
          COUNT(*)                                                                         AS total,
          SUM(CASE WHEN status NOT IN ('done','done_with_errors','failed','cancelled') THEN 1 ELSE 0 END) AS still_running,
          SUM(CASE WHEN status = 'failed'                                              THEN 1 ELSE 0 END) AS failed_count,
          SUM(CASE WHEN status = 'done_with_errors'                                   THEN 1 ELSE 0 END) AS partial_count,
          COALESCE(SUM(processed_pages), 0)                                              AS sum_pages,
          COALESCE(SUM(parts_found),     0)                                              AS sum_found,
          COALESCE(SUM(matched_parts),   0)                                              AS sum_matched,
          COALESCE(SUM(images_matched),  0)                                              AS sum_images,
          (SELECT error_message FROM catalog_pdf_job
            WHERE parent_job_id = ${parentId} AND status IN ('failed', 'done_with_errors')
            LIMIT 1)                                                                      AS first_error
        FROM catalog_pdf_job
        WHERE parent_job_id = ${parentId}
      ),
      parent_info AS (
        SELECT chunk_count FROM catalog_pdf_job WHERE id = ${parentId}
      )
      UPDATE catalog_pdf_job
      SET
        status           = CASE WHEN ca.failed_count > 0 THEN 'failed'
                                WHEN ca.partial_count > 0 THEN 'done_with_errors'
                                ELSE 'done' END,
        error_message    = CASE WHEN ca.failed_count > 0 OR ca.partial_count > 0 THEN ca.first_error ELSE NULL END,
        processed_pages  = ca.sum_pages,
        parts_found      = ca.sum_found,
        matched_parts    = ca.sum_matched,
        images_matched   = ca.sum_images,
        finished_at      = NOW()
      FROM child_agg ca, parent_info pi
      WHERE catalog_pdf_job.id = ${parentId}
        AND ca.still_running   = 0
        AND ca.total           = pi.chunk_count
        AND catalog_pdf_job.status NOT IN ('done', 'done_with_errors', 'failed')
    `);
  } catch (err) {
    log.error({ err, parentId }, "[catalog-pdf] finalizeParentIfComplete failed");
  }
}

// Maximum number of unmatched parts to store per job (prevents unbounded JSON blobs).
const MAX_UNMATCHED_STORED = 300;
// Check for cancellation before every page so a cancel stops work within at
// most 1 page (the page whose AI call is already in flight). Each page already
// involves at least one AI round-trip, so one extra lightweight DB read per
// page is negligible.
const CANCEL_CHECK_INTERVAL = 1;

// ── Active background-loop registry ──────────────────────────────────────────
// Maps jobId → a promise that settles only when the background processing loop
// for that job has fully terminated (including its cleanup/finally block).
// Lets callers (primarily integration tests, but also graceful-shutdown hooks)
// await true loop termination instead of inferring it from job status, which
// can flip to a terminal state while the loop is still draining.
const activeJobLoops = new Map<number, Promise<void>>();

function trackJobLoop(jobId: number, loop: Promise<void>): void {
  const settled = loop
    .catch(() => {
      /* errors are already handled/logged inside the loop */
    })
    .finally(() => {
      activeJobLoops.delete(jobId);
    });
  activeJobLoops.set(jobId, settled);
}

/**
 * Resolves once the background processing loop for the given job has fully
 * terminated. Resolves immediately if no loop is currently running.
 */
export function awaitJobTermination(jobId: number): Promise<void> {
  return activeJobLoops.get(jobId) ?? Promise.resolve();
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// When the server receives SIGTERM/SIGINT, `shutdownCatalogPdfLoops` flips this
// flag so every in-flight page loop stops at its next page boundary, waits
// (bounded) for the loops to drain, and then marks any job still stuck in
// "processing" as failed with a resumable message. This means admins never see
// jobs permanently stuck in "processing" after a deploy/restart.
let shuttingDown = false;

/** True once graceful shutdown has been requested (test/introspection helper). */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

/** Test-only: reset the shutdown flag between test cases. */
export function resetShutdownStateForTests(): void {
  shuttingDown = false;
}

/** Test-only: register a fake background loop in the registry. */
export function registerJobLoopForTests(jobId: number, loop: Promise<void>): void {
  trackJobLoop(jobId, loop);
}

export const SHUTDOWN_ERROR_MESSAGE =
  "Server restarted while job was in progress. Use Resume to continue from the last processed page.";

/**
 * Requests shutdown of all active catalog-pdf background loops.
 * - Signals loops to stop at the next page boundary.
 * - Waits up to `timeoutMs` for tracked loops to fully terminate.
 * - Marks any affected job still in "processing" as failed with a resumable
 *   message so nothing stays stuck in "processing" across the restart.
 */
export async function shutdownCatalogPdfLoops(timeoutMs = 10_000): Promise<void> {
  shuttingDown = true;
  const jobIds = [...activeJobLoops.keys()];
  if (jobIds.length === 0) return;

  logger.info({ jobIds, timeoutMs }, "[catalog-pdf] shutdown requested — draining background loops");

  let timer: NodeJS.Timeout | undefined;
  const timedOut = await Promise.race([
    Promise.allSettled([...activeJobLoops.values()]).then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);

  try {
    const stillProcessing = await db
      .update(catalogPdfJobTable)
      .set({ status: "failed", errorMessage: SHUTDOWN_ERROR_MESSAGE, finishedAt: new Date() })
      .where(
        and(
          inArray(catalogPdfJobTable.id, jobIds),
          inArray(catalogPdfJobTable.status, ["pending", "processing"]),
        ),
      )
      .returning({ id: catalogPdfJobTable.id });
    if (stillProcessing.length > 0) {
      logger.warn(
        { jobIds: stillProcessing.map((r) => r.id), timedOut },
        "[catalog-pdf] marked in-flight jobs as failed (resumable) during shutdown",
      );
    }
  } catch (err) {
    logger.error({ err, jobIds }, "[catalog-pdf] failed to mark in-flight jobs during shutdown");
  }
}

// ── Session-items rollback helper ──────────────────────────────────────────────
// Reverts every inventory row that was updated by a given job ID: restores the
// previous description and clears all pdf-extraction fields (imageUrl, imageSource,
// imageConfidence, catalogPdfJobId).  Called when a job fails or is cancelled
// mid-run so partial writes never remain visible to clients.
async function revertSessionItems(jobId: number, log: typeof logger = logger): Promise<void> {
  try {
    const rows = await db
      .select({
        id: inventoryTable.id,
        imageUrl: inventoryTable.imageUrl,
        imageUrl2: inventoryTable.imageUrl2,
      })
      .from(inventoryTable)
      .where(
        and(
          eq(inventoryTable.catalogPdfJobId, jobId),
          sql`${inventoryTable.imageSource} = 'pdf_extraction'`,
        ),
      );

    await db
      .update(inventoryTable)
      .set({
        description: sql`COALESCE(${inventoryTable.previousDescription}, ${inventoryTable.description})`,
        previousDescription: null,
        imageUrl: null,
        imageUrl2: null,
        imageSource: null,
        imageConfidence: null,
        catalogPdfJobId: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(inventoryTable.catalogPdfJobId, jobId),
          sql`${inventoryTable.imageSource} = 'pdf_extraction'`,
        ),
      );
    await cleanupPrivateObjects(
      rows.flatMap((row) => [row.imageUrl, row.imageUrl2]),
    );
  } catch (revertErr) {
    log.error({ err: revertErr, jobId }, "[catalog-pdf] Failed to revert session items on job failure");
  }
}

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
  log: typeof logger = logger,
): Promise<void> {
  let processedPages = processedPagesBase ?? startPage;
  let partsFound = 0;
  let matchedParts = 0;
  let imagesMatched = 0;
  let wasCancelled = false;
  let hadImageUploadFailure = false;
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
  let cancelledCached = false;

  for (let pageIndex = 0; pageIndex < remainingPages.length; pageIndex++) {
    const page = remainingPages[pageIndex]!;
    if (shuttingDown) {
      // Server is shutting down: persist progress and mark the job failed with
      // a resumable message. Do NOT revert session items — the resume path
      // continues from processedPages and keeps partial work.
      await db
        .update(catalogPdfJobTable)
        .set({
          status: "failed",
          errorMessage: SHUTDOWN_ERROR_MESSAGE,
          processedPages,
          partsFound,
          matchedParts,
          imagesMatched,
          unmatchedParts: unmatchedPartsList.length > 0 ? unmatchedPartsList : null,
          finishedAt: new Date(),
        })
        .where(eq(catalogPdfJobTable.id, jobId));
      log.info({ jobId, processedPages, pageOffset }, "[catalog-pdf] loop stopped for server shutdown — job marked resumable");
      return;
    }
    if (pageIndex % CANCEL_CHECK_INTERVAL === 0) {
      const [currentRow] = await db
        .select({ status: catalogPdfJobTable.status })
        .from(catalogPdfJobTable)
        .where(eq(catalogPdfJobTable.id, jobId))
        .limit(1);
      cancelledCached = currentRow?.status === "cancelled";
    }
    if (cancelledCached) {
      wasCancelled = true;
      break;
    }

    const textPreview = page.text.slice(0, 200).replace(/\n/g, " ");
    log.info(
      { jobId, page: page.pageNum + pageOffset, textChars: page.text.length, images: page.images.length, preview: textPreview },
      "[catalog-pdf] processing page",
    );

    let entries: Awaited<ReturnType<typeof extractCatalogPage>>["entries"];
    try {
      const result = await extractCatalogPage(page.text, page.images, normalizedVendor, useOpenAiFallback);
      entries = result.entries;
      appendAiRawLog(jobId, page.pageNum + pageOffset, result.rawText);
    } catch (err) {
      if (err instanceof PoeBotChainExhaustedError) {
        await db
          .update(catalogPdfJobTable)
          .set({ status: "failed", errorMessage: "poe_chain_exhausted", finishedAt: new Date() })
          .where(eq(catalogPdfJobTable.id, jobId));
        await revertSessionItems(jobId, log);
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
        log.warn({ jobId, page: page.pageNum + pageOffset }, "[catalog-pdf] poe_chain_exhausted");
        return;
      }
      // Payload-too-large: re-throw to fail the entire job (image size won't
      // change on other pages, so all would fail anyway).
      // Transient AI error: log and skip this page so the rest of the job continues.
      if (err instanceof CatalogAiError && err.code !== "ai_payload_too_large") {
        log.warn({ jobId, page: page.pageNum + pageOffset, originalMessage: err.originalMessage }, "[catalog-pdf] transient ai_error — skipping page");
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
          imageUrl: inventoryTable.imageUrl,
          imageUrl2: inventoryTable.imageUrl2,
        })
        .from(inventoryTable)
        .where(eq(inventoryTable.id, match.inventoryId))
        .limit(1);

      if (!existing) continue;

      let imageUrl: string | null = null;
      let imageUrl2: string | null = null;
      if (entry.hasPartImage && page.images.length > 0) {
        const buf1 = await cropOrSelectImage(page, entry.imageRegion, entry.imageIndex, log);
        if (buf1) {
          try { imageUrl = await uploadCatalogImage(buf1, "image/png"); }
          catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            hadImageUploadFailure = true;
            log.warn({ err, jobId }, "[catalog-pdf] Image 1 upload failed");
            await db
              .update(catalogPdfJobTable)
              .set({ errorMessage: `image_upload_failed: ${msg}` })
              .where(eq(catalogPdfJobTable.id, jobId));
          }
        }
        const buf2 = await cropOrSelectImage(page, entry.imageRegion2, entry.imageIndex2, log);
        if (buf2) {
          try { imageUrl2 = await uploadCatalogImage(buf2, "image/png"); }
          catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            hadImageUploadFailure = true;
            log.warn({ err, jobId }, "[catalog-pdf] Image 2 upload failed");
            await db
              .update(catalogPdfJobTable)
              .set({ errorMessage: `image_upload_failed: ${msg}` })
              .where(eq(catalogPdfJobTable.id, jobId));
          }
        }
      }

      const incomingConfidence = match.similarityScore * entry.confidence;
      const [updated] = await db
        .update(inventoryTable)
        .set({
          description: entry.description || existing.description,
          previousDescription: existing.description,
          imageUrl,
          imageUrl2,
          imageSource: "pdf_extraction",
          imageConfidence: incomingConfidence,
          catalogPdfJobId: jobId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(inventoryTable.id, match.inventoryId),
            or(
              isNull(inventoryTable.imageConfidence),
              lt(inventoryTable.imageConfidence, incomingConfidence),
            ),
          ),
        )
        .returning({ id: inventoryTable.id });

      if (!updated) {
        // A lower-confidence result can lose the conditional update. Do not
        // leave newly generated private images orphaned in that case.
        await cleanupPrivateObjects([imageUrl, imageUrl2]).catch(() => {});
      } else {
        await cleanupPrivateObjects([existing.imageUrl, existing.imageUrl2]).catch(() => {});
      }

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
    await revertSessionItems(jobId, log);
    await db
      .update(catalogPdfJobTable)
      .set({ finishedAt: new Date() })
      .where(eq(catalogPdfJobTable.id, jobId));
    log.info({ jobId, processedPages, pageOffset }, "[catalog-pdf] job cancelled — session items reverted");
    return;
  }

  const finalStatus = hadImageUploadFailure ? "done_with_errors" : "done";
  await db
    .update(catalogPdfJobTable)
    .set({
      status: finalStatus,
      processedPages,
      partsFound,
      matchedParts,
      imagesMatched,
      unmatchedParts: unmatchedPartsList.length > 0 ? unmatchedPartsList : null,
      finishedAt: new Date(),
    })
    .where(eq(catalogPdfJobTable.id, jobId));

  log.info(
    { jobId, status: finalStatus, pages: processedPages, found: partsFound, matched: matchedParts, images: imagesMatched, unmatched: unmatchedPartsList.length, pageOffset },
    "[catalog-pdf] job complete",
  );

  if (parentJobId !== null) {
    await finalizeParentIfComplete(parentJobId, log);
  }
}

/**
 * Starts extraction for a durably completed upload. The upload-session route
 * owns the manifest and job creation; this function owns only the existing
 * extraction handoff so legacy jobs and new jobs use the same worker.
 */
export function launchCatalogPdfBuffer(
  jobId: number,
  pdfBuffer: Buffer,
  normalizedVendor: string,
  log: typeof logger = logger,
): void {
  if (activePdfJobs >= MAX_CONCURRENT_PDF_JOBS) {
    const retry = setTimeout(() => launchCatalogPdfBuffer(jobId, pdfBuffer, normalizedVendor, log), 1000);
    retry.unref();
    log.info({ jobId }, "[catalog-pdf] durable job queued behind concurrency limit");
    return;
  }
  activePdfJobs++;
  setImmediate(() => trackJobLoop(jobId, (async () => {
    try {
      await db.update(catalogPdfJobTable)
        .set({ status: "processing", startedAt: new Date() })
        .where(and(eq(catalogPdfJobTable.id, jobId), eq(catalogPdfJobTable.status, "pending")));
      const pages = await extractPdfPages(pdfBuffer);
      await db.update(catalogPdfJobTable).set({ totalPages: pages.length })
        .where(eq(catalogPdfJobTable.id, jobId));
      await processPdfPages(jobId, pages, 0, normalizedVendor, null, 0, false, undefined, log);
    } catch (err) {
      const isCatalogAiError = err instanceof Error && err.name === "CatalogAiError";
      const errorCode = !isCatalogAiError && isProviderPayloadTooLargeError(err)
        ? "ai_payload_too_large"
        : err instanceof Error ? err.message : String(err);
      await db.update(catalogPdfJobTable)
        .set({ status: "failed", errorMessage: errorCode, finishedAt: new Date() })
        .where(eq(catalogPdfJobTable.id, jobId));
      await revertSessionItems(jobId, log);
      log.error({ err, jobId }, "[catalog-pdf] durable background processing failed");
    } finally {
      activePdfJobs--;
    }
  })()));
}

// ── POST /admin/catalog-pdf ───────────────────────────────────────────────────
router.post("/catalog-pdf", requireAdminAuth, async (req, res) => {
  const reqLogger = getLogger(res);
  // Per-admin upload rate limit: prevents a compromised admin account from
  // flooding the background processing queue with many rapid uploads.
  const adminUserId = (res.locals.appUser as { clerkUserId: string } | undefined)?.clerkUserId
    ?? getAuth(req)?.userId
    ?? String(req.ip ?? "unknown");
  const uploadRateCheck = await catalogPdfUploadLimiter.check(adminUserId, res.locals.requestId as string | undefined);
  if (!uploadRateCheck.allowed) {
    res.set("Retry-After", String(Math.ceil(uploadRateCheck.retryAfterMs / 1000)));
    return void res.status(429).json({ error: "Too many catalog upload requests. Please slow down." });
  }

  // Concurrency check: reject if too many background jobs are already running.
  // Increment the counter immediately (no await between check and increment) so
  // concurrent requests cannot both pass the gate before either one registers.
  if (activePdfJobs >= MAX_CONCURRENT_PDF_JOBS) {
    return void res.status(429).json({
      error: `Too many catalog processing jobs are already running (max ${MAX_CONCURRENT_PDF_JOBS}). Please wait for a job to finish before starting another.`,
    });
  }
  // Reserve the slot immediately (before any await) so concurrent requests
  // cannot both pass the gate. A try/finally below releases it on any early
  // exit (validation failure, DB error, etc.); the setImmediate background
  // job takes ownership of the slot once it is launched.
  activePdfJobs++;
  let backgroundLaunched = false;
  try {

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
    reqLogger.warn({ msg }, "[catalog-pdf] PDF pre-validation failed");
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
          ownerClerkUserId: adminUserId,
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
  // For chunked uploads the unique index on (parent_job_id, chunk_index) can
  // prevent a second insert when a client retries a chunk that already has an
  // active child job in the DB. In that case ON CONFLICT DO NOTHING returns no
  // rows; we fetch the existing child job and return it to the client so it can
  // resume polling without creating a duplicate.
  const insertValues = {
    ownerClerkUserId: adminUserId,
    vendor: normalizedVendor,
    filename: filename.trim(),
    status: "pending" as const,
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
  };

  const [jobRow] = await db
    .insert(catalogPdfJobTable)
    .values(insertValues)
    .onConflictDoNothing()
    .returning({ id: catalogPdfJobTable.id });

  if (!jobRow) {
    if (isChunked && resolvedParentJobId !== null && chunkIndex !== null) {
      // Conflict: a child job for this slot already exists.  Return it so the
      // client can poll its status without starting a duplicate run.
      const [existing] = await db
        .select({ id: catalogPdfJobTable.id, status: catalogPdfJobTable.status })
        .from(catalogPdfJobTable)
        .where(
          and(
            eq(catalogPdfJobTable.parentJobId, resolvedParentJobId),
            eq(catalogPdfJobTable.chunkIndex, chunkIndex),
          ),
        )
        .limit(1);

      if (!existing) {
        return void res.status(500).json({ error: "Failed to create or find job record" });
      }

      return void res.json({
        jobId: String(resolvedParentJobId),
        chunkJobId: String(existing.id),
        status: existing.status,
        message: "Chunk already submitted",
      });
    }
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
  // Transfer ownership of the reserved slot to the background job. Setting
  // backgroundLaunched=true before the setImmediate call (synchronous here)
  // ensures the outer try/finally does NOT decrement the counter — the
  // setImmediate's own finally is responsible for releasing it.
  backgroundLaunched = true;
  setImmediate(() => trackJobLoop(jobRow.id, (async () => {
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
        undefined,
        reqLogger,
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

      await revertSessionItems(jobRow.id, reqLogger);

      if (!isCatalogAiError && isProviderPayloadTooLargeError(err)) {
        reqLogger.warn({ jobId }, "[catalog-pdf] provider rejected payload as too large");
      } else {
        reqLogger.error({ err, jobId }, "[catalog-pdf] background processing failed");
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
    } finally {
      activePdfJobs--;
      if (activePdfJobs < 0) {
        reqLogger.error({ activePdfJobs }, "[catalog-pdf] activePdfJobs went negative — counter drift detected");
      }
    }
  })()));

  } finally {
    // Release the reserved slot on any early exit (validation failure, DB error,
    // thrown exception). If backgroundLaunched=true, the setImmediate's finally
    // block is responsible for the decrement instead.
    if (!backgroundLaunched) {
      activePdfJobs--;
      if (activePdfJobs < 0) {
        reqLogger.error({ activePdfJobs }, "[catalog-pdf] activePdfJobs went negative — counter drift detected");
      }
    }
  }
});

// ── POST /admin/catalog-pdf/:jobId/cancel ─────────────────────────────────────
router.post("/catalog-pdf/:jobId/cancel", requireAdminAuth, async (req, res) => {
  const reqLogger = getLogger(res);
  const jobId = Number(req.params["jobId"]);
  if (!Number.isFinite(jobId)) {
    res.status(400).json({ error: "Invalid jobId" });
    return;
  }

  try {
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

    reqLogger.info({ jobId }, "[catalog-pdf] cancel requested");
    res.json({ ok: true, jobId: String(jobId) });
  } catch (err) {
    reqLogger.error({ err, jobId }, "[catalog-pdf] cancel handler DB error");
    res.status(500).json({ error: "Cancel failed", requestId: res.locals.requestId });
  }
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
        const anyDoneWithErrors = children.some(
          (c) => c.status === "done_with_errors",
        );
        aggStatus = anyFailed
          ? "failed"
          : anyDoneWithErrors
            ? "done_with_errors"
            : "done";
      }
    }

    const failedChild = children.find((c) => c.status === "failed");
    const errorMessage = failedChild?.errorMessage ?? row.errorMessage;

    // Expose which chunk jobs failed so the client can offer targeted retry
    const failedChunks = children
      .filter((c) => c.status === "failed")
      .map((c) => ({ chunkJobId: String(c.id), chunkIndex: c.chunkIndex }));

    // Aggregate AI raw log from all child jobs, ordered by page number
    const aggregatedAiRawLog: Array<{ page: number; text: string; chunkJobId: string }> = [];
    for (const child of children) {
      const childRecord = aiRawLogStore.get(child.id);
      if (childRecord) {
        aggregatedAiRawLog.push(
          ...childRecord.entries.map((e) => ({ ...e, chunkJobId: String(child.id) })),
        );
      }
    }
    aggregatedAiRawLog.sort((a, b) => a.page - b.page);

    res.json({
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
      aiRawLog: aggregatedAiRawLog,
      ...(failedChunks.length > 0 ? { failedChunks } : {}),
    });

    // Evict child log entries once the parent reaches a terminal state and
    // we have served the aggregated logs to the client.
    if (aggStatus === "done" || aggStatus === "failed" || aggStatus === "cancelled") {
      for (const child of children) {
        aiRawLogStore.delete(child.id);
      }
    }
    return;
  }

  // ── Non-parent (child or legacy) job: return directly ────────────────────
  const directRecord = aiRawLogStore.get(Number(jobId));
  const directLog = (directRecord?.entries ?? []).map((e) => ({ ...e, chunkJobId: jobId }));
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
    aiRawLog: directLog,
  });

  // Evict the log entry once the job is terminal and the client has the data.
  if (row.status === "done" || row.status === "done_with_errors" || row.status === "failed" || row.status === "cancelled") {
    aiRawLogStore.delete(Number(jobId));
  }
});

// ── GET /admin/catalog-pdf/failed-jobs ────────────────────────────────────────
// Returns jobs in `failed` or `cancelled` status that are not dismissed and not child jobs
// (child jobs are hidden — only the parent appears in admin-facing lists).
router.get("/catalog-pdf/failed-jobs", requireAdminAuth, async (req, res) => {
  const reqLogger = getLogger(res);
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
        inArray(catalogPdfJobTable.status, ["failed", "done_with_errors", "cancelled"]),
        eq(catalogPdfJobTable.dismissed, false),
        isNull(catalogPdfJobTable.parentJobId),
      ))
      .orderBy(desc(catalogPdfJobTable.createdAt));

    res.json({ jobs: rows });
  } catch (err) {
    reqLogger.error({ err }, "[catalog-pdf] Failed to fetch failed jobs");
    res.status(500).json({ error: "Failed to fetch failed jobs" });
  }
});

// ── POST /admin/catalog-pdf/:jobId/resume ─────────────────────────────────────
router.post("/catalog-pdf/:jobId/resume", requireAdminAuth, async (req, res) => {
  // Rate limit (same per-admin limiter as upload: each resume triggers heavy work).
  const resumeAdminUserId = (res.locals.appUser as { clerkUserId: string } | undefined)?.clerkUserId
    ?? getAuth(req)?.userId
    ?? String(req.ip ?? "unknown");
  const resumeRateCheck = await catalogPdfUploadLimiter.check(resumeAdminUserId);
  if (!resumeRateCheck.allowed) {
    res.set("Retry-After", String(Math.ceil(resumeRateCheck.retryAfterMs / 1000)));
    return void res.status(429).json({ error: "Too many catalog requests. Please slow down." });
  }

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

  // Concurrency gate: check and increment atomically (no await between them)
  // so concurrent resume calls cannot both slip through before either registers.
  if (activePdfJobs >= MAX_CONCURRENT_PDF_JOBS) {
    return void res.status(429).json({
      error: `Too many catalog processing jobs are already running (max ${MAX_CONCURRENT_PDF_JOBS}). Please wait for a job to finish before resuming.`,
    });
  }
  // Reserve slot immediately; try/finally below releases it on any early exit
  // (DB errors, etc.). The setImmediate background job takes ownership once launched.
  activePdfJobs++;
  let resumeBackgroundLaunched = false;
  try {

  await db
    .update(catalogPdfJobTable)
    .set({ status: "processing", errorMessage: null, finishedAt: null })
    .where(eq(catalogPdfJobTable.id, jobId));

  const useOpenAiFallbackResume = req.headers["x-use-openai-fallback"] === "true";

  res.json({ jobId: String(jobId), message: "Job resuming", resumeFromPage });

  // ── Async resume processing ────────────────────────────────────────────────
  resumeBackgroundLaunched = true;
  setImmediate(() => trackJobLoop(jobId, (async () => {
    try {
      const pdfBuffer = Buffer.from(pdfBase64, "base64");
      const pages = await extractPdfPages(pdfBuffer);

      await db
        .update(catalogPdfJobTable)
        .set({ totalPages: pages.length })
        .where(eq(catalogPdfJobTable.id, jobId));

      const resumeLogger = getLogger(res);
      await processPdfPages(
        jobId,
        pages,
        startPageWithinChunk,
        normalizedVendor,
        parentJobId,
        pageOffset,
        useOpenAiFallbackResume,
        resumeFromPage,
        resumeLogger,
      );
    } catch (err) {
      const resumeLogger = getLogger(res);
      const msg = err instanceof Error ? err.message : String(err);
      await db
        .update(catalogPdfJobTable)
        .set({ status: "failed", errorMessage: msg, finishedAt: new Date() })
        .where(eq(catalogPdfJobTable.id, jobId));
      await revertSessionItems(jobId, resumeLogger);
      resumeLogger.error({ err, jobId }, "[catalog-pdf] resume failed");
    } finally {
      activePdfJobs--;
    }
  })()));

  } finally {
    if (!resumeBackgroundLaunched) activePdfJobs--;
  }
});

// ── POST /admin/catalog-pdf/:jobId/dismiss ────────────────────────────────────
// Marks a failed or cancelled job as dismissed so it no longer appears in the
// failed-jobs list.
router.post("/catalog-pdf/:jobId/dismiss", requireAdminAuth, async (req, res) => {
  const reqLogger = getLogger(res);
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
    reqLogger.error({ err }, "[catalog-pdf] Failed to dismiss job");
    res.status(500).json({ error: "Failed to dismiss job" });
  }
});

// ── GET /admin/catalog-pdf/reviews ────────────────────────────────────────────
router.get("/catalog-pdf/reviews", requireAdminAuth, async (req, res) => {
  const reqLogger = getLogger(res);
  try {
    const jobIdFilter = req.query["jobId"] ? Number(req.query["jobId"]) : null;

    if (jobIdFilter !== null && isNaN(jobIdFilter)) {
      res.status(400).json({ error: "Invalid jobId" });
      return;
    }

    // When a jobId filter is provided, we need to include inventory rows that
    // were won by a different chunk in a multi-chunk race.  The optimistic-lock
    // update (lower confidence loses) sets catalogPdfJobId to the *winning
    // child* job, not the parent.  To avoid silently hiding those rows from the
    // parent job's review screen we match against both the requested jobId
    // directly *and* any child job whose parent_job_id equals the requested
    // jobId.
    let effectiveJobIds: Array<number> | null = null;
    if (jobIdFilter !== null) {
      const childRows = await db
        .select({ id: catalogPdfJobTable.id })
        .from(catalogPdfJobTable)
        .where(eq(catalogPdfJobTable.parentJobId, jobIdFilter));

      effectiveJobIds = [jobIdFilter, ...childRows.map((c) => c.id)];
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
        effectiveJobIds !== null
          ? and(
              sql`${inventoryTable.imageSource} = 'pdf_extraction'`,
              inArray(inventoryTable.catalogPdfJobId, effectiveJobIds),
            )
          : sql`${inventoryTable.imageSource} = 'pdf_extraction'`,
      )
      .orderBy(desc(inventoryTable.catalogPdfJobId), desc(inventoryTable.updatedAt));

    const jobIds = [...new Set(rows.map((r) => r.catalogPdfJobId).filter(Boolean))] as Array<number>;
    let jobs: Array<{ id: number; vendor: string; filename: string; status: string; createdAt: Date; parentJobId: number | null }> = [];
    if (jobIds.length > 0) {
      jobs = await db
        .select({
          id: catalogPdfJobTable.id,
          vendor: catalogPdfJobTable.vendor,
          filename: catalogPdfJobTable.filename,
          status: catalogPdfJobTable.status,
          createdAt: catalogPdfJobTable.createdAt,
          parentJobId: catalogPdfJobTable.parentJobId,
        })
        .from(catalogPdfJobTable)
        .where(inArray(catalogPdfJobTable.id, jobIds));
    }

    const jobMap = new Map(jobs.map((j) => [j.id, j]));

    // When a jobId filter is active, resolve the display job for each row to
    // the parent job (when the row's catalogPdfJobId is a child job).  This
    // ensures the review screen always shows the parent-level job metadata
    // rather than an opaque child job ID that the admin never directly browsed.
    let parentJobCache: Map<number, { id: number; vendor: string; filename: string; status: string; createdAt: Date; parentJobId: number | null }> = new Map();
    if (jobIdFilter !== null) {
      const parentIds = [...new Set(
        jobs.map((j) => j.parentJobId).filter((pid): pid is number => pid !== null),
      )];
      if (parentIds.length > 0) {
        const parentRows = await db
          .select({
            id: catalogPdfJobTable.id,
            vendor: catalogPdfJobTable.vendor,
            filename: catalogPdfJobTable.filename,
            status: catalogPdfJobTable.status,
            createdAt: catalogPdfJobTable.createdAt,
            parentJobId: catalogPdfJobTable.parentJobId,
          })
          .from(catalogPdfJobTable)
          .where(inArray(catalogPdfJobTable.id, parentIds));
        parentJobCache = new Map(parentRows.map((p) => [p.id, p]));
      }
    }

    res.json({
      items: rows.map((r) => {
        const directJob = r.catalogPdfJobId ? (jobMap.get(r.catalogPdfJobId) ?? null) : null;
        // If the row's job is a child job and a jobId filter is active, surface
        // the parent job as the display job so the review screen stays coherent.
        const displayJob =
          directJob?.parentJobId != null
            ? (parentJobCache.get(directJob.parentJobId) ?? directJob)
            : directJob;
        return {
          ...r,
          job: displayJob,
          isLowConfidence: (r.imageConfidence ?? 1) < 0.6,
        };
      }),
      total: rows.length,
    });
  } catch (err) {
    reqLogger.error({ err }, "[catalog-pdf] Failed to fetch reviews");
    res.status(500).json({ error: "Failed to fetch reviews" });
  }
});

// ── POST /admin/catalog-pdf/reviews/:id/revert ────────────────────────────────
router.post("/catalog-pdf/reviews/:id/revert", requireAdminAuth, async (req, res) => {
  const id = Number(req.params["id"]);
  if (!id || isNaN(id)) {
    return void res.status(400).json({ error: "Invalid item ID" });
  }

  // Optional: the caller may pass the jobId of the review screen they are
  // reverting from.  When present, we confirm the item belongs to that job
  // (or one of its child jobs in a multi-chunk upload) before proceeding.
  // This closes the loop for chunk-race winners, where catalogPdfJobId points
  // to a child job rather than the parent, and prevents cross-session reverts
  // when two review tabs are open simultaneously.
  // req.body is undefined (not {}) when the request has no JSON body — e.g. a
  // bare POST with no Content-Type — so guard with optional chaining.
  const rawJobId = (req.body as { jobId?: unknown } | undefined)?.jobId;
  const jobIdContext = rawJobId !== undefined ? Number(rawJobId) : null;
  if (jobIdContext !== null && (!Number.isFinite(jobIdContext) || jobIdContext <= 0)) {
    return void res.status(400).json({ error: "Invalid jobId" });
  }

  try {
    const [row] = await db
      .select({
        id: inventoryTable.id,
        previousDescription: inventoryTable.previousDescription,
        imageSource: inventoryTable.imageSource,
        catalogPdfJobId: inventoryTable.catalogPdfJobId,
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

    // Guard: when a jobId context was provided, verify the item's catalogPdfJobId
    // is either the job itself or one of its child jobs (chunk-race winner case).
    if (jobIdContext !== null) {
      const childRows = await db
        .select({ id: catalogPdfJobTable.id })
        .from(catalogPdfJobTable)
        .where(eq(catalogPdfJobTable.parentJobId, jobIdContext));

      const effectiveJobIds = new Set([jobIdContext, ...childRows.map((c) => c.id)]);

      if (row.catalogPdfJobId === null || !effectiveJobIds.has(row.catalogPdfJobId)) {
        return void res.status(400).json({ error: "Item does not belong to the specified job" });
      }
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
  } catch (err) {
    const reqLogger = getLogger(res);
    reqLogger.error({ err, id }, "[catalog-pdf] revert handler DB error");
    res.status(500).json({ error: "Revert failed", requestId: res.locals.requestId });
  }
});

export default router;
