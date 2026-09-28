/**
 * Regression coverage for manual inventory backups and snapshot route boundaries.
 *
 * The snapshot implementation is mocked so this suite proves the lifecycle
 * contract without touching production storage or a database.
 */

import express from "express";
import supertest from "supertest";

const mockRunInventoryBackup = jest.fn();
const mockTxExecute = jest.fn();
const mockInsertValues = jest.fn().mockResolvedValue(undefined);
const mockInsert = jest.fn(() => ({ values: mockInsertValues }));
const mockDelete = jest.fn();
const mockUpdateReturning = jest.fn().mockResolvedValue([{ id: 1 }]);
const mockUpdateWhere = jest.fn(() => ({ returning: mockUpdateReturning }));
const mockUpdateSet = jest.fn(() => ({ where: mockUpdateWhere }));
const mockUpdate = jest.fn(() => ({ set: mockUpdateSet }));
const mockSelectLimit = jest.fn().mockResolvedValue([]);
const mockSelectOrderBy = jest.fn(() => ({ limit: mockSelectLimit }));
const mockSelectWhere = jest.fn(() => ({ orderBy: mockSelectOrderBy }));
const mockInventoryTable = {
  vendor: "vendor",
  catalog: "catalog",
  updatedAt: "updated_at",
};
const mockInventoryRows: Array<{ vendor: string; catalog: string; updatedAt: Date }> = [];
const mockSelectFrom = jest.fn((table?: unknown) =>
  table === mockInventoryTable
    ? Promise.resolve(mockInventoryRows)
    : { where: mockSelectWhere },
);
const mockSelect = jest.fn(() => ({ from: mockSelectFrom }));
const mockListVerifiedSnapshots = jest.fn();
const mockReadVerifiedSnapshot = jest.fn();
const mockWithSnapshotLock = jest.fn();
const mockCreateSnapshotLocked = jest.fn();
const mockRestoreInventoryRowsLocked = jest.fn();
const mockInvalidateReferenceAnswerCache = jest.fn();
const mockLogger = {
  error: jest.fn(),
  warn: jest.fn(),
};
const mockTxSelectFrom = jest.fn(() => Promise.resolve(mockInventoryRows));
const mockTxSelect = jest.fn(() => ({ from: mockTxSelectFrom }));
const mockRestoreTransaction = {
  execute: mockTxExecute,
  select: mockTxSelect,
};

jest.mock("../lib/inventorySnapshot", () => ({
  runInventoryBackup: mockRunInventoryBackup,
  listVerifiedInventorySnapshots: mockListVerifiedSnapshots,
  withInventorySnapshotLock: mockWithSnapshotLock,
  createInventorySnapshotLocked: mockCreateSnapshotLocked,
}));

jest.mock("@workspace/db", () => ({
  db: {
    insert: mockInsert,
    delete: mockDelete,
    update: mockUpdate,
    select: mockSelect,
    transaction: jest.fn(async (callback: (tx: {
      execute: typeof mockTxExecute;
      insert: typeof mockInsert;
      update: typeof mockUpdate;
      select: typeof mockSelect;
    }) => Promise<unknown>) => callback({
      execute: mockTxExecute,
      insert: mockInsert,
      update: mockUpdate,
      select: mockSelect,
    })),
  },
  inventorySnapshotAuditTable: {
    id: "id",
    action: "action",
    adminClerkUserId: "admin_clerk_user_id",
    snapshotId: "snapshot_id",
    outcome: "outcome",
    createdAt: "created_at",
    finishedAt: "finished_at",
    rowCount: "row_count",
    errorMessage: "error_message",
    leaseExpiresAt: "lease_expires_at",
  },
  inventoryTable: mockInventoryTable,
  referenceAnswerCacheTable: {},
}));

jest.mock("@workspace/api-zod", () => {
  const identitySchema = { parse: (value: unknown) => value };
  return {
    CreateAdminInventorySnapshotResponse: identitySchema,
    DryRunAdminInventorySnapshotRestoreResponse: identitySchema,
    GetAdminInventorySnapshotHealthResponse: identitySchema,
    GetAdminManualInventoryBackupStatusResponse: identitySchema,
    ListAdminInventorySnapshotsResponse: identitySchema,
    ListAdminManualInventoryBackupHistoryResponse: identitySchema,
  };
});

