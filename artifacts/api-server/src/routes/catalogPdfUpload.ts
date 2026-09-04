import { createHash, randomUUID } from "node:crypto";

import { getAuth } from "@clerk/express";
import {
  catalogPdfJobTable,
  catalogPdfUploadPartTable,
  catalogPdfUploadSessionTable,
  db,
} from "@workspace/db";
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { type Request, type Response,Router } from "express";

import {
  deleteCatalogPdfPart,
  readCatalogPdfPart,
  writeCatalogPdfPart,
} from "../lib/objectStorage";
import { catalogPdfUploadLimiter } from "../lib/rateLimiter";
import { requireAdminAuth } from "../middlewares/requireAdminAuth";
import { validatePdf } from "../utils/pdfProcessor";
import { launchCatalogPdfBuffer } from "./catalogPdf";

const router = Router();
const DEFAULT_PART_SIZE = 5 * 1024 * 1024;
const MIN_PART_SIZE = 1;
const MAX_PART_SIZE = 8 * 1024 * 1024;
const MAX_UPLOAD_BYTES = Number(process.env.CATALOG_PDF_MAX_BYTES ?? 250 * 1024 * 1024);
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ACTIVE_SESSIONS = Number(process.env.CATALOG_PDF_MAX_ACTIVE_SESSIONS ?? 3);

type SessionStatus = "open" | "completing" | "completed" | "cancelled" | "expired" | "failed";

function requestId(res: Response): string | undefined {
  return res.locals.requestId as string | undefined;
}

function adminId(req: Request, res: Response): string {
  return (res.locals.appUser as { clerkUserId?: string } | undefined)?.clerkUserId
    ?? getAuth(req)?.userId
    ?? "unknown";
}

function fail(res: Response, status: number, code: string, error: string): void {
  res.status(status).json({ error, code, requestId: requestId(res) });
}

function normalizeSha256(value: unknown): string | null {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : null;
}

