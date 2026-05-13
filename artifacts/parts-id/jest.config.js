/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  moduleNameMapper: {
    "^expo-image-manipulator$": "<rootDir>/__mocks__/expo-image-manipulator.js",
    "^expo-file-system/legacy$": "<rootDir>/__mocks__/expo-file-system-legacy.js",
  },
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: { strict: true } }],
  },
  testMatch: ["**/__tests__/**/*.test.ts"],
};
