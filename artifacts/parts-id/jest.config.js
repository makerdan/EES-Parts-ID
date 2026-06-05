/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  moduleNameMapper: {
    "^react-native$": "<rootDir>/__mocks__/react-native.js",
    "^expo-image-manipulator$": "<rootDir>/__mocks__/expo-image-manipulator.js",
    "^expo-file-system/legacy$": "<rootDir>/__mocks__/expo-file-system-legacy.js",
    "^lidar-measure$": "<rootDir>/__mocks__/lidar-measure.js",
    "^@/(.*)$": "<rootDir>/$1",
    "^@workspace/zone-validation$": "<rootDir>/../../lib/zone-validation/src/index.ts",
  },
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: {
          strict: true,
          jsx: "react",
          baseUrl: ".",
          paths: {
            "@/*": ["./*"],
            "lidar-measure": ["./modules/lidar-measure/src/index"],
            "@workspace/zone-validation": [
              "../../lib/zone-validation/src/index.ts",
            ],
          },
        },
      },
    ],
  },
  testMatch: ["**/__tests__/**/*.test.ts", "**/__tests__/**/*.test.tsx"],
};
