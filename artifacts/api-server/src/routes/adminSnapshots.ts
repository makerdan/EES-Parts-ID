import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import {
  CreateAdminInventorySnapshotResponse,
  DryRunAdminInventorySnapshotRestoreResponse,
  GetAdminInventorySnapshotHealthResponse,
  GetAdminManualInventoryBackupStatusResponse,
  ListAdminInventorySnapshotsResponse,
  ListAdminManualInventoryBackupHistoryResponse,
} from "@workspace/api-zod";
import { db, inventorySnapshotAuditTable, inventoryTable } from "@workspace/db";
import { and, desc, eq, lt } from "drizzle-orm";
import { Router } from "express";

import { invalidateReferenceAnswerCache } from "../lib/answerCache";
import {
  createInventorySnapshotLocked,
  listVerifiedInventorySnapshots,
  withInventorySnapshotLock,
} from "../lib/inventorySnapshot";
import { inventorySnapshotHealth } from "../lib/inventorySnapshotHealth";
import { restoreInventoryRowsLocked } from "../lib/inventorySnapshotRestore";
import { readVerifiedSnapshot } from "../lib/inventorySnapshotStorage";
import { boundedErrorDiagnostic, getLogger } from "../lib/logger";
import {
  getManualInventoryBackupStatus,
  startManualInventoryBackup,
} from "../lib/manualInventoryBackup";
import { getAdminClerkUserId, requireApprovedAdminAuth } from "../middlewares/requireAdminAuth";

const router = Router();
const CONFIRMATION_TTL_MS = 10 * 60 * 1000;

class RestoreConfirmationMismatchError extends Error {}

function currentInventoryDigest(rows: ReadonlyArray<{ vendor: string; catalog: string; updatedAt?: Date | null }>): string {
  return createHash("sha256")
    .update(rows.map((row) => `${row.vendor}\0${row.catalog}\0${row.updatedAt?.toISOString() ?? ""}`).join("\n"))
    .digest("hex");
}

