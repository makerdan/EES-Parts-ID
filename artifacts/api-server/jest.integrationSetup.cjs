/**
 * Jest setupFilesAfterEnv — runs after the test framework is installed for
 * every test file in the api-server suite.
 *
 * Integration tests (matching *.integration.test.ts) get a 20s timeout
 * instead of the 10s baseline.  Unit/mock tests keep the 10s default.
 *
 * Pool teardown: a global afterAll closes the shared pg pool after every test
 * file, regardless of whether the file explicitly imports closePool().  The
 * guard flag in testDb.ts makes repeated calls idempotent — files that already
 * call closePool() in their own afterAll are unaffected.  This prevents Jest
 * from printing "Force exiting Jest" due to lingering pool connections.
 */

const path = require("path");

const currentTestPath = expect.getState().testPath || "";
const isIntegration = /\.integration\.test\.[jt]sx?$/.test(
  path.basename(currentTestPath)
);

if (isIntegration) {
  jest.setTimeout(20_000);
}

afterAll(async () => {
  // Jest's module resolver honours moduleNameMapper and the ts-jest transform
  // even for require() calls made inside setupFilesAfterEnv files, so
  // requiring the TypeScript testDb helper works here.
  //
  // closePool() is idempotent (guarded by _poolEnded flag) so calling it here
  // is always safe: test files that already called it get a no-op, and test
  // files that never imported testDb get the pool closed for the first time.
  // pg's Pool.end() with no active connections resolves immediately, so this
  // is also safe in pure-unit tests where no queries were ever made.
  const { closePool } = require("./__tests__/helpers/testDb");
  await closePool();
});
