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
  mockProbePoeBotsOnStartup.mockResolvedValue(undefined);
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
    mockStartServer.mockImplementationOnce(() => resolveStart());

    loadIndex();
    await startGate;

    expect(mockStartServer).toHaveBeenCalledTimes(1);
  });

  it("does not call startServer() until initProvider() has resolved", async () => {
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
    mockStartServer.mockImplementationOnce(() => resolveStart());

    loadIndex();

    // Wait until initProvider() has actually been invoked, then verify
    // startServer() has not yet been called — the chain is still suspended on
    // initGate, so this assertion cannot be a false-pass regardless of how
    // many intermediate awaits index.ts has before or after initProvider().
    await initCalledGate;
    expect(mockStartServer).not.toHaveBeenCalled();

    // Release the gate — wait until startServer actually fires rather than
    // relying on a fixed flush count.
    resolveInit();
    await startGate;
    expect(mockStartServer).toHaveBeenCalledTimes(1);
  });
});
