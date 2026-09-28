/**
 * Tests for the server startup sequence in src/index.ts.
 *
 * Verifies that initProvider() is fully awaited before startServer() is
 * called, so the admin-persisted AI provider is always applied before the
 * first request can be served — even on a cold boot.
 *
 * Key technique: a deferred-promise gate.  We make initProvider() return a
 * Promise that we control, flush all pending microtasks, assert startServer()
 * has NOT been called (proving the await actually blocks), then resolve the
 * gate and assert startServer() fires.
 *
 * Uses the same mock-db fluent-chain pattern as aiProvider.test.ts.
 */

// ── PORT env var (must be set before index.ts is required) ───────────────────
const _origPort = process.env.PORT;
process.env.PORT = "3001";

afterAll(() => {
  if (_origPort === undefined) {
    delete process.env.PORT;
  } else {
    process.env.PORT = _origPort;
  }
});

// ── Logger mock ───────────────────────────────────────────────────────────────
const mockLoggerError = jest.fn();
const mockBoundedErrorDiagnostic = jest.fn((error: unknown) => ({
  message: error instanceof Error ? error.message : String(error),
}));
jest.mock("../src/lib/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: mockLoggerError,
    debug: jest.fn(),
  },
  boundedErrorDiagnostic: mockBoundedErrorDiagnostic,
}));

// ── Express app mock ──────────────────────────────────────────────────────────
jest.mock("../src/app", () => ({}));

// ── startServer mock ──────────────────────────────────────────────────────────
const mockStartServer = jest.fn();
jest.mock("../src/lib/startServer", () => ({
  startServer: mockStartServer,
  MAX_RETRIES: 10,
}));

// ── aiProvider mock ───────────────────────────────────────────────────────────
const mockInitProvider = jest.fn();

const mockProbeActivePoeModels = jest.fn();
jest.mock("../src/lib/aiProvider", () => ({
  initProvider: mockInitProvider,
  probeActivePoeModels: mockProbeActivePoeModels,
}));

const mockRecoverCatalogPdfUploadSessions = jest.fn();
jest.mock("../src/routes/catalogPdfUpload", () => ({
  recoverCatalogPdfUploadSessions: mockRecoverCatalogPdfUploadSessions,
}));

// ── readiness mock ────────────────────────────────────────────────────────────
const mockCheckRequiredSchema = jest.fn();
const mockStartupSchemaMaxAttempts = 5;
const mockStartupSchemaProbeTimeoutMs = 4_000;
const mockStartupSchemaRetryDelayMs = 100;
type MockStartupStatus = "pending" | "timed_out";
const mockAppReadiness = {
  get: jest.fn((): { status: MockStartupStatus } => ({ status: "pending" })),
  reset: jest.fn(),
  markReady: jest.fn(),
  markTimedOut: jest.fn(),
  markFailed: jest.fn(),
};
jest.mock("../src/lib/readiness", () => ({
  appReadiness: mockAppReadiness,
  checkRequiredSchema: mockCheckRequiredSchema,
  STARTUP_MIGRATIONS_TIMEOUT_MS: 25_000,
  STARTUP_SCHEMA_MAX_ATTEMPTS: mockStartupSchemaMaxAttempts,
  STARTUP_SCHEMA_PROBE_TIMEOUT_MS: mockStartupSchemaProbeTimeoutMs,
  STARTUP_SCHEMA_RETRY_DELAY_MS: mockStartupSchemaRetryDelayMs,
}));

// ── @workspace/db mock (fluent-chain pattern from aiProvider.test.ts) ─────────
const mockReturning = jest.fn().mockResolvedValue([]);
const mockUpdateWhere = jest.fn(() => ({ returning: mockReturning }));
const mockSet = jest.fn(() => ({ where: mockUpdateWhere }));
const mockUpdate = jest.fn(() => ({ set: mockSet }));
const mockExecute = jest.fn().mockResolvedValue({ rows: [{ usable: true }] });
const mockPoolRelease = jest.fn();
const mockPoolConnect = jest.fn();
const mockSelectWhere = jest.fn().mockResolvedValue([]);
const mockSelectFrom = jest.fn(() => ({
  where: mockSelectWhere,
  innerJoin: jest.fn(() => ({ where: mockSelectWhere })),
}));
const mockSelect = jest.fn(() => ({ from: mockSelectFrom }));

jest.mock("@workspace/db", () => ({
  db: {
    update: mockUpdate,
    execute: mockExecute,
    select: mockSelect,
  },
  pool: {
    connect: mockPoolConnect,
  },
  catalogPdfJobTable: {
    status: "status_col",
    id: "id_col",
    errorMessage: "err_col",
    finishedAt: "finished_col",
  },
  catalogPdfUploadSessionTable: {
    id: "upload_session_id_col",
    status: "upload_session_status_col",
    expiresAt: "upload_session_expires_col",
    processingJobId: "upload_session_job_id_col",
    vendor: "upload_session_vendor_col",
  },
  catalogPdfUploadPartTable: {
    sessionId: "upload_part_session_id_col",
    partIndex: "upload_part_index_col",
  },
  warehouseZoneTable: { id: "id_col", sectionNum: "section_col" },
  adminPreferencesTable: { id: "id_col", aiProvider: "ai_provider_col" },
}));