function routeParam(value: string | Array<string> | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function parseContentRange(value: string | undefined): { start: number; end: number; total: number } | null {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/.exec(value ?? "");
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (![start, end, total].every(Number.isSafeInteger) || end < start || total <= 0) return null;
  return { start, end, total };
}

async function getOwnedSession(
  req: Request,
  res: Response,
  sessionId: string,
  allowExpired = false,
) {
  const [session] = await db
    .select()
    .from(catalogPdfUploadSessionTable)
    .where(and(
      eq(catalogPdfUploadSessionTable.id, sessionId),
      eq(catalogPdfUploadSessionTable.ownerClerkUserId, adminId(req, res)),
    ))
    .limit(1);

  // Deliberately make non-owners indistinguishable from missing sessions.
  if (!session) {
    fail(res, 404, "UPLOAD_SESSION_NOT_FOUND", "Upload session not found.");
    return null;
  }
  if (!allowExpired && session.status === "open" && session.expiresAt.getTime() <= Date.now()) {
    await expireSession(session.id);
    fail(res, 410, "UPLOAD_SESSION_EXPIRED", "Upload session expired. Start a new upload.");
    return null;
  }
  return session;
}

async function expireSession(sessionId: string): Promise<void> {
  await db
    .update(catalogPdfUploadSessionTable)
    .set({ status: "expired", cleanupAt: new Date(), updatedAt: new Date(), errorCode: "expired" })
    .where(and(
      eq(catalogPdfUploadSessionTable.id, sessionId),
      inArray(catalogPdfUploadSessionTable.status, ["open", "completing"]),
    ));
  await cleanupCatalogPdfUploadSession(sessionId);
}

async function cleanupCatalogPdfUploadSession(
  sessionId: string,
  removePartMetadata = true,
): Promise<void> {
  const parts = await db
    .select({ partIndex: catalogPdfUploadPartTable.partIndex })
    .from(catalogPdfUploadPartTable)
    .where(eq(catalogPdfUploadPartTable.sessionId, sessionId));
  await Promise.all(parts.map((part) => deleteCatalogPdfPart(sessionId, part.partIndex)));
  if (removePartMetadata) {
    await db.delete(catalogPdfUploadPartTable).where(eq(catalogPdfUploadPartTable.sessionId, sessionId));
  }
  await db
    .update(catalogPdfUploadSessionTable)
    .set({ cleanupAt: new Date(), updatedAt: new Date() })
    .where(eq(catalogPdfUploadSessionTable.id, sessionId));
}

function sessionPayload(
  session: typeof catalogPdfUploadSessionTable.$inferSelect,
  parts: Array<typeof catalogPdfUploadPartTable.$inferSelect>,
) {
  const received = new Set(parts.map((part) => part.partIndex));
  return {
    sessionId: session.id,
    status: session.status as SessionStatus,
    vendor: session.vendor,
    filename: session.filename,
    totalBytes: session.totalBytes,
    partSize: session.partSize,
    partCount: session.partCount,
    fileSha256: session.fileSha256,
    expiresAt: session.expiresAt,
    uploadedBytes: session.uploadedBytes,
    uploadedParts: session.uploadedParts,
    receivedParts: parts.map((part) => ({
      partIndex: part.partIndex,
      offset: part.offset,
      byteLength: part.byteLength,
      sha256: part.sha256,
    })),
    missingPartIndices: Array.from({ length: session.partCount }, (_, index) => index)
      .filter((index) => !received.has(index)),
    processingJobId: session.processingJobId ? String(session.processingJobId) : null,
  };
}

router.post("/catalog-pdf/upload-sessions", requireAdminAuth, async (req, res) => {
  const owner = adminId(req, res);
  const rate = await catalogPdfUploadLimiter.check(`session:${owner}`, requestId(res));
  if (!rate.allowed) {
    res.set("Retry-After", String(Math.ceil(rate.retryAfterMs / 1000)));
    return void fail(res, 429, "UPLOAD_RATE_LIMITED", "Too many catalog upload requests. Please try again later.");
  }

  const body = req.body as Record<string, unknown> | undefined;
  const vendor = typeof body?.vendor === "string" ? body.vendor.trim().toUpperCase() : "";
  const filename = typeof body?.filename === "string" && body.filename.trim()
    ? body.filename.trim().slice(0, 255)
    : "catalog.pdf";
  const totalBytes = Number(body?.totalBytes ?? body?.size);
  const requestedPartSize = body?.partSize === undefined ? DEFAULT_PART_SIZE : Number(body.partSize);
  if (!vendor || vendor.length > 200) return void fail(res, 400, "INVALID_MANIFEST", "vendor is required and must be at most 200 characters.");
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0 || totalBytes > MAX_UPLOAD_BYTES) {
    return void fail(res, 413, "UPLOAD_TOO_LARGE", `PDF must be between 1 byte and ${MAX_UPLOAD_BYTES} bytes.`);
  }
  if (!Number.isSafeInteger(requestedPartSize) || requestedPartSize < MIN_PART_SIZE || requestedPartSize > MAX_PART_SIZE) {
    return void fail(res, 400, "INVALID_MANIFEST", `partSize must be between ${MIN_PART_SIZE} and ${MAX_PART_SIZE} bytes.`);
  }
  const partCount = Math.ceil(totalBytes / requestedPartSize);
  const fileSha256 = body?.fileSha256 === undefined ? null : normalizeSha256(body.fileSha256);
  if (body?.fileSha256 !== undefined && !fileSha256) {
    return void fail(res, 400, "INVALID_MANIFEST", "fileSha256 must be a SHA-256 hex digest.");
  }

  const active = await db
    .select({ count: sql<number>`count(*)` })
    .from(catalogPdfUploadSessionTable)
    .where(and(
      eq(catalogPdfUploadSessionTable.ownerClerkUserId, owner),
      inArray(catalogPdfUploadSessionTable.status, ["open", "completing"]),
    ));
  if (Number(active[0]?.count ?? 0) >= MAX_ACTIVE_SESSIONS) {
    return void fail(res, 429, "UPLOAD_QUOTA_EXCEEDED", "You already have the maximum number of active catalog uploads.");
  }

  const now = new Date();
  const sessionId = randomUUID();
  const [session] = await db.insert(catalogPdfUploadSessionTable).values({
    id: sessionId,
    ownerClerkUserId: owner,
    vendor,
    filename,
    totalBytes,
    partSize: requestedPartSize,
    partCount,
    fileSha256,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
  }).returning();
  if (!session) return void fail(res, 500, "UPLOAD_SESSION_CREATE_FAILED", "Could not create the upload session.");
  res.status(201).json({
    ...sessionPayload(session, []),
    protocol: "catalog-pdf-upload-v1",
    maxPartBytes: MAX_PART_SIZE,
  });
});

router.get("/catalog-pdf/upload-sessions/:sessionId", requireAdminAuth, async (req, res) => {
  const session = await getOwnedSession(req, res, routeParam(req.params.sessionId));
  if (!session) return;
  const parts = await db.select().from(catalogPdfUploadPartTable)
    .where(eq(catalogPdfUploadPartTable.sessionId, session.id))
    .orderBy(asc(catalogPdfUploadPartTable.partIndex));
  res.json(sessionPayload(session, parts));
});