function confirmationToken(snapshotId: string, snapshotChecksum: string, currentDigest: string, expiresAt: number): string {
  const payload = `${snapshotId}:${snapshotChecksum}:${currentDigest}:${expiresAt}`;
  const secret = process.env.SESSION_SECRET ?? process.env.CLERK_SECRET_KEY;
  if (!secret) throw new Error("Server confirmation secret is not configured");
  return `${expiresAt}.${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

function validateRestorableRows(rows: ReadonlyArray<Record<string, unknown>>): void {
  const arrays = ["binLocations", "aiKeywords", "pinnedKeywords", "barcodes"];
  const nullableStrings = ["imageUrl", "thumbnailUrl", "imageUrl2", "thumbnailUrl2", "imageSource", "previousDescription", "expandedDescription", "size"];
  const dates = ["enrichedAt", "createdAt", "updatedAt"];
  for (const row of rows) {
    if (!Number.isSafeInteger(row.id) || Number(row.id) <= 0) throw new Error("Invalid snapshot row id");
    for (const field of ["vendor", "catalog", "description"]) {
      if (typeof row[field] !== "string") throw new Error(`Invalid snapshot row ${field}`);
    }
    for (const field of ["orderPurchase", "orderQuantity"]) {
      if (!Number.isSafeInteger(row[field]) || Number(row[field]) < 0) throw new Error(`Invalid snapshot row ${field}`);
    }
    for (const field of arrays) {
      if (!Array.isArray(row[field]) || row[field].some((value) => typeof value !== "string")) throw new Error(`Invalid snapshot row ${field}`);
    }
    for (const field of nullableStrings) {
      if (row[field] !== null && row[field] !== undefined && typeof row[field] !== "string") throw new Error(`Invalid snapshot row ${field}`);
    }
    if (row.imageConfidence !== null && row.imageConfidence !== undefined &&
        (typeof row.imageConfidence !== "number" || !Number.isFinite(row.imageConfidence))) {
      throw new Error("Invalid snapshot row imageConfidence");
    }
    if (row.catalogPdfJobId !== null && row.catalogPdfJobId !== undefined && !Number.isSafeInteger(row.catalogPdfJobId)) {
      throw new Error("Invalid snapshot row catalogPdfJobId");
    }
    for (const field of dates) {
      if (row[field] !== null && row[field] !== undefined &&
          (typeof row[field] !== "string" || !Number.isFinite(Date.parse(row[field])))) {
        throw new Error(`Invalid snapshot row ${field}`);
      }
    }
  }
}

router.get("/snapshots", requireApprovedAdminAuth, async (_req, res) => {
  try {
    const snapshots = await listVerifiedInventorySnapshots();
    res.json(ListAdminInventorySnapshotsResponse.parse(
      snapshots.map(({ dataPath: _dataPath, manifestPath: _manifestPath, ...summary }) => summary),
    ));
  } catch {
    res.status(500).json({ error: "Failed to list inventory snapshots" });
  }
});

router.get("/snapshots/health", requireApprovedAdminAuth, async (_req, res) => {
  try {
    res.json(GetAdminInventorySnapshotHealthResponse.parse(inventorySnapshotHealth(await listVerifiedInventorySnapshots())));
  } catch {
    res.status(500).json({ error: "Failed to evaluate inventory backup health" });
  }
});

router.post("/snapshots/dry-run", requireApprovedAdminAuth, async (req, res) => {
  const snapshotId = req.body?.snapshotId;
  if (typeof snapshotId !== "string" || snapshotId.trim().length === 0) {
    return void res.status(400).json({ error: "A snapshot ID is required" });
  }

  const reqLogger = getLogger(res);
  try {
    const snapshot = (await listVerifiedInventorySnapshots()).find((item) => item.snapshotId === snapshotId);
    if (!snapshot) return void res.status(404).json({ error: "Snapshot not found" });
    const stored = await readVerifiedSnapshot(snapshot);
    const current = await db.select({ vendor: inventoryTable.vendor, catalog: inventoryTable.catalog, updatedAt: inventoryTable.updatedAt }).from(inventoryTable);
    const currentKeys = new Set(current.map((row) => `${row.vendor}\0${row.catalog}`));
    const snapshotKeys = new Set(stored.rows.map((row) => `${String(row.vendor)}\0${String(row.catalog)}`));
    const currentDigest = currentInventoryDigest(current);
    const issuedAt = Date.now();
    const expiresAt = issuedAt + CONFIRMATION_TTL_MS;
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt) {
      throw new Error("Could not create a valid restore confirmation expiry");
    }
    const response = DryRunAdminInventorySnapshotRestoreResponse.parse({
      snapshotId: snapshot.snapshotId,
      inserts: stored.rows.filter((row) => !currentKeys.has(`${String(row.vendor)}\0${String(row.catalog)}`)).length,
      removes: current.filter((row) => !snapshotKeys.has(`${row.vendor}\0${row.catalog}`)).length,
      updates: stored.rows.filter((row) => currentKeys.has(`${String(row.vendor)}\0${String(row.catalog)}`)).length,
      currentRowCount: current.length,
      snapshotRowCount: stored.rows.length,
      confirmationToken: confirmationToken(snapshot.snapshotId, snapshot.contentSha256, currentDigest, expiresAt),
      confirmationExpiresAt: new Date(expiresAt),
      currentInventorySha256: currentDigest,
    });
    await db.insert(inventorySnapshotAuditTable).values({
      adminClerkUserId: getAdminClerkUserId(req, res),
      snapshotId: snapshot.snapshotId,
      action: "dry-run",
      rowCount: stored.rows.length,
      outcome: "completed",
    });
    res.json(response);
  } catch (error) {
    reqLogger.error(boundedErrorDiagnostic(error), "Inventory snapshot dry run failed");
    res.status(500).json({ error: "Snapshot dry run failed; please try again" });
  }
});

router.post("/snapshots/restore", requireApprovedAdminAuth, async (req, res) => {
  const snapshotId = req.body?.snapshotId;
  const confirmationToken = req.body?.confirmationToken;
  const adminId = getAdminClerkUserId(req, res);
  const reqLogger = getLogger(res);
  let result: number;
  try {
    const snapshot = (await listVerifiedInventorySnapshots()).find((item) => item.snapshotId === snapshotId);
    if (!snapshot || typeof confirmationToken !== "string") {
      return void res.status(409).json({ error: "A fresh dry-run confirmation is required" });
    }
    const [expiresText, signature] = confirmationToken.split(".");
    const expiresAt = Number(expiresText);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || !signature) {
      return void res.status(409).json({ error: "The restore confirmation has expired" });
    }
    result = await withInventorySnapshotLock(async (tx) => {
      const current = await tx.select({ vendor: inventoryTable.vendor, catalog: inventoryTable.catalog, updatedAt: inventoryTable.updatedAt }).from(inventoryTable);
      const currentDigest = currentInventoryDigest(current);
      const expected = confirmationTokenValue(snapshot.snapshotId, snapshot.contentSha256, currentDigest, expiresAt);
      const provided = Buffer.from(signature, "hex");
      const expectedBytes = Buffer.from(expected, "hex");
      if (provided.length !== expectedBytes.length || !timingSafeEqual(provided, expectedBytes)) {
        throw new RestoreConfirmationMismatchError();
      }
      await createInventorySnapshotLocked(tx, "pre-restore");
      const stored = await readVerifiedSnapshot(snapshot);
      validateRestorableRows(stored.rows);
      return restoreInventoryRowsLocked(tx, stored.rows);
    });
  } catch (error) {
    if (error instanceof RestoreConfirmationMismatchError) {
      return void res.status(409).json({
        error: "Inventory changed since the dry run; run a new preview",
      });
    }
    try {
      if (typeof snapshotId === "string") {
        await db.insert(inventorySnapshotAuditTable).values({
          adminClerkUserId: adminId,
          snapshotId,
          action: "restore",
          outcome: "failed",
        });
      }
    } catch (auditError) {
      reqLogger.error(
        boundedErrorDiagnostic(auditError),
        "Failed to audit inventory restore failure",
      );
    }
    reqLogger.error(boundedErrorDiagnostic(error), "Inventory restore failed");
    return void res.status(500).json({ error: "Inventory restore failed; check inventory before retrying" });
  }

  // The transaction has committed. Failures below must never be presented as a rollback
  // or audited as a failed restore. Report each unfinished follow-up independently.
  const warnings: Array<string> = [];
  try {
    await db.insert(inventorySnapshotAuditTable).values({
      adminClerkUserId: adminId,
      snapshotId,
      action: "restore",
      rowCount: result,
      outcome: "completed",
    });
  } catch (error) {
    reqLogger.error(boundedErrorDiagnostic(error), "Failed to audit committed inventory restore");
    warnings.push("Restore committed, but its audit record could not be saved; contact an administrator to record the result");
  }
  try {
    await invalidateReferenceAnswerCache({ throwOnError: true });
  } catch (error) {
    reqLogger.error(boundedErrorDiagnostic(error), "Failed to invalidate cache after committed inventory restore");
    warnings.push("Restore committed, but cached answers could not be cleared; contact an administrator to clear them");
  }
  res.json({ restored: result, snapshotId, ...(warnings.length ? { warnings } : {}) });
});

router.get("/snapshots/status", requireApprovedAdminAuth, async (_req, res) => {
  try {
    const status = await getManualInventoryBackupStatus();
    res.json(GetAdminManualInventoryBackupStatusResponse.parse(status));
  } catch {
    res.status(500).json({ error: "Failed to fetch inventory backup status" });
  }
});

router.get("/snapshots/history", requireApprovedAdminAuth, async (req, res) => {
  const rawLimit = Number(req.query.limit ?? 50);
  const limit = Number.isSafeInteger(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, 200)
    : 50;
  const rawBeforeId = req.query.before_id;
  const beforeId = rawBeforeId !== undefined ? Number(rawBeforeId) : null;
  if (beforeId !== null && (!Number.isSafeInteger(beforeId) || beforeId <= 0)) {
    return void res.status(400).json({ error: "before_id must be a positive integer" });
  }

  try {
    const whereClause = beforeId === null
      ? eq(inventorySnapshotAuditTable.action, "manual-backup")
      : and(
        eq(inventorySnapshotAuditTable.action, "manual-backup"),
        lt(inventorySnapshotAuditTable.id, beforeId),
      );
    const rows = await db
      .select({
        id: inventorySnapshotAuditTable.id,
        adminClerkUserId: inventorySnapshotAuditTable.adminClerkUserId,
        snapshotId: inventorySnapshotAuditTable.snapshotId,
        rowCount: inventorySnapshotAuditTable.rowCount,
        outcome: inventorySnapshotAuditTable.outcome,
        createdAt: inventorySnapshotAuditTable.createdAt,
      })
      .from(inventorySnapshotAuditTable)
      .where(whereClause)
      .orderBy(desc(inventorySnapshotAuditTable.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? pageRows[pageRows.length - 1]!.id : null;
    return res.json(ListAdminManualInventoryBackupHistoryResponse.parse({
      rows: pageRows,
      nextCursor,
    }));
  } catch {
    return res.status(500).json({ error: "Failed to fetch database backup history" });
  }
});

router.post("/snapshots", requireApprovedAdminAuth, async (req, res) => {
  const adminId = getAdminClerkUserId(req, res);
  try {
    const status = await startManualInventoryBackup(adminId);
    res.status(202).json(CreateAdminInventorySnapshotResponse.parse(status));
  } catch {
    res.status(500).json({ error: "Failed to start inventory backup" });
  }
});

export default router;

function confirmationTokenValue(snapshotId: string, checksum: string, currentDigest: string, expiresAt: number): string {
  const secret = process.env.SESSION_SECRET ?? process.env.CLERK_SECRET_KEY;
  if (!secret) throw new Error("Server confirmation secret is not configured");
  return createHmac("sha256", secret).update(`${snapshotId}:${checksum}:${currentDigest}:${expiresAt}`).digest("hex");
}
