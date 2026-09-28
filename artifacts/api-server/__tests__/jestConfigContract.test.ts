/**
 * Contract checks for the split Jest projects.
 *
 * Keeping these checks in the normal test tree makes an accidentally stale
 * serial classification fail before a singleton writer can run in parallel.
 */
import fs from "node:fs";
import path from "node:path";

type JestProject = {
  displayName?: string;
  testMatch?: string[];
  testPathIgnorePatterns?: string[];
};

type JestConfig = {
  projects?: JestProject[];
};

const API_ROOT = path.resolve(__dirname, "..");
const config = require("../jest.config.cjs") as JestConfig;

function project(name: string): JestProject {
  const found = config.projects?.find(({ displayName }) => displayName === name);
  if (!found) throw new Error(`Jest config is missing the ${name} project`);
  return found;
}

describe("Jest project classification contract", () => {
  const serial = project("db-serial");
  const parallel = project("parallel");
  const serialPaths = serial.testMatch ?? [];
  const parallelIgnores = parallel.testPathIgnorePatterns ?? [];

  it("keeps every serial test path real and excluded from parallel", () => {
    for (const configuredPath of serialPaths) {
      const relativePath = configuredPath.replace("<rootDir>/", "");
      expect(fs.existsSync(path.join(API_ROOT, relativePath))).toBe(true);

      const absolutePath = path.join(API_ROOT, relativePath);
      expect(
        parallelIgnores.some((pattern) => new RegExp(pattern).test(absolutePath)),
      ).toBe(true);
    }
  });

  it("serializes every admin preference singleton writer", () => {
    const writers = [
      "adminPreferences.integration.test.ts",
      "adminAiProvider.integration.test.ts",
      "adminAiStatus.integration.test.ts",
    ];

    for (const writer of writers) {
      const configuredPath = `<rootDir>/__tests__/${writer}`;
      expect(serialPaths).toContain(configuredPath);

      const absolutePath = path.join(API_ROOT, "__tests__", writer);
      expect(
        parallelIgnores.some((pattern) => new RegExp(pattern).test(absolutePath)),
      ).toBe(true);
    }
  });
});