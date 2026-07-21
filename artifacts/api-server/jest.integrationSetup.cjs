/**
 * Jest setupFilesAfterEnv — runs after the test framework is installed for
 * every test file in the api-server suite.
 *
 * Integration tests (matching *.integration.test.ts) get a 20s timeout
 * instead of the 10s baseline.  Unit/mock tests keep the 10s default.
 *
 * Pool teardown: none needed here. The shared pg pool in @workspace/db is
 * created with `allowExitOnIdle: true` whenever JEST_WORKER_ID is set, so the
 * worker process can exit once connections go idle without an explicit
 * pool.end(). A previous version of this file registered a global afterAll
 * that called closePool(), but setupFilesAfterEnv afterAll hooks run BEFORE
 * the test file's own afterAll hooks — so per-suite DB cleanup (e.g.
 * cleanupFixtures()) ran against an already-ended pool and failed the suite.
 * Do not re-add a global closePool() here.
 */

const path = require("path");

const currentTestPath = expect.getState().testPath || "";
const isIntegration = /\.integration\.test\.[jt]sx?$/.test(
  path.basename(currentTestPath)
);

if (isIntegration) {
  jest.setTimeout(20_000);
}

// Rate limits: the sliding-window limiter persists state in the shared dev
// database (rate_limit_buckets), so the default per-minute caps (e.g. 5
// catalog-pdf uploads/min per admin) are exhausted almost immediately when a
// dozen catalog-pdf suites run in parallel as the same bootstrap admin — and
// leftover rows even bleed into the NEXT test run. Raise the caps for suites
// unless a test explicitly set its own value. The estimate-dimensions limiter
// (ESTIMATE_SEARCH_RATE_LIMIT) is deliberately left alone — its dedicated
// test exercises real limit behaviour with per-run unique keys.
process.env.RATE_LIMIT_CATALOG_PDF_UPLOAD_PER_MIN ??= "100000";
process.env.RATE_LIMIT_IDENTIFY_PER_MIN ??= "100000";
process.env.RATE_LIMIT_TRANSLATE_PER_MIN ??= "100000";
process.env.RATE_LIMIT_PART_CARD_PER_MIN ??= "100000";
process.env.RATE_LIMIT_REFERENCE_ASK_PER_MIN ??= "100000";
process.env.RATE_LIMIT_INVENTORY_SEARCH_PER_MIN ??= "100000";
process.env.RATE_LIMIT_ADMIN_QUERY_PER_MIN ??= "100000";
// The catalog-pdf background-processing suite deliberately hangs several
// background jobs (never-resolving extract mocks). Each hung job holds an
// in-process concurrency slot forever, so the default cap of 3 concurrent
// PDF jobs starts returning 429 mid-suite. Raise it for tests.
process.env.MAX_CONCURRENT_PDF_JOBS ??= "100000";
