/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^expo-image-manipulator$': '<rootDir>/__mocks__/expo-image-manipulator.js',
    '^expo-file-system/legacy$': '<rootDir>/__mocks__/expo-file-system-legacy.js',
    '^react-native$': '<rootDir>/__mocks__/react-native.js',
    '^@expo/vector-icons$': '<rootDir>/__mocks__/expo-vector-icons.js',
    '^@/(.*)$': '<rootDir>/$1',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: { strict: true, jsx: 'react', esModuleInterop: true } }],
  },
  testMatch: ['**/__tests__/**/*.test.ts', '**/__tests__/**/*.test.tsx'],
};
