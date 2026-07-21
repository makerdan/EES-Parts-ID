/** @type {import('jest').Config} */

/**
 * Shared configuration inherited by both Jest projects below.
 *
 * Split rationale:
 *   db-serial  — tests that call seedVendors() or mutate canonical table rows
 *                (vendorPriority, vendorNameResolutionMap).  They must run
 *                sequentially because they flip isPrimary flags on live rows
 *                and read them back; concurrent execution produces race-driven
 *                false failures.
 *
 *   parallel   — every other test file.  Pure-unit tests have no DB at all;
 *                integration tests that do touch the DB use JEST-ITG- prefixed
 *                fixture rows that are isolated per suite, so concurrent
 *                execution is safe.
 *
 * closePool() in testDb.ts is guarded with a flag so that the second (or
 * later) test file running in the same Jest worker process does not crash when
 * it tries to close a pool that was already ended by the previous file.
 * jest.integrationSetup.cjs registers a global afterAll that calls closePool()
 * after every test file, ensuring the pool is closed even in test files that
 * never explicitly import closePool().  This allows Jest to exit cleanly
 * without forceExit, and surfaces any genuine resource-leak bugs rather than
 * masking them.
 */
const sharedConfig = {
  preset: "ts-jest",
  testEnvironment: "node",
  testTimeout: 10_000,
  setupFilesAfterEnv: ["<rootDir>/jest.integrationSetup.cjs"],
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        // isolatedModules is set in tsconfig.jest.json (via tsconfig.base.json
        // which carries "isolatedModules": true).  Using a file path instead of
        // an inline object keeps the setting compatible with ts-jest v30, which
        // removed the deprecated inline `isolatedModules` transform option.
        // isolatedModules erases `import type` statements without needing to
        // resolve their target modules.  This allows test files to import
        // parts-id utilities (e.g. editItemCache.ts, searchHelpers.ts) whose
        // type-only imports reference React Native components that are
        // unavailable in the Node.js Jest environment.  Runtime correctness is
        // unaffected; separate typecheck CI catches actual type errors.
        tsconfig: "./tsconfig.jest.json",
      },
    ],
    // Transpile the ESM-only `uuid` package (pulled in transitively by exceljs
    // and @google-cloud/storage) down to CommonJS so it can be require()d in the
    // Jest CJS environment. Runs transpile-only (isolatedModules) so ts-jest
    // does not type-check third-party JS. See transformIgnorePatterns below,
    // which un-ignores uuid so this transform is applied to it.
    "^.+\\.jsx?$": [
      "ts-jest",
      {
        // isolatedModules inherited from tsconfig.base.json via
        // tsconfig.jest.js.json — see comment on the tsx transform above.
        tsconfig: "./tsconfig.jest.js.json",
      },
    ],
  },
  // Resolve workspace packages to their TypeScript source so ts-jest can
  // transform them without relying on package.json "exports" field support
  // (which "moduleResolution: node" does not honour).
  moduleNameMapper: {
    // Stub @clerk/express so tests can authenticate by passing a Clerk user id
    // as the Bearer token (see __mocks__/clerkExpress.cjs).
    "^@clerk/express$": "<rootDir>/__mocks__/clerkExpress.cjs",
    // Stub the ESM-only http-proxy-middleware (see __mocks__/httpProxyMiddleware.cjs).
    "^http-proxy-middleware$": "<rootDir>/__mocks__/httpProxyMiddleware.cjs",
    // Stub the ESM-only pdfjs legacy build (uses import.meta at module scope,
    // unparseable in the Jest CJS runtime). Tests that need behaviour mock
    // this specifier themselves; the stub just prevents the parse crash.
    "^pdfjs-dist/legacy/build/pdf\\.mjs$": "<rootDir>/__mocks__/pdfjs-dist-legacy.cjs",
    "^@workspace/db$":
      "<rootDir>/../../lib/db/src/index.ts",
    "^@workspace/api-zod$":
      "<rootDir>/../../lib/api-zod/src/index.ts",
    "^@workspace/integrations-openai-ai-server/batch$":
      "<rootDir>/../../lib/integrations-openai-ai-server/src/batch/index.ts",
    "^@workspace/integrations-openai-ai-server$":
      "<rootDir>/../../lib/integrations-openai-ai-server/src/index.ts",
    // Map gemini-ai to a CJS stub so that p-limit (ESM-only) is never loaded
    // in the Jest CJS environment. Tests that need real behaviour should add
    // their own jest.mock() call on top of this stub.
    "^@workspace/integrations-gemini-ai$":
      "<rootDir>/__mocks__/integrations-gemini-ai-mock.cjs",
    // @google-cloud/storage is stubbed so tests never reach for real GCS
    // credentials or the network. (It also transitively pulls the ESM-only
    // uuid package, which the `.jsx?` transform + transformIgnorePatterns below
    // now handle for the code paths that do load uuid, e.g. real exceljs.)
    "^@google-cloud/storage$": "<rootDir>/__mocks__/google-cloud-storage.cjs",
    "^@workspace/integrations-poe-server$":
      "<rootDir>/../../lib/integrations-poe-server/src/index.ts",
    // Stub @workspace/api-client-react so editItemCache.ts can be imported in
    // the Node.js Jest environment without pulling in React Native / TanStack
    // Query bundles.  Only the runtime export (getListInventoryQueryKey) is
    // needed; all other exports are type-only and are erased by isolatedModules.
    "^@workspace/api-client-react$":
      "<rootDir>/__mocks__/api-client-react.cjs",
    // Map @/ aliases used inside parts-id utility files (searchHelpers.ts,
    // editItemCache.ts) to their real source so ts-jest can transform them.
    // The `import type` references inside these files (e.g. FilterPanel) are
    // erased by isolatedModules without needing the RN module to be resolved.
    "^@/utils/searchHelpers$":
      "<rootDir>/../../artifacts/parts-id/utils/searchHelpers.ts",
  },
  // Allow ts-jest to transform the workspace library source files even though
  // they live inside (or are symlinked from) node_modules.
  transformIgnorePatterns: [
    // Transform @workspace source and the ESM-only `uuid` package; ignore
    // everything else in node_modules. The `(?:\.pnpm/)?` prefix matches the
    // pnpm virtual-store layout (node_modules/.pnpm/uuid@x.y.z/...).
    "/node_modules/(?!(?:\\.pnpm/)?(?:@workspace|uuid)[@/])",
  ],
};