router.put("/catalog-pdf/upload-sessions/:sessionId/parts/:partIndex", requireAdminAuth, async (req, res) => {
  const session = await getOwnedSession(req, res, routeParam(req.params.sessionId));
  if (!session) return;
  const rate = await catalogPdfUploadLimiter.check(`part:${adminId(req, res)}`, requestId(res));
  if (!rate.allowed) {
    res.set("Retry-After", String(Math.ceil(rate.retryAfterMs / 1000)));
    return void fail(res, 429, "UPLOAD_RATE_LIMITED", "Too many catalog upload parts. Please try again later.");
  }

  const partIndex = Number(routeParam(req.params.partIndex));
  const bytes = Buffer.isBuffer(req.body) ? req.body : null;
  const range = parseContentRange(typeof req.headers["content-range"] === "string" ? req.headers["content-range"] : undefined);
  const checksum = normalizeSha256(req.headers["x-part-sha256"] ?? req.headers["x-checksum-sha256"]);
  const expectedOffset = partIndex * session.partSize;
  const expectedLength = partIndex === session.partCount - 1
    ? session.totalBytes - expectedOffset
    : session.partSize;
  if (!Number.isSafeInteger(partIndex) || partIndex < 0 || partIndex >= session.partCount) {
    return void fail(res, 400, "INVALID_PART_RANGE", "partIndex is outside the upload manifest.");
  }
  if (!bytes || bytes.length !== expectedLength || !range
      || range.start !== expectedOffset || range.end !== expectedOffset + expectedLength - 1
      || range.total !== session.totalBytes) {
    return void fail(res, 400, "INVALID_PART_RANGE", "Part range and byte length do not match the upload manifest.");
  }
  const actualChecksum = createHash("sha256").update(bytes).digest("hex");
  if (!checksum || checksum !== actualChecksum) {
    return void fail(res, 400, "CHECKSUM_MISMATCH", "Part checksum does not match the uploaded bytes.");
  }

  let objectPath: string | null = null;
  try {
    const result = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(catalogPdfUploadSessionTable)
        .where(and(
          eq(catalogPdfUploadSessionTable.id, session.id),
          eq(catalogPdfUploadSessionTable.ownerClerkUserId, adminId(req, res)),
        ))
        .for("update");
      if (!locked) return { kind: "missing" as const };
      if (locked.status !== "open") return { kind: "terminal" as const, status: locked.status };
      const [existing] = await tx.select().from(catalogPdfUploadPartTable).where(and(
        eq(catalogPdfUploadPartTable.sessionId, session.id),
        eq(catalogPdfUploadPartTable.partIndex, partIndex),
      ));
      if (existing) {
        if (existing.sha256 === actualChecksum && existing.byteLength === bytes.length && existing.offset === expectedOffset) {
          return { kind: "same" as const, part: existing };
        }
        return { kind: "conflict" as const };
      }
      objectPath = await writeCatalogPdfPart(session.id, partIndex, bytes);
      const partValues = {
        sessionId: session.id,
        partIndex,
        offset: expectedOffset,
        byteLength: bytes.length,
        sha256: actualChecksum,
        objectPath,
        ...(requestId(res) ? { metadata: { requestId: requestId(res)! } } : {}),
      };
      await tx.insert(catalogPdfUploadPartTable).values(partValues);
      await tx.update(catalogPdfUploadSessionTable).set({
        uploadedBytes: sql`${catalogPdfUploadSessionTable.uploadedBytes} + ${bytes.length}`,
        uploadedParts: sql`${catalogPdfUploadSessionTable.uploadedParts} + 1`,
        updatedAt: new Date(),
      }).where(eq(catalogPdfUploadSessionTable.id, session.id));
      return { kind: "stored" as const };
    });
    if (result.kind === "missing") return void fail(res, 404, "UPLOAD_SESSION_NOT_FOUND", "Upload session not found.");
    if (result.kind === "terminal") return void fail(res, 409, "UPLOAD_SESSION_TERMINAL", `Upload session is ${result.status}.`);
    if (result.kind === "conflict") return void fail(res, 409, "PART_CONFLICT", "A different part is already recorded at this index.");
    res.status(result.kind === "same" ? 200 : 201).json({
      sessionId: session.id,
      partIndex,
      offset: expectedOffset,
      byteLength: bytes.length,
      sha256: actualChecksum,
      idempotent: result.kind === "same",
      uploadedBytes: result.kind === "same" ? session.uploadedBytes : undefined,
    });
  } catch (err) {
    if (objectPath) {
      await deleteCatalogPdfPart(session.id, partIndex).catch(() => {});
    }
    res.locals.logger?.error?.({ err, sessionId: session.id, partIndex }, "[catalog-pdf-upload] part storage failed");
    fail(res, 503, "STAGING_UNAVAILABLE", "Could not stage this upload part. Please retry.");
  }
});

