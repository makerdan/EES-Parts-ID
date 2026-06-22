/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  globals: { __DEV__: false },
  moduleNameMapper: {
    "^react-native$": "<rootDir>/__mocks__/react-native.js",
    "^expo-clipboard$": "<rootDir>/__mocks__/expo-clipboard.js",
    "^expo-image-manipulator$": "<rootDir>/__mocks__/expo-image-manipulator.js",
    "^expo-secure-store$": "<rootDir>/__mocks__/expo-secure-store.js",
    "^expo-file-system$": "<rootDir>/__mocks__/expo-file-system.js",
    "^expo-file-system/legacy$": "<rootDir>/__mocks__/expo-file-system-legacy.js",
    "^@/contexts/AppContext$": "<rootDir>/__mocks__/contexts/AppContext.js",
    "^react-native-gesture-handler$": "<rootDir>/__mocks__/react-native-gesture-handler.js",
    "^@react-native-community/netinfo$": "<rootDir>/__mocks__/netinfo.js",
    "^lidar-measure$": "<rootDir>/__mocks__/lidar-measure.js",
    "^@/(.*)$": "<rootDir>/$1",
    "^@workspace/zone-validation$": "<rootDir>/../../lib/zone-validation/src/index.ts",
    "^@workspace/api-client-react$": "<rootDir>/../../lib/api-client-react/src/index.ts",
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
            "@workspace/api-client-react": [
              "../../lib/api-client-react/src/index.ts",
            ],
          },
        },
      },
    ],
  },
  testMatch: ["**/__tests__/**/*.test.ts", "**/__tests__/**/*.test.tsx"],
};
