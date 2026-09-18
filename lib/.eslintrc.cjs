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
          group: ['@workspace/parts-id', '@workspace/parts-id/*'],
          message: 'lib/* packages must not import from artifacts (upward dependency). @workspace/parts-id is an artifact.',
        },
        {
          group: ['@workspace/api-server', '@workspace/api-server/*'],
          message: 'lib/* packages must not import from artifacts (upward dependency). @workspace/api-server is an artifact.',
        },
        {
          group: ['@workspace/mockup-sandbox', '@workspace/mockup-sandbox/*'],
          message: 'lib/* packages must not import from artifacts (upward dependency). @workspace/mockup-sandbox is an artifact.',
        },
      ],
    }],
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
    '**/generated/**',
    '**/__tests__/**',
    '**/__mocks__/**',
  ],
};
