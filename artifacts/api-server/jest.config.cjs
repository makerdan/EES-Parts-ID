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
        tsconfig: {
          module: "commonjs",
          moduleResolution: "node",
          strict: true,
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
    // exceljs transitively imports uuid@14 (pure ESM) which cannot be
    // transformed by ts-jest in the CJS test environment. Stub it out so that
    // any test loading app.ts (which pulls in routes/adminQuery.ts) can run.
    "^exceljs$": "<rootDir>/__mocks__/exceljs.cjs",
    // @google-cloud/storage transitively imports uuid@14 (pure ESM).
    // Stub it out for tests that load app.ts.
    "^@google-cloud/storage$": "<rootDir>/__mocks__/google-cloud-storage.cjs",
    "^@workspace/integrations-poe-server$":
      "<rootDir>/../../lib/integrations-poe-server/src/index.ts",
  },
  // Allow ts-jest to transform the workspace library source files even though
  // they live inside (or are symlinked from) node_modules.
  transformIgnorePatterns: [
    "/node_modules/(?!@workspace/)",
  ],
};
