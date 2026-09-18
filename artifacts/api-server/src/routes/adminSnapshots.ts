import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import {
  CreateAdminInventorySnapshotResponse,
  DryRunAdminInventorySnapshotRestoreResponse,
  GetAdminInventorySnapshotHealthResponse,
  ListAdminInventorySnapshotsResponse,
} from "@workspace/api-zod";
import { db, inventorySnapshotAuditTable, inventoryTable } from "@workspace/db";
import { Router } from "express";

import { invalidateReferenceAnswerCache } from "../lib/answerCache";
import {
  createInventorySnapshot,
  createInventorySnapshotLocked,
  listVerifiedInventorySnapshots,
  withInventorySnapshotLock,
} from "../lib/inventorySnapshot";
import { inventorySnapshotHealth } from "../lib/inventorySnapshotHealth";
import { restoreInventoryRowsLocked } from "../lib/inventorySnapshotRestore";
import { readVerifiedSnapshot } from "../lib/inventorySnapshotStorage";
import { getAdminClerkUserId, requireApprovedAdminAuth } from "../middlewares/requireAdminAuth";

const router = Router();
const CONFIRMATION_TTL_MS = 10 * 60 * 1000;

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
  try {
    const snapshot = (await listVerifiedInventorySnapshots()).find((item) => item.snapshotId === req.body?.snapshotId);
    if (!snapshot) return void res.status(404).json({ error: "Snapshot not found" });
    const stored = await readVerifiedSnapshot(snapshot);
    const current = await db.select({ vendor: inventoryTable.vendor, catalog: inventoryTable.catalog, updatedAt: inventoryTable.updatedAt }).from(inventoryTable);
    const currentKeys = new Set(current.map((row) => `${row.vendor}\0${row.catalog}`));
    const snapshotKeys = new Set(stored.rows.map((row) => `${String(row.vendor)}\0${String(row.catalog)}`));
    const currentDigest = currentInventoryDigest(current);
    const expiresAt = Date.now() + CONFIRMATION_TTL_MS;
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
  } catch {
    res.status(400).json({ error: "Snapshot dry run failed" });
  }
});

router.post("/snapshots/restore", requireApprovedAdminAuth, async (req, res) => {
  const snapshotId = req.body?.snapshotId;
  const confirmationToken = req.body?.confirmationToken;
  const adminId = getAdminClerkUserId(req, res);
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
    const result = await withInventorySnapshotLock(async (tx) => {
      const current = await tx.select({ vendor: inventoryTable.vendor, catalog: inventoryTable.catalog, updatedAt: inventoryTable.updatedAt }).from(inventoryTable);
      const currentDigest = currentInventoryDigest(current);
      const expected = confirmationTokenValue(snapshot.snapshotId, snapshot.contentSha256, currentDigest, expiresAt);
      const provided = Buffer.from(signature, "hex");
      const expectedBytes = Buffer.from(expected, "hex");
      if (provided.length !== expectedBytes.length || !timingSafeEqual(provided, expectedBytes)) {
        throw new Error("Inventory changed since the dry run");
      }
      await createInventorySnapshotLocked(tx, "pre-restore");
      const stored = await readVerifiedSnapshot(snapshot);
      validateRestorableRows(stored.rows);
      return restoreInventoryRowsLocked(tx, stored.rows);
    });
    await db.insert(inventorySnapshotAuditTable).values({
      adminClerkUserId: adminId,
      snapshotId,
      action: "restore",
      rowCount: result,
      outcome: "completed",
    });
    await invalidateReferenceAnswerCache();
    res.json({ restored: result, snapshotId });
  } catch (error) {
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
      console.error("Failed to audit inventory restore failure", auditError);
    }
    console.error("Inventory restore failed", error);
    res.status(500).json({ error: "Inventory restore failed; no partial restore was committed" });
  }
});

router.post("/snapshots", requireApprovedAdminAuth, async (_req, res) => {
  try {
    const result = await createInventorySnapshot("scheduled");
    res.status(201).json(CreateAdminInventorySnapshotResponse.parse({
      ...result.manifest,
      dataPath: undefined,
      manifestPath: undefined,
    }));
  } catch {
    res.status(500).json({ error: "Inventory snapshot failed" });
  }
});

export default router;

function confirmationTokenValue(snapshotId: string, checksum: string, currentDigest: string, expiresAt: number): string {
  const secret = process.env.SESSION_SECRET ?? process.env.CLERK_SECRET_KEY;
  if (!secret) throw new Error("Server confirmation secret is not configured");
  return createHmac("sha256", secret).update(`${snapshotId}:${checksum}:${currentDigest}:${expiresAt}`).digest("hex");
}