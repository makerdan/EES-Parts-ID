import {
  DEFAULT_POOL_MAX,
  getPoolMax,
  JEST_POOL_MAX,
} from "@workspace/db";

// The CommonJS budget is intentionally the source of truth for project worker
// limits. Requiring it here keeps this contract tied to the values Jest uses,
// rather than duplicating worker settings in a test-only constant.
const testConnectionBudget = require("../../test-connection-budget.cjs") as {
  parallelMaxWorkers: number;
  dbSerialMaxWorkers: number;
  poolMaxPerWorker: number;
  globalSetupMaxConnections: number;
  developmentServiceReservedConnections: number;
  testConnectionBudget: number;
  totalClientCeiling: number;
};

describe("API Jest database connection budget", () => {
  it("keeps the test pool smaller while preserving the application default", () => {
    expect(getPoolMax(true)).toBe(JEST_POOL_MAX);
    expect(JEST_POOL_MAX).toBe(2);
    expect(getPoolMax(false)).toBe(DEFAULT_POOL_MAX);
    expect(DEFAULT_POOL_MAX).toBe(10);
    expect(JEST_POOL_MAX).toBeLessThan(DEFAULT_POOL_MAX);
  });

  it("bounds both Jest projects within the documented shared-database ceiling", () => {
    const workerCount =
      testConnectionBudget.parallelMaxWorkers +
      testConnectionBudget.dbSerialMaxWorkers;
    const testConnections =
      workerCount * testConnectionBudget.poolMaxPerWorker;

    expect(testConnectionBudget.parallelMaxWorkers).toBe(2);
    expect(testConnectionBudget.dbSerialMaxWorkers).toBe(1);
    expect(testConnectionBudget.poolMaxPerWorker).toBe(JEST_POOL_MAX);
    expect(testConnections).toBe(testConnectionBudget.testConnectionBudget);
    expect(testConnectionBudget.testConnectionBudget).toBe(6);
    expect(testConnectionBudget.totalClientCeiling).toBe(
      testConnections +
        testConnectionBudget.globalSetupMaxConnections +
        testConnectionBudget.developmentServiceReservedConnections,
    );
    expect(testConnectionBudget.totalClientCeiling).toBe(17);
  });

  it("keeps at least two clients available for concurrent-request coverage", () => {
    expect(testConnectionBudget.poolMaxPerWorker).toBeGreaterThanOrEqual(2);
  });
});