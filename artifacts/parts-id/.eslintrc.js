module.exports = {
  extends: ['expo'],
  plugins: ['simple-import-sort'],
  rules: {
    '@typescript-eslint/array-type': ['error', { default: 'generic' }],
    'simple-import-sort/imports': 'error',
    'simple-import-sort/exports': 'error',
    '@typescript-eslint/no-unused-vars': ['error', { vars: 'all', args: 'after-used', ignoreRestSiblings: true, argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
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
