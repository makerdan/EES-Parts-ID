import express from "express";
import supertest from "supertest";

const mockListVerifiedInventorySnapshots = jest.fn();
const mockReadVerifiedSnapshot = jest.fn();
const mockGetManualInventoryBackupStatus = jest.fn();
const mockStartManualInventoryBackup = jest.fn();
const mockSelectFrom = jest.fn();
const mockSelect = jest.fn(() => ({ from: mockSelectFrom }));
const mockInsertValues = jest.fn().mockResolvedValue(undefined);
const mockInsert = jest.fn(() => ({ values: mockInsertValues }));

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

jest.mock("@workspace/db", () => ({
  db: {
    select: mockSelect,
    insert: mockInsert,
  },
  inventorySnapshotAuditTable: {},
  inventoryTable: {
    vendor: "vendor",
    catalog: "catalog",
    updatedAt: "updated_at",
  },
}));

jest.mock("../lib/answerCache", () => ({
  invalidateReferenceAnswerCache: jest.fn(),
}));

jest.mock("../lib/inventorySnapshot", () => ({
  createInventorySnapshotLocked: jest.fn(),
  listVerifiedInventorySnapshots: mockListVerifiedInventorySnapshots,
  withInventorySnapshotLock: jest.fn(),
}));

jest.mock("../lib/inventorySnapshotHealth", () => ({
  inventorySnapshotHealth: jest.fn(),
}));

jest.mock("../lib/inventorySnapshotRestore", () => ({
  restoreInventoryRowsLocked: jest.fn(),
}));

jest.mock("../lib/inventorySnapshotStorage", () => ({
  readVerifiedSnapshot: mockReadVerifiedSnapshot,
}));

jest.mock("../lib/logger", () => ({
  boundedErrorDiagnostic: jest.fn(),
  getLogger: () => ({ error: jest.fn() }),
}));

jest.mock("../lib/manualInventoryBackup", () => ({
  getManualInventoryBackupStatus: mockGetManualInventoryBackupStatus,
  startManualInventoryBackup: mockStartManualInventoryBackup,
}));

jest.mock("../middlewares/requireAdminAuth", () => ({
  getAdminClerkUserId: () => "admin-user",
  requireApprovedAdminAuth: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
}));

import adminSnapshotsRouter from "../routes/adminSnapshots";

const app = express();
app.use(express.json());
app.use("/api/admin", adminSnapshotsRouter);

describe("admin snapshot route bindings", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInsertValues.mockResolvedValue(undefined);
  });

  it("uses the requested snapshot and creates a future dry-run expiry", async () => {
    const now = Date.now();
    mockListVerifiedInventorySnapshots.mockResolvedValue([
      {
        snapshotId: "requested-snapshot",
        contentSha256: "checksum",
      },
      {
        snapshotId: "other-snapshot",
        contentSha256: "other-checksum",
      },
    ]);
    mockReadVerifiedSnapshot.mockResolvedValue({
      rows: [{ vendor: "ACME", catalog: "P-1" }],
    });
    mockSelectFrom.mockResolvedValue([]);

    const response = await supertest(app)
      .post("/api/admin/snapshots/dry-run")
      .send({ snapshotId: "requested-snapshot" });

    expect(response.status).toBe(200);
    expect(mockReadVerifiedSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotId: "requested-snapshot" }),
    );
    expect(Date.parse(response.body.confirmationExpiresAt)).toBeGreaterThan(now);
    expect(Date.parse(response.body.confirmationExpiresAt)).toBeLessThanOrEqual(
      now + 10 * 60 * 1000 + 1_000,
    );
  });

  it("keeps missing input, absent snapshots, and operational dry-run failures distinct", async () => {
    const missing = await supertest(app).post("/api/admin/snapshots/dry-run").send({ snapshotId: 42 });
    const blank = await supertest(app).post("/api/admin/snapshots/dry-run").send({ snapshotId: "  " });
    expect(missing.status).toBe(400);
    expect(blank.status).toBe(400);
    expect(mockListVerifiedInventorySnapshots).not.toHaveBeenCalled();

    mockListVerifiedInventorySnapshots.mockResolvedValue([]);
    const absent = await supertest(app).post("/api/admin/snapshots/dry-run").send({ snapshotId: "missing" });
    expect(absent.status).toBe(404);

    mockListVerifiedInventorySnapshots.mockResolvedValue([{ snapshotId: "exists", contentSha256: "hash" }]);
    mockReadVerifiedSnapshot.mockRejectedValueOnce(new Error("private storage location"));
    const storage = await supertest(app).post("/api/admin/snapshots/dry-run").send({ snapshotId: "exists" });
    expect(storage.status).toBe(500);
    expect(JSON.stringify(storage.body)).not.toContain("private");
    expect(mockInsertValues).not.toHaveBeenCalled();

    mockReadVerifiedSnapshot.mockResolvedValue({ rows: [] });
    mockSelectFrom.mockRejectedValueOnce(new Error("database password"));
    const database = await supertest(app).post("/api/admin/snapshots/dry-run").send({ snapshotId: "exists" });
    expect(database.status).toBe(500);
    expect(JSON.stringify(database.body)).not.toContain("password");
    expect(mockInsertValues).not.toHaveBeenCalled();

    mockSelectFrom.mockResolvedValue([]);
    mockInsertValues.mockRejectedValueOnce(new Error("audit database password"));
    const audit = await supertest(app).post("/api/admin/snapshots/dry-run").send({ snapshotId: "exists" });
    expect(audit.status).toBe(500);
    expect(JSON.stringify(audit.body)).not.toContain("password");
  });

  it("reads current status without starting another backup", async () => {
    mockGetManualInventoryBackupStatus.mockResolvedValue({
      status: "idle",
      persistence: "available",
      error: null,
      warning: null,
    });

    const response = await supertest(app).get("/api/admin/snapshots/status");

    expect(response.status).toBe(200);
    expect(mockGetManualInventoryBackupStatus).toHaveBeenCalledTimes(1);
    expect(mockStartManualInventoryBackup).not.toHaveBeenCalled();
    expect(response.body).toMatchObject({ status: "idle" });
  });
});