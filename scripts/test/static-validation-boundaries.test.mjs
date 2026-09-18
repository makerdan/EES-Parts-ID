import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkEnvVars } from "../src/check-env-vars.ts";
import { checkTsconfigRefs } from "../src/check-tsconfig-refs.ts";

const fixtureRoot = mkdtempSync(
  join(tmpdir(), "static-validation-boundaries-"),
);
try {
  mkdirSync(join(fixtureRoot, "lib", "nested", "server-integration"), {
    recursive: true,
  });
  writeFileSync(
    join(fixtureRoot, "tsconfig.json"),
    '{"references":[],"description":"https://example.test/tsconfig"}\n',
  );
  writeFileSync(
    join(fixtureRoot, "lib", "nested", "server-integration", "tsconfig.json"),
    '{"compilerOptions":{"composite":true}}\n',
  );
  const tsconfigResult = await checkTsconfigRefs(fixtureRoot);
  assert.deepEqual(tsconfigResult.violations, [
    "lib/nested/server-integration",
  ]);

  mkdirSync(join(fixtureRoot, "artifacts", "api-server", "src"), {
    recursive: true,
  });
  mkdirSync(join(fixtureRoot, "lib", "server-provider", "src"), {
    recursive: true,
  });
  mkdirSync(join(fixtureRoot, "scripts", "src"), { recursive: true });
  writeFileSync(
    join(fixtureRoot, "artifacts", "api-server", "package.json"),
    '{"name":"@fixture/api-server"}',
  );
  writeFileSync(
    join(fixtureRoot, "lib", "server-provider", "package.json"),
    '{"name":"@fixture/server-provider","serverOnly":true}',
  );
  writeFileSync(
    join(fixtureRoot, "artifacts", "api-server", "src", "index.js"),
    "export const apiSecret = process.env.API_SECRET;\n",
  );
  writeFileSync(
    join(fixtureRoot, "lib", "server-provider", "src", "client.mjs"),
    "export const providerSecret = process.env.PROVIDER_SECRET;\n",
  );
  writeFileSync(join(fixtureRoot, ".env.example"), "");
  const envResult = checkEnvVars(fixtureRoot);
  assert.deepEqual(envResult.undocumented, ["API_SECRET", "PROVIDER_SECRET"]);
  assert.ok(envResult.scannedFiles.some((file) => file.endsWith("client.mjs")));
  console.log("static validation boundary fixtures passed");
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