router.post("/catalog-pdf/upload-sessions/:sessionId/complete", requireAdminAuth, async (req, res) => {
  const session = await getOwnedSession(req, res, routeParam(req.params.sessionId));
  if (!session) return;
  const requestedDigest = req.body?.fileSha256;
  if (requestedDigest !== undefined && normalizeSha256(requestedDigest) !== session.fileSha256) {
    return void fail(res, 400, "MANIFEST_CONFLICT", "Completion digest does not match the immutable upload manifest.");
  }

  let jobId: number | null = null;
  try {
    const transition = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(catalogPdfUploadSessionTable)
        .where(and(eq(catalogPdfUploadSessionTable.id, session.id), eq(catalogPdfUploadSessionTable.ownerClerkUserId, adminId(req, res))))
        .for("update");
      if (!locked) return { kind: "missing" as const };
      if (locked.status === "completed" && locked.processingJobId) return { kind: "done" as const, jobId: locked.processingJobId };
      if (locked.status !== "open") return { kind: "terminal" as const, status: locked.status };
      const parts = await tx.select().from(catalogPdfUploadPartTable)
        .where(eq(catalogPdfUploadPartTable.sessionId, locked.id)).orderBy(asc(catalogPdfUploadPartTable.partIndex));
      if (parts.length !== locked.partCount || parts.some((part, index) =>
        part.partIndex !== index || part.offset !== index * locked.partSize
        || part.byteLength !== (index === locked.partCount - 1 ? locked.totalBytes - part.offset : locked.partSize)
      )) {
        return { kind: "missing-parts" as const, missing: Array.from({ length: locked.partCount }, (_, index) => index).filter((index) => !parts.some((part) => part.partIndex === index)) };
      }
      await tx.update(catalogPdfUploadSessionTable).set({ status: "completing", updatedAt: new Date() })
        .where(eq(catalogPdfUploadSessionTable.id, locked.id));
      const buffers = await Promise.all(parts.map((part) => readCatalogPdfPart(locked.id, part.partIndex)));
      const pdf = Buffer.concat(buffers);
      if (pdf.length !== locked.totalBytes || (locked.fileSha256 && createHash("sha256").update(pdf).digest("hex") !== locked.fileSha256)) {
        await tx.update(catalogPdfUploadSessionTable).set({ status: "failed", errorCode: "WHOLE_FILE_CHECKSUM_MISMATCH", updatedAt: new Date() })
          .where(eq(catalogPdfUploadSessionTable.id, locked.id));
        return { kind: "bad-file" as const };
      }
      try {
        validatePdf(pdf);
      } catch {
        await tx.update(catalogPdfUploadSessionTable).set({ status: "failed", errorCode: "INVALID_PDF", updatedAt: new Date() })
          .where(eq(catalogPdfUploadSessionTable.id, locked.id));
        return { kind: "bad-pdf" as const };
      }
      const [job] = await tx.insert(catalogPdfJobTable).values({
        ownerClerkUserId: locked.ownerClerkUserId,
        vendor: locked.vendor,
        filename: locked.filename,
        status: "pending",
        processedPages: 0,
        matchedParts: 0,
      }).returning({ id: catalogPdfJobTable.id });
      if (!job) return { kind: "failed" as const };
      jobId = job.id;
      await tx.update(catalogPdfUploadSessionTable).set({
        status: "completed",
        processingJobId: job.id,
        uploadedBytes: locked.totalBytes,
        uploadedParts: locked.partCount,
        updatedAt: new Date(),
      }).where(eq(catalogPdfUploadSessionTable.id, locked.id));
      return { kind: "done" as const, jobId: job.id, pdf };
    });
    if (transition.kind === "missing-parts") return void res.status(409).json({
      error: "Upload is missing parts.",
      code: "MISSING_PARTS",
      missingPartIndices: transition.missing,
      requestId: requestId(res),
    });
    if (transition.kind === "bad-file") {
      await cleanupCatalogPdfUploadSession(session.id);
      return void fail(res, 422, "WHOLE_FILE_CHECKSUM_MISMATCH", "The staged PDF failed whole-file verification.");
    }
    if (transition.kind === "bad-pdf") {
      await cleanupCatalogPdfUploadSession(session.id);
      return void fail(res, 422, "INVALID_PDF", "The staged file is not a readable PDF.");
    }
    if (transition.kind === "terminal" || transition.kind === "missing") return void fail(res, 409, "UPLOAD_SESSION_TERMINAL", "Upload session is no longer open.");
    if (!transition.jobId) {
      await cleanupCatalogPdfUploadSession(session.id);
      return void fail(res, 500, "PROCESSING_JOB_CREATE_FAILED", "Could not create the catalog processing job.");
    }
    if ("pdf" in transition && transition.pdf) {
      launchCatalogPdfBuffer(transition.jobId, transition.pdf, session.vendor);
      // The worker owns the assembled Buffer now, so remove source bytes while
      // retaining the completed manifest's metadata for status/history reads.
      await cleanupCatalogPdfUploadSession(session.id, false);
    }
    res.json({ sessionId: session.id, status: "completed", jobId: String(transition.jobId), processingJobId: String(transition.jobId) });
  } catch (err) {
    res.locals.logger?.error?.({ err, sessionId: session.id, jobId }, "[catalog-pdf-upload] completion failed");
    fail(res, 503, "UPLOAD_COMPLETION_UNAVAILABLE", "Upload completion is temporarily unavailable. Query status and retry.");
  }
});

