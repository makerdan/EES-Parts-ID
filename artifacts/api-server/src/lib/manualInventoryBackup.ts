import { randomUUID } from "node:crypto";

import { db, inventorySnapshotAuditTable } from "@workspace/db";
import { and, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";

import { runInventoryBackup } from "./inventorySnapshot";
import { boundedErrorDiagnostic, logger } from "./logger";

export type ManualInventoryBackupStatus = {
  status: "running" | "completed" | "failed";
  persistence: "saved" | "unavailable";
  startedAt: string;
  finishedAt: string | null;
  rowCount: number | null;
  snapshotId: string | null;
  error: string | null;
  warning: string | null;
};

const SAFE_FAILURE_MESSAGE = "Inventory backup failed. Please try again.";
const RESTART_FAILURE_MESSAGE = "Backup interrupted by an API server restart. Please try again.";
const STATUS_PERSISTENCE_WARNING = "Backup status could not be saved. The result may not survive an API server restart.";
const START_STATUS_PERSISTENCE_FAILURE = "Backup could not be started because its status could not be saved. Please try again.";
const MANUAL_BACKUP_ACTION = "manual-backup" as const;
const MANUAL_BACKUP_LOCK = "manual-inventory-backup";
const MANUAL_BACKUP_LEASE_MS = 15 * 60 * 1000;
const MANUAL_BACKUP_LEASE_RENEWAL_MS = MANUAL_BACKUP_LEASE_MS / 3;

let latestManualBackup: ManualInventoryBackupStatus | null = null;
let activeManualBackup: Promise<void> | null = null;

function copyStatus(status: ManualInventoryBackupStatus): ManualInventoryBackupStatus {
  return { ...status };
}

function persistedStatus(row: {
  outcome: string;
  createdAt: Date;
  finishedAt: Date | null;
  rowCount: number | null;
  snapshotId: string;
  errorMessage: string | null;
  leaseExpiresAt?: Date | null;
}): ManualInventoryBackupStatus {
  const status = row.outcome === "completed" || row.outcome === "failed"
    ? row.outcome
    : "running";
  return {
    status,
    persistence: "saved",
    startedAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    rowCount: status === "completed" ? row.rowCount : null,
    snapshotId: status === "completed" ? row.snapshotId : null,
    error: status === "failed" && row.errorMessage === RESTART_FAILURE_MESSAGE
      ? RESTART_FAILURE_MESSAGE
      : status === "failed"
        ? SAFE_FAILURE_MESSAGE
        : null,
    warning: null,
  };
}

async function persistTerminalStatus(
  operationId: string,
  status: {
    outcome: "completed" | "failed";
    finishedAt: Date;
    rowCount: number | null;
    snapshotId: string;
    errorMessage: string | null;
  },
): Promise<void> {
  const updated = await db
    .update(inventorySnapshotAuditTable)
    .set({ ...status, leaseExpiresAt: null })
    .where(and(
      eq(inventorySnapshotAuditTable.action, MANUAL_BACKUP_ACTION),
      eq(inventorySnapshotAuditTable.snapshotId, operationId),
      eq(inventorySnapshotAuditTable.outcome, "running"),
    ))
    .returning({ id: inventorySnapshotAuditTable.id });
  if (updated.length !== 1) {
    throw new Error("Manual inventory backup status was no longer active");
  }
}

async function executeManualBackup(
  operationId: string,
  startedAt: string,
): Promise<void> {
  const leaseRenewal = setInterval(() => {
    void renewManualBackupLease(operationId).catch(error => {
      logger.warn(
        { ...boundedErrorDiagnostic(error), action: MANUAL_BACKUP_ACTION },
        "Failed to renew manual inventory backup lease",
      );
    });
  }, MANUAL_BACKUP_LEASE_RENEWAL_MS);
  leaseRenewal.unref?.();
  try {
    let result: Awaited<ReturnType<typeof runInventoryBackup>>;
    try {
      result = await runInventoryBackup("manual-admin");
    } catch (error) {
      logger.error(
        { ...boundedErrorDiagnostic(error), operation: "manual_inventory_backup" },
        "Manual inventory backup failed",
      );
      const finishedAt = new Date();
      let persistence: ManualInventoryBackupStatus["persistence"] = "saved";
      try {
        await persistTerminalStatus(operationId, {
          outcome: "failed",
          finishedAt,
          rowCount: null,
          snapshotId: operationId,
          errorMessage: SAFE_FAILURE_MESSAGE,
        });
      } catch (persistError) {
        persistence = "unavailable";
        logger.error(
          { ...boundedErrorDiagnostic(persistError), action: MANUAL_BACKUP_ACTION },
          "Failed to persist manual inventory backup failure",
        );
      }
      latestManualBackup = {
        status: "failed",
        persistence,
        startedAt,
        finishedAt: finishedAt.toISOString(),
        rowCount: null,
        snapshotId: null,
        error: SAFE_FAILURE_MESSAGE,
        warning: persistence === "unavailable" ? STATUS_PERSISTENCE_WARNING : null,
      };
      return;
    }

    const finishedAt = new Date();
    try {
      await persistTerminalStatus(operationId, {
        outcome: "completed",
        finishedAt,
        rowCount: result.manifest.rowCount,
        snapshotId: result.manifest.snapshotId,
        errorMessage: null,
      });
    } catch (persistError) {
      logger.error(
        { ...boundedErrorDiagnostic(persistError), action: MANUAL_BACKUP_ACTION },
        "Failed to persist completed manual inventory backup",
      );
      latestManualBackup = {
        status: "completed",
        persistence: "unavailable",
        startedAt,
        finishedAt: finishedAt.toISOString(),
        rowCount: result.manifest.rowCount,
        snapshotId: result.manifest.snapshotId,
        error: null,
        warning: STATUS_PERSISTENCE_WARNING,
      };
      return;
    }

    latestManualBackup = {
      status: "completed",
      persistence: "saved",
      startedAt,
      finishedAt: finishedAt.toISOString(),
      rowCount: result.manifest.rowCount,
      snapshotId: result.manifest.snapshotId,
      error: null,
      warning: null,
    };
  } finally {
    clearInterval(leaseRenewal);
  }
}

type ManualBackupClaim =
  | { kind: "claimed"; operationId: string; startedAt: string }
  | { kind: "running"; status: ManualInventoryBackupStatus };

async function claimManualBackup(
  adminClerkUserId: string,
  operationId: string,
  startedAt: string,
): Promise<ManualBackupClaim> {
  const leaseExpiresAt = sql`now() + (${MANUAL_BACKUP_LEASE_MS} * interval '1 millisecond')`;
  return db.transaction(async (tx) => {
    // Serialize the select-and-claim sequence across API instances. The lock
    // is held only for this transaction; the lease protects the long-running
    // storage operation after the transaction has committed.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${MANUAL_BACKUP_LOCK}))`);

    const [active] = await tx
      .select({
        outcome: inventorySnapshotAuditTable.outcome,
        createdAt: inventorySnapshotAuditTable.createdAt,
        finishedAt: inventorySnapshotAuditTable.finishedAt,
        rowCount: inventorySnapshotAuditTable.rowCount,
        snapshotId: inventorySnapshotAuditTable.snapshotId,
        errorMessage: inventorySnapshotAuditTable.errorMessage,
        leaseExpiresAt: inventorySnapshotAuditTable.leaseExpiresAt,
        id: inventorySnapshotAuditTable.id,
      })
      .from(inventorySnapshotAuditTable)
      .where(and(
        eq(inventorySnapshotAuditTable.action, MANUAL_BACKUP_ACTION),
        eq(inventorySnapshotAuditTable.outcome, "running"),
        gt(inventorySnapshotAuditTable.leaseExpiresAt, sql`now()`),
      ))
      .orderBy(desc(inventorySnapshotAuditTable.createdAt), desc(inventorySnapshotAuditTable.id))
      .limit(1);

    if (active) {
      return { kind: "running", status: persistedStatus(active) };
    }

    const [expired] = await tx
      .select({
        outcome: inventorySnapshotAuditTable.outcome,
        createdAt: inventorySnapshotAuditTable.createdAt,
        finishedAt: inventorySnapshotAuditTable.finishedAt,
        rowCount: inventorySnapshotAuditTable.rowCount,
        snapshotId: inventorySnapshotAuditTable.snapshotId,
        errorMessage: inventorySnapshotAuditTable.errorMessage,
        id: inventorySnapshotAuditTable.id,
      })
      .from(inventorySnapshotAuditTable)
      .where(and(
        eq(inventorySnapshotAuditTable.action, MANUAL_BACKUP_ACTION),
        eq(inventorySnapshotAuditTable.outcome, "running"),
        or(
          isNull(inventorySnapshotAuditTable.leaseExpiresAt),
          lte(inventorySnapshotAuditTable.leaseExpiresAt, sql`now()`),
        ),
      ))
      .orderBy(desc(inventorySnapshotAuditTable.createdAt), desc(inventorySnapshotAuditTable.id))
      .limit(1);

    if (expired) {
      const recovered = await tx
        .update(inventorySnapshotAuditTable)
        .set({
          outcome: "failed",
          finishedAt: sql`now()`,
          errorMessage: RESTART_FAILURE_MESSAGE,
          leaseExpiresAt: null,
        })
        .where(and(
          eq(inventorySnapshotAuditTable.id, expired.id),
          eq(inventorySnapshotAuditTable.outcome, "running"),
          or(
            isNull(inventorySnapshotAuditTable.leaseExpiresAt),
            lte(inventorySnapshotAuditTable.leaseExpiresAt, sql`now()`),
          ),
        ))
        .returning({ id: inventorySnapshotAuditTable.id });
      if (recovered.length !== 1) throw new Error("Manual inventory backup claim was not accepted");
    }
    await tx.insert(inventorySnapshotAuditTable).values({
      adminClerkUserId,
      snapshotId: operationId,
      action: MANUAL_BACKUP_ACTION,
      outcome: "running",
      rowCount: null,
      errorMessage: null,
      leaseExpiresAt,
    });
    return { kind: "claimed", operationId, startedAt };
  });
}

async function renewManualBackupLease(operationId: string): Promise<void> {
  await db
    .update(inventorySnapshotAuditTable)
    .set({ leaseExpiresAt: sql`now() + (${MANUAL_BACKUP_LEASE_MS} * interval '1 millisecond')` })
    .where(and(
      eq(inventorySnapshotAuditTable.action, MANUAL_BACKUP_ACTION),
      eq(inventorySnapshotAuditTable.snapshotId, operationId),
      eq(inventorySnapshotAuditTable.outcome, "running"),
    ));
}

/**
 * Mark expired running rows as failed before the API accepts requests.
 * A live lease belongs to another API instance and must remain visible as
 * running.
 */
export async function recoverInterruptedManualInventoryBackups(): Promise<void> {
  const finishedAt = new Date();
  let interrupted: Array<{ id: number }>;
  try {
    interrupted = await db
      .update(inventorySnapshotAuditTable)
      .set({
        outcome: "failed",
        finishedAt,
        errorMessage: RESTART_FAILURE_MESSAGE,
        leaseExpiresAt: null,
      })
      .where(and(
        eq(inventorySnapshotAuditTable.action, MANUAL_BACKUP_ACTION),
        eq(inventorySnapshotAuditTable.outcome, "running"),
        or(
          isNull(inventorySnapshotAuditTable.leaseExpiresAt),
          lte(inventorySnapshotAuditTable.leaseExpiresAt, sql`now()`),
        ),
      ))
      .returning({ id: inventorySnapshotAuditTable.id });
  } catch (error) {
    latestManualBackup = {
      status: "failed",
      persistence: "unavailable",
      startedAt: finishedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      rowCount: null,
      snapshotId: null,
      error: RESTART_FAILURE_MESSAGE,
      warning: STATUS_PERSISTENCE_WARNING,
    };
    logger.error(
      { ...boundedErrorDiagnostic(error), action: MANUAL_BACKUP_ACTION },
      "Failed to persist interrupted manual inventory backup recovery",
    );
    return;
  }
  if (interrupted.length > 0) {
    logger.warn(
      { interruptedBackupCount: interrupted.length },
      "Marked interrupted manual inventory backup(s) as failed on startup",
    );
  }
}

/**
 * Claims at most one manual backup across all API instances. The returned
 * state is a snapshot of the accepted operation; callers must use
 * getManualBackupStatus for later completion or failure updates.
 */
export async function startManualInventoryBackup(adminClerkUserId: string): Promise<ManualInventoryBackupStatus> {
  if (activeManualBackup && latestManualBackup?.status === "running") {
    return copyStatus(latestManualBackup);
  }

  const operationId = randomUUID();
  const startedAt = new Date().toISOString();
  let claim: ManualBackupClaim;
  try {
    claim = await claimManualBackup(adminClerkUserId, operationId, startedAt);
  } catch (error) {
    const finishedAt = new Date().toISOString();
    latestManualBackup = {
      status: "failed",
      persistence: "unavailable",
      startedAt,
      finishedAt,
      rowCount: null,
      snapshotId: null,
      error: START_STATUS_PERSISTENCE_FAILURE,
      warning: STATUS_PERSISTENCE_WARNING,
    };
    logger.error(
      { ...boundedErrorDiagnostic(error), action: MANUAL_BACKUP_ACTION },
      "Failed to start manual inventory backup",
    );
    return copyStatus(latestManualBackup);
  }
  if (claim.kind === "running") {
    latestManualBackup = copyStatus(claim.status);
    return copyStatus(claim.status);
  }

  latestManualBackup = {
    status: "running",
    persistence: "saved",
    startedAt,
    finishedAt: null,
    rowCount: null,
    snapshotId: null,
    error: null,
    warning: null,
  };

  activeManualBackup = executeManualBackup(operationId, startedAt);
  void activeManualBackup.finally(() => {
    activeManualBackup = null;
  });
  return copyStatus(latestManualBackup);
}

export async function getManualInventoryBackupStatus(): Promise<ManualInventoryBackupStatus | null> {
  if (activeManualBackup && latestManualBackup?.status === "running") {
    return copyStatus(latestManualBackup);
  }

  let row: Awaited<ReturnType<typeof loadLatestManualBackupRow>>;
  try {
    row = await loadLatestManualBackupRow();
  } catch (error) {
    if (latestManualBackup?.persistence === "unavailable") return copyStatus(latestManualBackup);
    throw error;
  }
  if (latestManualBackup?.persistence === "unavailable" &&
      (!row || (row.createdAt.getTime() <= Date.parse(latestManualBackup.startedAt) &&
        (!row.finishedAt || row.finishedAt.getTime() < Date.parse(latestManualBackup.startedAt))))) {
    return copyStatus(latestManualBackup);
  }
  return row ? persistedStatus(row) : latestManualBackup ? copyStatus(latestManualBackup) : null;
}

async function loadLatestManualBackupRow() {
  const [row] = await db
    .select({
      outcome: inventorySnapshotAuditTable.outcome,
      createdAt: inventorySnapshotAuditTable.createdAt,
      finishedAt: inventorySnapshotAuditTable.finishedAt,
      rowCount: inventorySnapshotAuditTable.rowCount,
      snapshotId: inventorySnapshotAuditTable.snapshotId,
      errorMessage: inventorySnapshotAuditTable.errorMessage,
    })
    .from(inventorySnapshotAuditTable)
    .where(eq(inventorySnapshotAuditTable.action, MANUAL_BACKUP_ACTION))
    .orderBy(
      desc(inventorySnapshotAuditTable.createdAt),
      desc(inventorySnapshotAuditTable.id),
    )
    .limit(1);

  return row;
}
