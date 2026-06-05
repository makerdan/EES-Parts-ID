module.exports = {
  extends: ['expo'],
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
