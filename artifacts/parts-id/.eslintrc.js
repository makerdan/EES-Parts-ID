module.exports = {
  extends: ['expo'],
  plugins: ['simple-import-sort'],
  rules: {
    '@typescript-eslint/array-type': ['error', { default: 'generic' }],
    'simple-import-sort/imports': 'error',
    'simple-import-sort/exports': 'error',
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
