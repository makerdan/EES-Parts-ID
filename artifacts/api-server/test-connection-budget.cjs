/**
 * Shared API Jest connection budget.
 *
 * Keep this in CommonJS because Jest's configuration is CommonJS while the
 * database package is TypeScript/ESM. The contract test imports the same
 * values used by jest.config.cjs so worker-limit drift fails deterministically.
 */
module.exports = Object.freeze({
  parallelMaxWorkers: 2,
  dbSerialMaxWorkers: 1,
  poolMaxPerWorker: 2,
  globalSetupMaxConnections: 1,
  developmentServiceReservedConnections: 10,
  testConnectionBudget: 6,
  totalClientCeiling: 17,
});