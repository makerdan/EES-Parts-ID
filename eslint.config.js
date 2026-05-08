const tsParser = require('@typescript-eslint/parser');
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const expoFlatConfig = require('eslint-config-expo/flat');
const globals = require('globals');

/** @type {import('eslint').Linter.Config[]} */
module.exports = [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.expo/**',
      '**/build/**',
      '**/coverage/**',
      '.local/**',
      '.agents/**',
      'lib/api-client-react/src/generated/**',
      'artifacts/parts-id/scripts/**',
      'artifacts/api-server/build.mjs',
    ],
  },

  // TypeScript rules for all TS/TSX files
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // These rules fire on legitimate patterns in this codebase
      '@typescript-eslint/no-namespace': 'off',
      '@typescript-eslint/no-empty-object-type': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
    },
  },

  // Expo / React Native overrides for the mobile app
  {
    files: ['artifacts/parts-id/**/*.ts', 'artifacts/parts-id/**/*.tsx'],
    plugins: (() => {
      const plugins = {};
      for (const cfg of expoFlatConfig) {
        if (cfg.plugins) Object.assign(plugins, cfg.plugins);
      }
      return plugins;
    })(),
    languageOptions: {
      globals: (() => {
        const g = {};
        for (const cfg of expoFlatConfig) {
          if (cfg.languageOptions?.globals) Object.assign(g, cfg.languageOptions.globals);
        }
        return g;
      })(),
    },
    settings: (() => {
      const s = {};
      for (const cfg of expoFlatConfig) {
        if (cfg.settings) Object.assign(s, cfg.settings);
      }
      return s;
    })(),
    rules: (() => {
      const r = {};
      for (const cfg of expoFlatConfig) {
        if (cfg.rules) Object.assign(r, cfg.rules);
      }
      return {
        ...r,
        // Path aliases (@/) and workspace packages cannot be resolved by the
        // import plugin without a TypeScript-aware resolver — disable for now.
        'import/no-unresolved': 'off',
        // React Native renders to native UI, not HTML — entity escaping is
        // irrelevant and the rule generates noisy false positives.
        'react/no-unescaped-entities': 'off',
      };
    })(),
  },

  // CommonJS files — give them Node globals so `require`/`module` are known
  {
    files: ['**/*.cjs', '**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.commonjs,
      },
      sourceType: 'commonjs',
    },
  },

  // AudioWorklet files run in a special global scope
  {
    files: ['**/audio-playback-worklet.js'],
    languageOptions: {
      globals: {
        AudioWorkletProcessor: 'readonly',
        registerProcessor: 'readonly',
        currentTime: 'readonly',
        currentFrame: 'readonly',
        sampleRate: 'readonly',
      },
    },
  },
];
