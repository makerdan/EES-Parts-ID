import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { strict as assert } from "assert";
import { parseJsonConfig } from "../src/check-tsconfig-refs";
import {
  exportedClassNames,
  parseMockCalls,
  resolveModulePath,
  scanFile,
} from "../src/check-mock-factories";

const tempDir = mkdtempSync(join(tmpdir(), "validation-parsers-"));

try {
  const config = parseJsonConfig(
    "fixture-tsconfig.json",
    `{
      // A URL must not be treated as a comment.
      "compilerOptions": { "baseUrl": "https://example.test/tsconfig" },
      /* JSONC comments and trailing commas are valid. */
      "references": [{ "path": "./lib/example" },],
    }`,
  ) as { compilerOptions: { baseUrl: string } };
  assert.equal(config.compilerOptions.baseUrl, "https://example.test/tsconfig");

  assert.throws(
    () => parseJsonConfig("broken-tsconfig.json", '{"references": [}'),
    /Invalid JSONC in broken-tsconfig\.json/,
  );

  const syntaxFixture = `
    const url = "https://example.test/jest.mock(\\"ignored\\")";
    const regex = /jest\\.mock\\(["'][^)]*\\)/;
    const template = \`jest.mock("ignored", () => ({}))\`;
    /* jest.mock("ignored", () => ({})) */
    // jest.mock("ignored", () => ({}))
    jest.mock("@workspace/api-client-react/custom-fetch", () => ({
      ...jest.requireActual("@workspace/api-client-react/custom-fetch"),
    }));
  `;
  const calls = parseMockCalls(syntaxFixture);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.modulePath, "@workspace/api-client-react/custom-fetch");
  assert.equal(calls[0]?.factoryCallsRequireActual, true);

  const subpath = resolveModulePath(
    "@workspace/api-client-react/custom-fetch",
    join(tempDir, "fixture.test.ts"),
  );
  assert.ok(subpath?.endsWith("/lib/api-client-react/src/custom-fetch.ts"));
  assert.deepEqual(exportedClassNames(subpath!), [
    "TimeoutError",
    "ApiError",
    "ResponseParseError",
  ]);

  const violationFile = join(tempDir, "violation.test.ts");
  writeFileSync(
    violationFile,
    `
      const regex = /jest\\.mock\\("ignored"/;
      jest.mock("@workspace/api-client-react/custom-fetch", () => ({
        TimeoutError: class TimeoutError {},
      }));
    `,
  );
  assert.equal(scanFile(violationFile).length, 1);

  const harmlessFile = join(tempDir, "harmless.test.ts");
  writeFileSync(harmlessFile, syntaxFixture);
  assert.equal(scanFile(harmlessFile).length, 0);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

console.log("validation parser fixtures passed.");