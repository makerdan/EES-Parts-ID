/** @type {import('jest').Config} */
const base = require('./jest.config.cjs');

module.exports = {
  ...base,
  // Exclude live-server integration tests and heavy PDF smoke tests so this
  // config runs offline without a PostgreSQL connection and without loading
  // multi-megabyte catalog PDFs. Parts-id and api-client-react tests are
  // unaffected — they live in separate packages and always run in full.
  // Smoke tests are covered by pnpm test (full suite) and Task #442 will
  // add an explicit test:smoke script for targeted runs.
  testPathIgnorePatterns: [
    ...(base.testPathIgnorePatterns ?? ['/node_modules/']),
    '\\.integration\\.test\\.ts$',
    '\\.smoke\\.test\\.ts$',
  ],
};