jest.mock("../lib/answerCache", () => ({
  invalidateReferenceAnswerCache: mockInvalidateReferenceAnswerCache,
}));

jest.mock("../lib/inventorySnapshotHealth", () => ({
  inventorySnapshotHealth: jest.fn(),
}));

jest.mock("../lib/inventorySnapshotRestore", () => ({
  restoreInventoryRowsLocked: mockRestoreInventoryRowsLocked,
}));

jest.mock("../lib/inventorySnapshotStorage", () => ({
  readVerifiedSnapshot: mockReadVerifiedSnapshot,
}));

jest.mock("../lib/logger", () => ({
  boundedErrorDiagnostic: jest.fn(),
  logger: { ...mockLogger, info: jest.fn() },
  getLogger: () => ({ error: jest.fn() }),
}));

jest.mock("../middlewares/requireAdminAuth", () => ({
  getAdminClerkUserId: () => "admin-user",
  requireApprovedAdminAuth: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
}));

import {
  getManualInventoryBackupStatus,
  recoverInterruptedManualInventoryBackups,
  startManualInventoryBackup,
} from "../lib/manualInventoryBackup";
import * as manualInventoryBackup from "../lib/manualInventoryBackup";
import adminSnapshotsRouter from "../routes/adminSnapshots";
import { ROUTE_ACCESS_MATRIX } from "../routes/routeAccessMatrix";

const app = express();
app.use(express.json());
app.use("/api/admin", adminSnapshotsRouter);

type BackupResult = {
  manifest: {
    snapshotId: string;
    rowCount: number;
  };
  anomaly: boolean;
  pruned: number;
};

type MockTransaction = {
  execute: typeof mockTxExecute;
  insert: typeof mockInsert;
  update: typeof mockUpdate;
  select: typeof mockSelect;
};

function completedBackup(snapshotId = "snapshot-id", rowCount = 42): BackupResult {
  return {
    manifest: { snapshotId, rowCount },
    anomaly: false,
    pruned: 2,
  };
}

const flushAsyncWork = async (): Promise<void> => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

const RESTORE_SNAPSHOT_ID = "restore-snapshot";
const RESTORE_SNAPSHOT = {
  snapshotId: RESTORE_SNAPSHOT_ID,
  contentSha256: "a".repeat(64),
};
const RESTORABLE_ROW: Record<string, unknown> = {
  id: 1,
  vendor: "ACME",
  catalog: "P-1",
  description: "Electrical part",
  orderPurchase: 0,
  orderQuantity: 0,
  binLocations: [],
  aiKeywords: [],
  pinnedKeywords: [],
  barcodes: [],
};
const originalSessionSecret = process.env.SESSION_SECRET;

