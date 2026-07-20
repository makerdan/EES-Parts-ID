module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['@typescript-eslint', 'react-hooks'],
  rules: {
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'error',
    'no-restricted-imports': ['error', {
      patterns: [
        {
          group: ['@workspace/db', '@workspace/db/*'],
          message: 'Do not import the raw DB layer (@workspace/db) in the mockup sandbox. Mockups are client-side only; use static fixture data instead.',
        },
        {
          group: ['@workspace/api-server', '@workspace/api-server/*'],
          message: 'Do not import @workspace/api-server in the mockup sandbox. Mockups are client-side only; use static fixture data instead.',
        },
      ],
    }],
  },
  ignorePatterns: [
    'node_modules/',
    'dist/',
  ],
};
