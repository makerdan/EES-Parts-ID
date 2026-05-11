/** @type {import('jest').Config} */
const base = require('./jest.config.cjs');

module.exports = {
  ...base,
  // Run ONLY smoke tests. The base config excludes *.smoke.test.ts via
  // testPathIgnorePatterns; this config overrides that exclusion by
  // narrowing testMatch to only smoke files instead.
  testMatch: ['**/__tests__/**/*.smoke.test.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
};