describe("manual inventory backup lifecycle", () => {
  beforeEach(() => {
    mockRunInventoryBackup.mockReset();
    mockInsertValues.mockClear();
    mockInsert.mockClear();
    mockUpdateReturning.mockClear();
    mockUpdateWhere.mockClear();
    mockUpdateSet.mockClear();
    mockUpdate.mockClear();
    mockSelectLimit.mockReset();
    mockSelectLimit.mockResolvedValue([]);
    mockTxExecute.mockReset();
    mockTxExecute.mockResolvedValue({ rows: [] });
    const { db } = jest.requireMock("@workspace/db") as { db: { transaction: jest.Mock } };
    db.transaction.mockImplementation(async (callback: (tx: MockTransaction) => Promise<unknown>) => callback({
      execute: mockTxExecute,
      insert: mockInsert,
      update: mockUpdate,
      select: mockSelect,
    }));
  });

  it("keeps both manual backup endpoints in the approved-admin access contract", () => {
    expect(ROUTE_ACCESS_MATRIX).toEqual(
      expect.arrayContaining([
        { method: "POST", path: "/api/admin/snapshots", access: "approved-admin" },
        { method: "GET", path: "/api/admin/snapshots/status", access: "approved-admin" },
      ]),
    );
  });

  it("accepts immediately, suppresses duplicates, and completes independently", async () => {
    let resolveBackup!: (result: BackupResult) => void;
    mockRunInventoryBackup.mockReturnValue(
      new Promise<BackupResult>(resolve => {
        resolveBackup = resolve;
      }),
    );

    const running = await startManualInventoryBackup("clerk-admin-1");
    expect(running.status).toBe("running");
    expect(running.finishedAt).toBeNull();
    expect(mockRunInventoryBackup).toHaveBeenCalledWith("manual-admin");

    const duplicate = await startManualInventoryBackup("clerk-admin-2");
    expect(duplicate).toEqual(running);
    expect(mockRunInventoryBackup).toHaveBeenCalledTimes(1);

    resolveBackup(completedBackup());
    await flushAsyncWork();

    const completed = await getManualInventoryBackupStatus();
    expect(completed?.status).toBe("completed");
    expect(completed?.persistence).toBe("saved");
    expect(completed?.rowCount).toBe(42);
    expect(completed?.snapshotId).toBe("snapshot-id");
    expect(completed?.finishedAt).toEqual(expect.any(String));
    expect(completed?.warning).toBeNull();
    expect(completed).not.toHaveProperty("dataPath");
    expect(completed).not.toHaveProperty("manifestPath");
    expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({
      rowCount: 42,
      outcome: "completed",
    }));
  });

  it("serializes concurrent database claims and starts storage work only once", async () => {
    let resolveBackup!: (result: BackupResult) => void;
    mockRunInventoryBackup.mockReturnValue(
      new Promise<BackupResult>(resolve => {
        resolveBackup = resolve;
      }),
    );
    const remoteRunningRow = {
      id: 93,
      outcome: "running",
      createdAt: new Date("2026-09-23T10:00:00.000Z"),
      finishedAt: null,
      rowCount: null,
      snapshotId: "first-operation",
      errorMessage: null,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    };
    mockSelectLimit
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([remoteRunningRow]);

    const { db } = jest.requireMock("@workspace/db") as { db: { transaction: jest.Mock } };
    let transactionTail = Promise.resolve();
    const tx: MockTransaction = {
      execute: mockTxExecute,
      insert: mockInsert,
      update: mockUpdate,
      select: mockSelect,
    };
    db.transaction.mockImplementation(async (callback: (transaction: MockTransaction) => Promise<unknown>) => {
      const previous = transactionTail;
      let release!: () => void;
      transactionTail = new Promise<void>(resolve => {
        release = resolve;
      });
      await previous;
      try {
        return await callback(tx);
      } finally {
        release();
      }
    });

    const [first, second] = await Promise.all([
      startManualInventoryBackup("clerk-admin-1"),
      startManualInventoryBackup("clerk-admin-2"),
    ]);
    expect(first.status).toBe("running");
    expect(second).toEqual({
      status: "running",
      persistence: "saved",
      startedAt: "2026-09-23T10:00:00.000Z",
      finishedAt: null,
      rowCount: null,
      snapshotId: null,
      error: null,
      warning: null,
    });
    expect(mockRunInventoryBackup).toHaveBeenCalledTimes(1);

    resolveBackup(completedBackup());
    await flushAsyncWork();
  });

  it("returns the existing safe running status when another API instance owns the lease", async () => {
    mockSelectLimit.mockResolvedValueOnce([{
      id: 91,
      outcome: "running",
      createdAt: new Date("2026-09-23T10:00:00.000Z"),
      finishedAt: null,
      rowCount: null,
      snapshotId: "remote-operation",
      errorMessage: null,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    }]);

    await expect(startManualInventoryBackup("clerk-admin-2")).resolves.toEqual({
      status: "running",
      persistence: "saved",
      startedAt: "2026-09-23T10:00:00.000Z",
      finishedAt: null,
      rowCount: null,
      snapshotId: null,
      error: null,
      warning: null,
    });
    expect(mockRunInventoryBackup).not.toHaveBeenCalled();
    expect(mockInsertValues).not.toHaveBeenCalled();
    expect(mockUpdateSet).not.toHaveBeenCalled();

    mockSelectLimit.mockResolvedValueOnce([{
      outcome: "completed",
      createdAt: new Date("2026-09-23T10:00:00.000Z"),
      finishedAt: new Date("2026-09-23T10:01:00.000Z"),
      rowCount: 4,
      snapshotId: "finished-remote-snapshot",
      errorMessage: null,
    }]);
    await expect(getManualInventoryBackupStatus()).resolves.toMatchObject({
      status: "completed",
      snapshotId: "finished-remote-snapshot",
      rowCount: 4,
    });
    expect(mockSelectLimit).toHaveBeenCalledTimes(2);
  });

  it("recovers an expired lease and starts the replacement operation", async () => {
    mockSelectLimit.mockResolvedValueOnce([]).mockResolvedValueOnce([{
      id: 92,
      outcome: "running",
      createdAt: new Date("2026-09-23T10:00:00.000Z"),
      finishedAt: null,
      rowCount: null,
      snapshotId: "expired-operation",
      errorMessage: null,
      leaseExpiresAt: new Date(Date.now() - 60_000),
    }]);
    mockRunInventoryBackup.mockResolvedValueOnce(completedBackup("recovered-id", 8));

    const recovered = await startManualInventoryBackup("clerk-admin-3");
    expect(recovered.status).toBe("running");
    expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "failed",
      errorMessage: "Backup interrupted by an API server restart. Please try again.",
      leaseExpiresAt: null,
      finishedAt: expect.any(Object),
    }));
    expect(mockInsertValues).toHaveBeenCalledWith(expect.objectContaining({
      adminClerkUserId: "clerk-admin-3",
      snapshotId: expect.any(String),
      outcome: "running",
      leaseExpiresAt: expect.any(Object),
    }));

    await flushAsyncWork();
    await expect(getManualInventoryBackupStatus()).resolves.toMatchObject({
      status: "completed",
      snapshotId: "recovered-id",
      rowCount: 8,
    });
  });

  it("does not leave a failed database claim blocking a later retry", async () => {
    const { db } = jest.requireMock("@workspace/db") as { db: { transaction: jest.Mock } };
    db.transaction.mockRejectedValueOnce(new Error("database password /private/path unavailable"));

    await expect(startManualInventoryBackup("clerk-admin-4")).resolves.toMatchObject({
      status: "failed",
      persistence: "unavailable",
      error: "Backup could not be started because its status could not be saved. Please try again.",
      warning: "Backup status could not be saved. The result may not survive an API server restart.",
    });
    expect(mockRunInventoryBackup).not.toHaveBeenCalled();
    expect((await getManualInventoryBackupStatus())?.error).not.toContain("password");

    mockRunInventoryBackup.mockResolvedValueOnce(completedBackup("after-claim-retry", 3));
    await expect(startManualInventoryBackup("clerk-admin-4")).resolves.toMatchObject({ status: "running" });
    await flushAsyncWork();
    await expect(getManualInventoryBackupStatus()).resolves.toMatchObject({
      status: "completed",
      snapshotId: "after-claim-retry",
      rowCount: 3,
    });
  });

  it("records a safe retryable failure and permits a later retry", async () => {
    mockRunInventoryBackup.mockRejectedValueOnce(new Error("private bucket path /objects/private leaked"));
    const failedStart = await startManualInventoryBackup("clerk-admin-1");
    expect(failedStart.status).toBe("running");
    await flushAsyncWork();

    const failed = await getManualInventoryBackupStatus();
    expect(failed?.status).toBe("failed");
    expect(failed?.persistence).toBe("saved");
    expect(failed?.error).toBe("Inventory backup failed. Please try again.");
    expect(failed?.warning).toBeNull();
    expect(failed?.error).not.toContain("objects");

    mockRunInventoryBackup.mockResolvedValueOnce(completedBackup("retry-id", 7));
    const retry = await startManualInventoryBackup("clerk-admin-1");
    expect(retry.status).toBe("running");
    await flushAsyncWork();
    await expect(getManualInventoryBackupStatus()).resolves.toMatchObject({
      status: "completed",
      snapshotId: "retry-id",
      rowCount: 7,
    });
  });

  it("loads the latest terminal status from the database after an API restart", async () => {
    mockSelectLimit.mockResolvedValueOnce([{
      outcome: "completed",
      createdAt: new Date("2026-09-23T10:00:00.000Z"),
      finishedAt: new Date("2026-09-23T10:01:00.000Z"),
      rowCount: 12,
      snapshotId: "persisted-snapshot",
      errorMessage: null,
    }]);

    await expect(getManualInventoryBackupStatus()).resolves.toEqual({
      status: "completed",
      persistence: "saved",
      startedAt: "2026-09-23T10:00:00.000Z",
      finishedAt: "2026-09-23T10:01:00.000Z",
      rowCount: 12,
      snapshotId: "persisted-snapshot",
      error: null,
      warning: null,
    });

    mockSelectLimit.mockResolvedValueOnce([{
      outcome: "failed",
      createdAt: new Date("2026-09-23T11:00:00.000Z"),
      finishedAt: new Date("2026-09-23T11:01:00.000Z"),
      rowCount: null,
      snapshotId: "private-operation-id",
      errorMessage: "private storage path /objects/private must not leak",
    }]);

    await expect(getManualInventoryBackupStatus()).resolves.toMatchObject({
      status: "failed",
      persistence: "saved",
      snapshotId: null,
      error: "Inventory backup failed. Please try again.",
      warning: null,
    });
  });

  it("reports when the start status cannot be saved without exposing the database error", async () => {
    mockInsertValues.mockRejectedValueOnce(new Error("postgres password /private/path leaked"));

    await expect(startManualInventoryBackup("clerk-admin-1")).resolves.toMatchObject({
      status: "failed",
      persistence: "unavailable",
      error: "Backup could not be started because its status could not be saved. Please try again.",
      warning: "Backup status could not be saved. The result may not survive an API server restart.",
    });
    const status = await getManualInventoryBackupStatus();
    expect(status?.error).not.toContain("postgres");
    expect(status?.error).not.toContain("private");

    mockSelectLimit.mockResolvedValueOnce([{
      outcome: "completed",
      createdAt: new Date(Date.now() + 60_000),
      finishedAt: new Date(Date.now() + 61_000),
      rowCount: 2,
      snapshotId: "newer-remote-backup",
      errorMessage: null,
    }]);
    await expect(getManualInventoryBackupStatus()).resolves.toMatchObject({
      status: "completed",
      persistence: "saved",
      snapshotId: "newer-remote-backup",
    });

    mockSelectLimit.mockResolvedValueOnce([{
      outcome: "failed",
      createdAt: new Date("2026-09-23T10:00:00.000Z"),
      finishedAt: new Date(Date.now() + 62_000),
      rowCount: null,
      snapshotId: "reconciled-backup",
      errorMessage: null,
    }]);
    await expect(getManualInventoryBackupStatus()).resolves.toMatchObject({
      status: "failed",
      persistence: "saved",
      error: "Inventory backup failed. Please try again.",
    });
  });

  it("keeps a successful backup visible when completion status cannot be saved", async () => {
    mockRunInventoryBackup.mockResolvedValueOnce(completedBackup("completed-without-status", 9));
    mockUpdateReturning.mockRejectedValueOnce(new Error("database secret /private/storage"));

    await startManualInventoryBackup("clerk-admin-1");
    await flushAsyncWork();

    await expect(getManualInventoryBackupStatus()).resolves.toMatchObject({
      status: "completed",
      persistence: "unavailable",
      rowCount: 9,
      snapshotId: "completed-without-status",
      error: null,
      warning: "Backup status could not be saved. The result may not survive an API server restart.",
    });
  });

  it("keeps a failed backup retryable when failure status cannot be saved", async () => {
    mockRunInventoryBackup.mockRejectedValueOnce(new Error("private bucket credentials"));
    mockUpdateReturning.mockRejectedValueOnce(new Error("database connection secret"));

    await startManualInventoryBackup("clerk-admin-1");
    await flushAsyncWork();

    await expect(getManualInventoryBackupStatus()).resolves.toMatchObject({
      status: "failed",
      persistence: "unavailable",
      error: "Inventory backup failed. Please try again.",
      warning: "Backup status could not be saved. The result may not survive an API server restart.",
    });
  });

  it("marks persisted running work failed instead of reporting it completed", async () => {
    await recoverInterruptedManualInventoryBackups();

    expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "failed",
      errorMessage: "Backup interrupted by an API server restart. Please try again.",
      finishedAt: expect.any(Date),
      leaseExpiresAt: null,
    }));
    expect(mockUpdateWhere).toHaveBeenCalled();
  });

  it("reports an unavailable status when restart recovery cannot be persisted", async () => {
    mockUpdateReturning.mockRejectedValueOnce(new Error("database password /private/path"));

    await recoverInterruptedManualInventoryBackups();

    await expect(getManualInventoryBackupStatus()).resolves.toMatchObject({
      status: "failed",
      persistence: "unavailable",
      error: "Backup interrupted by an API server restart. Please try again.",
      warning: "Backup status could not be saved. The result may not survive an API server restart.",
    });
  });
});

