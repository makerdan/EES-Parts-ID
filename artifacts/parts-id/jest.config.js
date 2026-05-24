/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  moduleNameMapper: {
    "^react-native$": "<rootDir>/__mocks__/react-native.js",
    "^expo-image-manipulator$": "<rootDir>/__mocks__/expo-image-manipulator.js",
    "^expo-file-system/legacy$": "<rootDir>/__mocks__/expo-file-system-legacy.js",
    "^@/(.*)$": "<rootDir>/$1",
    "^@workspace/zone-validation$": "<rootDir>/../../lib/zone-validation/src/index.ts",
  },
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: { strict: true, jsx: "react" } }],
  },
  testMatch: ["**/__tests__/**/*.test.ts"],
};