// ── drizzle-orm mock ──────────────────────────────────────────────────────────
jest.mock("drizzle-orm", () => ({
  and: jest.fn(),
  eq: jest.fn(),
  inArray: jest.fn(),
  isNull: jest.fn(),
  lt: jest.fn(),
  lte: jest.fn(),
  or: jest.fn(),
  sql: jest.fn(),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a deferred promise pair.  The caller controls when the returned
 * promise resolves; pass `promise` as the mock return value and call
 * `resolve()` in the test body to release downstream awaits.
 */
function makeGate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Load a fresh copy of src/index.ts without polluting the outer module
 * registry.  jest.isolateModules is synchronous; the async startup chain
 * it kicks off runs in the background.
 */
function loadIndex(): void {
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("../src/index");
  });
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  // Default: both helpers resolve immediately (overridden per-test as needed)
  mockInitProvider.mockResolvedValue(undefined);
  mockProbeActivePoeModels.mockResolvedValue(undefined);
  mockRecoverCatalogPdfUploadSessions.mockResolvedValue(undefined);
  mockCheckRequiredSchema.mockResolvedValue(true);
  mockAppReadiness.get.mockReturnValue({ status: "pending" });
  mockPoolConnect.mockResolvedValue({ release: mockPoolRelease });
  mockStartServer.mockResolvedValue({
    close: (callback: () => void) => callback(),
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("server startup sequence (src/index.ts)", () => {
  it("calls initProvider() during startup", async () => {
    // The mock triggers the gate on invocation but still resolves immediately,
    // so the startup chain is never blocked.  Awaiting the gate means we know
    // initProvider() has fired regardless of how many extra `await` hops
    // index.ts has before reaching that call.
    const { promise: initGate, resolve: resolveInit } = makeGate();
    mockInitProvider.mockImplementationOnce(() => {
      resolveInit();
      return Promise.resolve();
    });

    loadIndex();
    await initGate;

    expect(mockInitProvider).toHaveBeenCalledTimes(1);
  });

  it("calls startServer() during startup", async () => {
    // Gate on startServer itself so the assertion does not depend on
    // microtask-queue depth — we simply wait until the callback fires.
    const { promise: startGate, resolve: resolveStart } = makeGate();
    mockStartServer.mockImplementationOnce(() => {
      resolveStart();
      return Promise.resolve({ close: (callback: () => void) => callback() });
    });

    loadIndex();
    await startGate;

    expect(mockStartServer).toHaveBeenCalledTimes(1);
  });

  it("does not start explicit Poe probes during startup", async () => {
    loadIndex();
    await Promise.resolve();
    expect(mockProbeActivePoeModels).not.toHaveBeenCalled();
  });

  it("opens the listener without waiting for optional provider initialization", async () => {
    // Hold initProvider() in a pending state that we control.
    const { promise: initGate, resolve: resolveInit } = makeGate();
    // A separate gate that fires the instant initProvider() is invoked.
    // This replaces the setImmediate-based flushPromises() baseline: we wait
    // until the startup chain has actually reached initProvider(), which is
    // robust to any number of extra `await` hops added before that call.
    const { promise: initCalledGate, resolve: resolveInitCalled } = makeGate();
    mockInitProvider.mockImplementationOnce(() => {
      resolveInitCalled(); // signal: initProvider() has been invoked
      return initGate;     // but keep the startup chain suspended
    });

    // Gate on startServer so the "has fired" assertion is not microtask-depth
    // sensitive even if index.ts gains extra awaits between the two calls.
    const { promise: startGate, resolve: resolveStart } = makeGate();
    mockStartServer.mockImplementationOnce(() => {
      resolveStart();
      return Promise.resolve({ close: (callback: () => void) => callback() });
    });

    loadIndex();

    // The listener is intentionally independent from optional provider setup.
    await initCalledGate;
    expect(mockStartServer).toHaveBeenCalledTimes(1);

    // Release the gate — wait until startServer actually fires rather than
    // relying on a fixed flush count.
    resolveInit();
    await startGate;
    expect(mockStartServer).toHaveBeenCalledTimes(1);
  });

  it("keeps readiness failed after bounded retries when required schema stays unavailable", async () => {
    jest.useFakeTimers();
    try {
      const { promise: failedGate, resolve: resolveFailed } = makeGate();
      const { promise: probeStarted, resolve: resolveProbeStarted } = makeGate();
      mockCheckRequiredSchema.mockImplementation(() => {
        resolveProbeStarted();
        return Promise.resolve(false);
      });
      mockAppReadiness.markFailed.mockImplementationOnce(resolveFailed);

      loadIndex();
      await probeStarted;
      await jest.advanceTimersByTimeAsync(
        mockStartupSchemaRetryDelayMs * (mockStartupSchemaMaxAttempts - 1),
      );
      await failedGate;

      expect(mockCheckRequiredSchema).toHaveBeenCalledTimes(
        mockStartupSchemaMaxAttempts,
      );
      expect(mockAppReadiness.markFailed).toHaveBeenCalledTimes(1);
      expect(mockAppReadiness.markReady).not.toHaveBeenCalled();
      expect(mockLoggerError).toHaveBeenCalledWith(
        {
          err: new Error("Required application schema is unavailable"),
        },
        "Required startup initialization failed",
      );
      expect(JSON.stringify(mockLoggerError.mock.calls)).not.toMatch(
        /inventory|users|admin_preferences|warehouse_zone|to_regclass/i,
      );
      expect(mockStartServer).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("cancels pending schema probes and releases each acquired client", async () => {
    jest.useFakeTimers();
    try {
      const { promise: failedGate, resolve: resolveFailed } = makeGate();
      const { promise: probeStarted, resolve: resolveProbeStarted } = makeGate();
      mockCheckRequiredSchema.mockImplementation(() => {
        resolveProbeStarted();
        return new Promise<boolean>(() => undefined);
      });
      mockAppReadiness.markFailed.mockImplementationOnce(resolveFailed);

      loadIndex();
      await probeStarted;

      for (
        let attempt = 0;
        attempt < mockStartupSchemaMaxAttempts;
        attempt += 1
      ) {
        await jest.advanceTimersByTimeAsync(
          mockStartupSchemaProbeTimeoutMs,
        );
        if (attempt < mockStartupSchemaMaxAttempts - 1) {
          await jest.advanceTimersByTimeAsync(mockStartupSchemaRetryDelayMs);
        }
      }

      await failedGate;
      expect(mockCheckRequiredSchema).toHaveBeenCalledTimes(
        mockStartupSchemaMaxAttempts,
      );
      expect(mockPoolRelease).toHaveBeenCalledTimes(
        mockStartupSchemaMaxAttempts,
      );
      expect(mockPoolRelease).toHaveBeenCalledWith(expect.any(Error));
      expect(mockAppReadiness.markReady).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it("recovers readiness within five seconds after a timed-out schema outage", async () => {
    jest.useFakeTimers();
    try {
      const { promise: outageProbeStarted, resolve: resolveOutageProbeStarted } =
        makeGate();
      const {
        promise: recoveryProbeStarted,
        resolve: resolveRecoveryProbeStarted,
      } = makeGate();
      let probeCount = 0;
      mockCheckRequiredSchema.mockImplementation(() => {
        probeCount += 1;
        if (probeCount === 1) {
          resolveOutageProbeStarted();
          return new Promise<boolean>(() => undefined);
        }
        resolveRecoveryProbeStarted();
        return Promise.resolve(true);
      });

      loadIndex();
      await outageProbeStarted;

      const recoveryBudgetMs = mockStartupSchemaProbeTimeoutMs +
        mockStartupSchemaRetryDelayMs;
      expect(recoveryBudgetMs).toBeLessThan(5_000);
      await jest.advanceTimersByTimeAsync(recoveryBudgetMs);
      await recoveryProbeStarted;
      await jest.advanceTimersByTimeAsync(1);

      expect(mockCheckRequiredSchema).toHaveBeenCalledTimes(2);
      expect(mockPoolRelease).toHaveBeenNthCalledWith(1, expect.any(Error));
      expect(mockPoolRelease).toHaveBeenNthCalledWith(2, undefined);
      expect(mockAppReadiness.markFailed).not.toHaveBeenCalled();
      expect(mockAppReadiness.markReady).toHaveBeenCalledTimes(1);
      expect(mockStartServer).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not mark readiness ready when startup finishes after the readiness deadline", async () => {
    const { promise: schemaGate, resolve: resolveSchema } = makeGate();
    const { promise: probeStarted, resolve: resolveProbeStarted } = makeGate();
    let readinessStatus: "pending" | "timed_out" = "pending";
    mockAppReadiness.get.mockImplementation(() => ({ status: readinessStatus }));
    mockAppReadiness.markTimedOut.mockImplementation(() => {
      readinessStatus = "timed_out";
    });
    mockCheckRequiredSchema.mockImplementation(() => {
      resolveProbeStarted();
      return schemaGate.then(() => true);
    });

    loadIndex();
    await probeStarted;
    mockAppReadiness.markTimedOut();
    resolveSchema();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mockAppReadiness.markReady).not.toHaveBeenCalled();
  });
});