describe("mounted admin snapshot routes", () => {
  let getStatusSpy: jest.SpyInstance;
  let startBackupSpy: jest.SpyInstance;

  beforeAll(() => {
    process.env.SESSION_SECRET = "admin-snapshot-route-test-secret";
  });

  afterAll(() => {
    if (originalSessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = originalSessionSecret;
  });

  beforeEach(() => {
    mockInventoryRows.splice(0, mockInventoryRows.length);
    mockListVerifiedSnapshots.mockReset();
    mockReadVerifiedSnapshot.mockReset();
    mockWithSnapshotLock.mockReset().mockImplementation(
      async (callback: (tx: never) => Promise<unknown>) => callback(mockRestoreTransaction as never),
    );
    mockCreateSnapshotLocked.mockReset().mockResolvedValue(undefined);
    mockRestoreInventoryRowsLocked.mockReset().mockResolvedValue(1);
    mockInvalidateReferenceAnswerCache.mockReset().mockResolvedValue(undefined);
    mockInsertValues.mockClear().mockResolvedValue(undefined);
    mockSelectFrom.mockClear();
    mockTxSelectFrom.mockClear();

    getStatusSpy = jest.spyOn(manualInventoryBackup, "getManualInventoryBackupStatus");
    startBackupSpy = jest.spyOn(manualInventoryBackup, "startManualInventoryBackup");
  });

  afterEach(() => {
    getStatusSpy.mockRestore();
    startBackupSpy.mockRestore();
  });

  it("serves repeated current or latest status reads without starting work or auditing reads", async () => {
    const statuses = [
      {
        status: "running",
        persistence: "saved",
        startedAt: "2026-09-25T10:00:00.000Z",
        finishedAt: null,
        rowCount: null,
        snapshotId: null,
        error: null,
        warning: null,
      },
      {
        status: "completed",
        persistence: "saved",
        startedAt: "2026-09-25T10:00:00.000Z",
        finishedAt: "2026-09-25T10:01:00.000Z",
        rowCount: 42,
        snapshotId: "latest-snapshot",
        error: null,
        warning: null,
      },
      null,
    ];
    getStatusSpy
      .mockResolvedValueOnce(statuses[0])
      .mockResolvedValueOnce(statuses[1])
      .mockResolvedValueOnce(statuses[2]);

    const responses = [];
    for (let index = 0; index < statuses.length; index += 1) {
      responses.push(await supertest(app).get("/api/admin/snapshots/status"));
    }

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(responses.map((response) => response.body)).toEqual(statuses);
    expect(getStatusSpy).toHaveBeenCalledTimes(3);
    expect(startBackupSpy).not.toHaveBeenCalled();
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it("starts a manual backup only through the authorized POST route", async () => {
    const runningStatus = {
      status: "running",
      persistence: "saved",
      startedAt: "2026-09-25T10:00:00.000Z",
      finishedAt: null,
      rowCount: null,
      snapshotId: null,
      error: null,
      warning: null,
    };
    startBackupSpy.mockResolvedValue(runningStatus);

    const response = await supertest(app).post("/api/admin/snapshots");

    expect(response.status).toBe(202);
    expect(response.body).toEqual(runningStatus);
    expect(startBackupSpy).toHaveBeenCalledTimes(1);
    expect(startBackupSpy).toHaveBeenCalledWith("admin-user");
    expect(getStatusSpy).not.toHaveBeenCalled();
  });

  it("creates a bounded dry-run confirmation that the guarded restore accepts", async () => {
    mockListVerifiedSnapshots.mockResolvedValue([RESTORE_SNAPSHOT]);
    mockReadVerifiedSnapshot.mockResolvedValue({ rows: [RESTORABLE_ROW] });
    mockInventoryRows.push({
      vendor: "ACME",
      catalog: "P-1",
      updatedAt: new Date("2026-09-25T09:00:00.000Z"),
    });
    const now = Date.now();

    const dryRun = await supertest(app)
      .post("/api/admin/snapshots/dry-run")
      .send({ snapshotId: RESTORE_SNAPSHOT_ID });

    expect(dryRun.status).toBe(200);
    expect(dryRun.body.snapshotId).toBe(RESTORE_SNAPSHOT_ID);
    expect(dryRun.body.confirmationToken).toMatch(/^\d+\.[0-9a-f]{64}$/);
    const expiresAt = Date.parse(dryRun.body.confirmationExpiresAt);
    expect(Number.isSafeInteger(expiresAt)).toBe(true);
    expect(expiresAt).toBeGreaterThan(now);
    expect(expiresAt).toBeLessThanOrEqual(now + 10 * 60 * 1000 + 1_000);

    const restore = await supertest(app)
      .post("/api/admin/snapshots/restore")
      .send({
        snapshotId: RESTORE_SNAPSHOT_ID,
        confirmationToken: dryRun.body.confirmationToken,
      });

    expect(restore.status).toBe(200);
    expect(restore.body).toEqual({ restored: 1, snapshotId: RESTORE_SNAPSHOT_ID });
    expect(mockCreateSnapshotLocked).toHaveBeenCalledWith(
      mockRestoreTransaction,
      "pre-restore",
    );
    expect(mockRestoreInventoryRowsLocked).toHaveBeenCalledWith(
      mockRestoreTransaction,
      [RESTORABLE_ROW],
    );
    expect(mockInvalidateReferenceAnswerCache).toHaveBeenCalledWith({ throwOnError: true });
  });

  it.each(["audit", "cache", "both"] as const)(
    "reports a committed restore honestly when %s follow-up fails",
    async (failure) => {
      mockListVerifiedSnapshots.mockResolvedValue([RESTORE_SNAPSHOT]);
      mockReadVerifiedSnapshot.mockResolvedValue({ rows: [RESTORABLE_ROW] });
      const dryRun = await supertest(app).post("/api/admin/snapshots/dry-run")
        .send({ snapshotId: RESTORE_SNAPSHOT_ID });
      expect(dryRun.status).toBe(200);
      mockInsertValues.mockClear();
      if (failure === "audit" || failure === "both") {
        mockInsertValues.mockRejectedValueOnce(new Error("private audit database details"));
      }
      if (failure === "cache" || failure === "both") {
        mockInvalidateReferenceAnswerCache.mockRejectedValueOnce(new Error("private cache details"));
      }

      const response = await supertest(app).post("/api/admin/snapshots/restore").send({
        snapshotId: RESTORE_SNAPSHOT_ID,
        confirmationToken: dryRun.body.confirmationToken,
      });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ restored: 1, snapshotId: RESTORE_SNAPSHOT_ID });
      expect(response.body.warnings).toHaveLength(failure === "both" ? 2 : 1);
      expect(JSON.stringify(response.body)).not.toMatch(/private|rolled back|no partial/i);
      expect(mockRestoreInventoryRowsLocked).toHaveBeenCalledTimes(1);
      expect(mockInvalidateReferenceAnswerCache).toHaveBeenCalledWith({ throwOnError: true });
      expect(mockInsertValues).not.toHaveBeenCalledWith(expect.objectContaining({
        action: "restore", outcome: "failed",
      }));
      if (failure === "cache") {
        expect(mockInsertValues).toHaveBeenCalledWith(expect.objectContaining({
          action: "restore", outcome: "completed", rowCount: 1,
        }));
      }
    },
  );

  it("does not assert rollback when the transaction rejects before its commit result is known", async () => {
    mockListVerifiedSnapshots.mockResolvedValue([RESTORE_SNAPSHOT]);
    mockReadVerifiedSnapshot.mockResolvedValue({ rows: [RESTORABLE_ROW] });
    const dryRun = await supertest(app).post("/api/admin/snapshots/dry-run")
      .send({ snapshotId: RESTORE_SNAPSHOT_ID });
    mockWithSnapshotLock.mockRejectedValueOnce(new Error("private transaction failure"));

    const response = await supertest(app).post("/api/admin/snapshots/restore").send({
      snapshotId: RESTORE_SNAPSHOT_ID,
      confirmationToken: dryRun.body.confirmationToken,
    });
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toMatch(/private|rolled back|no partial/i);
    expect(mockInvalidateReferenceAnswerCache).not.toHaveBeenCalled();
  });

  it("makes cache deletion failures observable to the restore while preserving best-effort callers", async () => {
    const { invalidateReferenceAnswerCache } = jest.requireActual("../lib/answerCache") as
      typeof import("../lib/answerCache");
    mockDelete.mockRejectedValue(new Error("cache deletion unavailable"));

    await expect(invalidateReferenceAnswerCache({ throwOnError: true }))
      .rejects.toThrow("cache deletion unavailable");
    await expect(invalidateReferenceAnswerCache()).resolves.toBeUndefined();
    expect(mockDelete).toHaveBeenCalledTimes(2);
  });

  it("returns controlled errors for missing and unknown dry-run snapshot IDs", async () => {
    mockListVerifiedSnapshots.mockResolvedValue([RESTORE_SNAPSHOT]);

    const missing = await supertest(app)
      .post("/api/admin/snapshots/dry-run")
      .send({});
    const unknown = await supertest(app)
      .post("/api/admin/snapshots/dry-run")
      .send({ snapshotId: "unknown-snapshot" });

    expect(missing.status).toBe(400);
    expect(missing.body).toEqual({ error: "A snapshot ID is required" });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ error: "Snapshot not found" });
    expect(mockReadVerifiedSnapshot).not.toHaveBeenCalled();
  });

  it("rejects missing, invalid, expired, and stale restore confirmations", async () => {
    mockListVerifiedSnapshots.mockResolvedValue([RESTORE_SNAPSHOT]);
    mockReadVerifiedSnapshot.mockResolvedValue({ rows: [RESTORABLE_ROW] });

    const missingConfirmation = await supertest(app)
      .post("/api/admin/snapshots/restore")
      .send({ snapshotId: RESTORE_SNAPSHOT_ID });
    const invalidConfirmation = await supertest(app)
      .post("/api/admin/snapshots/restore")
      .send({
        snapshotId: RESTORE_SNAPSHOT_ID,
        confirmationToken: "not-a-confirmation-token",
      });
    expect(missingConfirmation.status).toBe(409);
    expect(invalidConfirmation.status).toBe(409);
    expect(mockWithSnapshotLock).not.toHaveBeenCalled();

    const dryRun = await supertest(app)
      .post("/api/admin/snapshots/dry-run")
      .send({ snapshotId: RESTORE_SNAPSHOT_ID });
    expect(dryRun.status).toBe(200);
    const [, signature] = (dryRun.body.confirmationToken as string).split(".");

    const expired = await supertest(app)
      .post("/api/admin/snapshots/restore")
      .send({
        snapshotId: RESTORE_SNAPSHOT_ID,
        confirmationToken: `${Date.now() - 1}.${signature}`,
      });
    expect(expired.status).toBe(409);
    expect(mockRestoreInventoryRowsLocked).not.toHaveBeenCalled();

    mockInventoryRows.push({
      vendor: "ACME",
      catalog: "P-1",
      updatedAt: new Date("2026-09-25T09:00:00.000Z"),
    });
    const freshDryRun = await supertest(app)
      .post("/api/admin/snapshots/dry-run")
      .send({ snapshotId: RESTORE_SNAPSHOT_ID });
    expect(freshDryRun.status).toBe(200);
    mockInventoryRows[0]!.updatedAt = new Date("2026-09-25T09:05:00.000Z");

    const stale = await supertest(app)
      .post("/api/admin/snapshots/restore")
      .send({
        snapshotId: RESTORE_SNAPSHOT_ID,
        confirmationToken: freshDryRun.body.confirmationToken,
      });

    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({
      error: "Inventory changed since the dry run; run a new preview",
    });
    expect(mockCreateSnapshotLocked).not.toHaveBeenCalled();
    expect(mockRestoreInventoryRowsLocked).not.toHaveBeenCalled();
    expect(mockInvalidateReferenceAnswerCache).not.toHaveBeenCalled();
    expect(mockInsertValues).not.toHaveBeenCalledWith(expect.objectContaining({
      action: "restore", outcome: "completed",
    }));
    expect(mockInsertValues).not.toHaveBeenCalledWith(expect.objectContaining({
      action: "restore", outcome: "failed",
    }));
  });
});
