module.exports = {
  extends: ['expo'],
  plugins: ['simple-import-sort'],
  rules: {
    '@typescript-eslint/array-type': ['error', { default: 'generic' }],
    'simple-import-sort/imports': 'error',
    'simple-import-sort/exports': 'error',
    '@typescript-eslint/no-unused-vars': ['error', { vars: 'all', args: 'after-used', ignoreRestSiblings: true, argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-restricted-imports': ['error', {
      patterns: [
        {
          group: ['@workspace/db', '@workspace/db/*'],
          message: 'Do not import the raw DB layer (@workspace/db) in the mobile app. Use @workspace/api-zod for types and @workspace/api-client-react for data fetching.',
        },
        {
          group: ['@workspace/api-spec', '@workspace/api-spec/*'],
          message: 'Do not import @workspace/api-spec directly in the mobile app. Use @workspace/api-zod for validated types.',
        },
      ],
    }],
  },
  ignorePatterns: [
    'node_modules/',
    'dist/',
    '.expo/',
    'scripts/',
    'server/',
    'modules/',
    '**/__mocks__/**',
    '**/__tests__/**',
    'metro.config.js',
    'babel.config.js',
    'jest.config.js',
  ],
};
