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
process.env.PORT = "3001";

// ── Logger mock ───────────────────────────────────────────────────────────────
jest.mock("../src/lib/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
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
const mockProbePoeBotsOnStartup = jest.fn();
jest.mock("../src/lib/aiProvider", () => ({
  initProvider: mockInitProvider,
  probePoeBotsOnStartup: mockProbePoeBotsOnStartup,
}));

// ── @workspace/db mock (fluent-chain pattern from aiProvider.test.ts) ─────────
const mockReturning = jest.fn().mockResolvedValue([]);
const mockUpdateWhere = jest.fn(() => ({ returning: mockReturning }));
const mockSet = jest.fn(() => ({ where: mockUpdateWhere }));
const mockUpdate = jest.fn(() => ({ set: mockSet }));
const mockExecute = jest.fn().mockResolvedValue(undefined);
const mockSelectWhere = jest.fn().mockResolvedValue([]);
const mockSelectFrom = jest.fn(() => ({ where: mockSelectWhere }));
const mockSelect = jest.fn(() => ({ from: mockSelectFrom }));

jest.mock("@workspace/db", () => ({
  db: {
    update: mockUpdate,
    execute: mockExecute,
    select: mockSelect,
  },
  catalogPdfJobTable: {
    status: "status_col",
    id: "id_col",
    errorMessage: "err_col",
    finishedAt: "finished_col",
  },
  warehouseZoneTable: { id: "id_col", sectionNum: "section_col" },
  adminPreferencesTable: { id: "id_col", aiProvider: "ai_provider_col" },
}));

// ── drizzle-orm mock ──────────────────────────────────────────────────────────
jest.mock("drizzle-orm", () => ({
  eq: jest.fn(),
  inArray: jest.fn(),
  sql: jest.fn(),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Drain the entire microtask + I/O queue (setImmediate fires after all Promises). */
const flushPromises = (): Promise<void> =>
  new Promise<void>((resolve) => setImmediate(resolve));

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
  mockProbePoeBotsOnStartup.mockResolvedValue(undefined);
});

// ─────────────────────────────────────────────────────────────────────────────

describe("server startup sequence (src/index.ts)", () => {
  it("calls initProvider() during startup", async () => {
    loadIndex();
    await flushPromises();

    expect(mockInitProvider).toHaveBeenCalledTimes(1);
  });

  it("calls startServer() during startup", async () => {
    loadIndex();
    await flushPromises();

    expect(mockStartServer).toHaveBeenCalledTimes(1);
  });

  it("does not call startServer() until initProvider() has resolved", async () => {
    // Hold initProvider() in a pending state that we control.
    let resolveInit!: () => void;
    const initGate = new Promise<void>((resolve) => {
      resolveInit = resolve;
    });
    mockInitProvider.mockReturnValueOnce(initGate);

    loadIndex();

    // Flush: Promise.all() resolves, initProvider() fires, but initGate is
    // still pending so the chain is suspended.  startServer must not fire yet.
    await flushPromises();
    expect(mockStartServer).not.toHaveBeenCalled();

    // Release the gate — the remaining .then() callbacks become microtasks.
    resolveInit();

    // Flush again to drain probePoeBotsOnStartup and the final startServer call.
    await flushPromises();
    expect(mockStartServer).toHaveBeenCalledTimes(1);
  });
});
