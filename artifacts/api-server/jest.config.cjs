/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
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
    "^@workspace/integrations-poe-server$":
      "<rootDir>/../../lib/integrations-poe-server/src/index.ts",
  },
  // Allow ts-jest to transform the workspace library source files even though
  // they live inside (or are symlinked from) node_modules.
  transformIgnorePatterns: [
    "/node_modules/(?!@workspace/)",
  ],
};
