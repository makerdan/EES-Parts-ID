/**
 * Jest setupFilesAfterEnv — runs after the test framework is installed for
 * every test file in the api-server suite.
 *
 * Integration tests (matching *.integration.test.ts) get a 20s timeout
 * instead of the 10s baseline.  Unit/mock tests keep the 10s default.
 */

const path = require("path");

const currentTestPath = expect.getState().testPath || "";
const isIntegration = /\.integration\.test\.[jt]sx?$/.test(
  path.basename(currentTestPath)
);

if (isIntegration) {
  jest.setTimeout(20_000);
}
