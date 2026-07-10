/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testTimeout: 10_000,
  globalSetup: "./jest.globalSetup.cjs",
  setupFilesAfterEnv: ["./jest.integrationSetup.cjs"],
  // Force-exit after all tests complete.  Background async operations (e.g.
  // the bulk-enrich job's invalidateReferenceAnswerCache cleanup) can keep the
  // pg-pool open slightly past closePool(), preventing a clean exit.
  forceExit: true,
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        // isolatedModules erases `import type` statements without needing to
        // resolve their target modules.  This allows test files to import
        // parts-id utilities (e.g. editItemCache.ts, searchHelpers.ts) whose
        // type-only imports reference React Native components that are
        // unavailable in the Node.js Jest environment.  Runtime correctness is
        // unaffected; separate typecheck CI catches actual type errors.
        isolatedModules: true,
        tsconfig: {
          module: "commonjs",
          moduleResolution: "node",
          strict: true,
          esModuleInterop: true,
        },
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
        isolatedModules: true,
        tsconfig: {
          allowJs: true,
          module: "commonjs",
          moduleResolution: "node",
          esModuleInterop: true,
        },
      },
    ],
  },
  testMatch: ["**/__tests__/**/*.test.ts"],
  // Resolve workspace packages to their TypeScript source so ts-jest can
  // transform them without relying on package.json "exports" field support
  // (which "moduleResolution: node" does not honour).
  moduleNameMapper: {
    // Stub @clerk/express so tests can authenticate by passing a Clerk user id
    // as the Bearer token (see __mocks__/clerkExpress.cjs).
    "^@clerk/express$": "<rootDir>/__mocks__/clerkExpress.cjs",
    // Stub the ESM-only http-proxy-middleware (see __mocks__/httpProxyMiddleware.cjs).
    "^http-proxy-middleware$": "<rootDir>/__mocks__/httpProxyMiddleware.cjs",
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