router.post("/catalog-pdf/upload-sessions/:sessionId/cancel", requireAdminAuth, async (req, res) => {
  const session = await getOwnedSession(req, res, routeParam(req.params.sessionId), true);
  if (!session) return;
  const [updated] = await db.update(catalogPdfUploadSessionTable).set({
    status: "cancelled",
    errorCode: "cancelled",
    cleanupAt: new Date(),
    updatedAt: new Date(),
  }).where(and(
    eq(catalogPdfUploadSessionTable.id, session.id),
    eq(catalogPdfUploadSessionTable.ownerClerkUserId, adminId(req, res)),
    inArray(catalogPdfUploadSessionTable.status, ["open", "completing"]),
  )).returning();
  if (!updated && session.status !== "cancelled") return void fail(res, 409, "UPLOAD_SESSION_TERMINAL", `Upload session is ${session.status}.`);
  await cleanupCatalogPdfUploadSession(session.id);
  res.json({ sessionId: session.id, status: "cancelled" });
});

/** Called after API restart to resume pending extraction and expire abandoned manifests. */
export async function recoverCatalogPdfUploadSessions(): Promise<void> {
  // A process can die while the completion transaction is reading staged
  // objects. Re-open that manifest; the next status/complete request can
  // safely perform the same idempotent finalization.
  await db.update(catalogPdfUploadSessionTable)
    .set({ status: "open", updatedAt: new Date() })
    .where(and(
      eq(catalogPdfUploadSessionTable.status, "completing"),
      sql`${catalogPdfUploadSessionTable.expiresAt} > NOW()`,
    ));
  const expired = await db.select({ id: catalogPdfUploadSessionTable.id })
    .from(catalogPdfUploadSessionTable)
    .where(and(
      lt(catalogPdfUploadSessionTable.expiresAt, new Date()),
      inArray(catalogPdfUploadSessionTable.status, ["open", "completing"]),
    ));
  await Promise.all(expired.map((row) => expireSession(row.id).catch(() => {})));
  const pending = await db.select({
    sessionId: catalogPdfUploadSessionTable.id,
    jobId: catalogPdfUploadSessionTable.processingJobId,
    vendor: catalogPdfUploadSessionTable.vendor,
    cleanupAt: catalogPdfUploadSessionTable.cleanupAt,
  }).from(catalogPdfUploadSessionTable)
    .innerJoin(catalogPdfJobTable, eq(catalogPdfJobTable.id, catalogPdfUploadSessionTable.processingJobId))
    .where(and(
      eq(catalogPdfUploadSessionTable.status, "completed"),
      inArray(catalogPdfJobTable.status, ["pending", "processing"]),
    ));
  for (const row of pending) {
    if (!row.jobId) continue;
    // A completed session's source bytes are removed after the worker is
    // handed the assembled buffer. Its retained part rows are metadata only;
    // never attempt to read those already-cleaned objects after a restart.
    if (row.cleanupAt) continue;
    const parts = await db.select().from(catalogPdfUploadPartTable)
      .where(eq(catalogPdfUploadPartTable.sessionId, row.sessionId))
      .orderBy(asc(catalogPdfUploadPartTable.partIndex));
    const pdf = Buffer.concat(await Promise.all(parts.map((part) => readCatalogPdfPart(row.sessionId, part.partIndex))));
    launchCatalogPdfBuffer(row.jobId, pdf, row.vendor);
  }
}

export default router;