module.exports = {
  // globalSetup runs once before all projects — keeps DB preflight + schema
  // sync to a single execution regardless of how many projects are defined.
  globalSetup: "./jest.globalSetup.cjs",
  // forceExit was removed: jest.integrationSetup.cjs now registers a global
  // afterAll that closes the pg pool after every test file, so handles are
  // cleaned up organically and Jest exits without the "Force exiting" warning.

  // ── Coverage configuration ─────────────────────────────────────────────────
  // Scope coverage to production source only.  Excludes:
  //   - src/__tests__/**  — test-helper files living under src/
  //   - src/seed/**       — one-off seed/migration scripts, not API surface
  //   - **/__mocks__/**   — manual mock stubs
  //   - **/*.test.ts      — test files (shouldn't match src/** anyway)
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/__tests__/**",
    "!src/seed/**",
    "!**/__mocks__/**",
    "!**/*.test.ts",
  ],

  // Coverage thresholds — set at a conservative floor reflecting the current
  // full-suite baseline (unit + integration tests), rounded down to the nearest
  // 5 %.  The intent is to establish the gate so regressions fail fast;
  // individual percentages should be ratcheted upward as coverage improves.
  //
  // Baseline measured 2026-07-20:
  //   unit tests alone  → statements ~34 %, branches ~20 %, functions ~30 %
  //   full suite adds all route integration tests (38 files) + src/__tests__
  //   which cover all route handlers and middleware substantially above these.
  //   Thresholds are set comfortably below the full-suite level so the gate
  //   passes today and tightens over time, not on merge.
  coverageThreshold: {
    global: {
      statements: 50,
      branches: 30,
      functions: 50,
      lines: 50,
    },
  },

  projects: [
    {
      ...sharedConfig,
      displayName: "db-serial",
      // Only the two test files that mutate canonical (non-prefixed) rows.
      // maxWorkers:1 keeps them sequential so isPrimary flips in one test
      // do not race with reads in another.
      testMatch: [
        "<rootDir>/__tests__/vendorPriority.integration.test.ts",
        "<rootDir>/__tests__/vendorNameResolutionMap.integration.test.ts",
      ],
      maxWorkers: 1,
    },
    {
      ...sharedConfig,
      displayName: "parallel",
      // Mirror the original flat testMatch — "**/__tests__/**/*.test.ts"
      // matches both <rootDir>/__tests__/ and <rootDir>/src/__tests__/ so all
      // test files are covered regardless of which subdirectory they live in.
      testMatch: ["**/__tests__/**/*.test.ts"],
      testPathIgnorePatterns: [
        "/node_modules/",
        "/vendorPriority\\.integration\\.test\\.ts$",
        "/vendorNameResolutionMap\\.integration\\.test\\.ts$",
      ],
    },
  ],
};
