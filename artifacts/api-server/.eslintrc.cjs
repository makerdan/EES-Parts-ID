module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint', 'simple-import-sort', 'unused-imports'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  rules: {
    '@typescript-eslint/array-type': ['error', { default: 'generic' }],
    'simple-import-sort/imports': 'error',
    'simple-import-sort/exports': 'error',
    'no-restricted-imports': ['error', {
      patterns: [
        {
          group: ['@workspace/api-client-react', '@workspace/api-client-react/*'],
          message: 'Do not import @workspace/api-client-react in the API server. React Query is a client-side concern; use @workspace/db or @workspace/api-zod instead.',
        },
      ],
    }],
    // Disable the built-in rule in favour of the unused-imports version,
    // which also auto-removes entire import statements when all named imports
    // from that statement are unused.
    '@typescript-eslint/no-unused-vars': 'off',
    'unused-imports/no-unused-imports': 'error',
    'unused-imports/no-unused-vars': ['error', {
      vars: 'all',
      args: 'after-used',
      ignoreRestSiblings: true,
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrors: 'all',
      caughtErrorsIgnorePattern: '^_',
    }],
  },
  ignorePatterns: [
    'node_modules/',
    'dist/',
    '**/__mocks__/**',
    '**/__tests__/**',
    'build.mjs',
    'jest.config.cjs',
    'jest.globalSetup.cjs',
  ],
};
