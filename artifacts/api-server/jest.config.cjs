/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testSequencer: './alphabetical-sequencer.cjs',
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'commonjs',
          moduleResolution: 'node',
          strict: true,
          esModuleInterop: true,
        },
      },
    ],
  },
  testMatch: ['**/__tests__/**/*.test.ts'],
  // Exclude smoke tests from the default run — they load multi-MB PDF assets
  // and can take 60 s+ per suite. Use `pnpm run test:smoke` to run them
  // explicitly when catalog-parsing logic changes.
  testPathIgnorePatterns: ['/node_modules/', '\\.smoke\\.test\\.ts$'],
  // Run test suites serially to prevent concurrent DB mutations (advisory locks,
  // row-count drift) from breaking integration tests that share a live database.
  maxWorkers: 1,
  // Resolve workspace packages to their TypeScript source so ts-jest can
  // transform them without relying on package.json "exports" field support
  // (which "moduleResolution: node" does not honour).
  moduleNameMapper: {
    '^@workspace/db$': '<rootDir>/../../lib/db/src/index.ts',
    '^@workspace/api-zod$': '<rootDir>/../../lib/api-zod/src/index.ts',
    '^@workspace/integrations-openai-ai-server/batch$':
      '<rootDir>/../../lib/integrations-openai-ai-server/src/batch/index.ts',
    '^@workspace/integrations-openai-ai-server$':
      '<rootDir>/../../lib/integrations-openai-ai-server/src/index.ts',
  },
  // Allow ts-jest to transform the workspace library source files even though
  // they live inside (or are symlinked from) node_modules.
  transformIgnorePatterns: ['/node_modules/(?!@workspace/)'],
};
