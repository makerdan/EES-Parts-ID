import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const command = join(scriptsDir, "node_modules", ".bin", "tsx");
const entrypoint = join(scriptsDir, "src", "check-production-privacy.ts");

function run(env) {
  return spawnSync(command, [entrypoint], {
    cwd: scriptsDir,
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_ENV: "production",
      REPLIT_DEPLOYMENT: "1",
      SESSION_SECRET: "",
      CLERK_SECRET_KEY: "",
      CORS_ALLOWED_ORIGINS: "",
      ...env,
    },
  });
}

{
  const result = run({});
  assert.equal(result.status, 1);
  assert.match(result.stdout, /privacy key material: missing/);
  assert.match(result.stdout, /production CORS configuration: missing/);
  assert.match(result.stderr, /CORS_ALLOWED_ORIGINS/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /secret-value/);
}

{
  const result = run({
    SESSION_SECRET: "secret-value",
    CORS_ALLOWED_ORIGINS: "https://parts.example",
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /privacy key material: present/);
  assert.match(result.stdout, /production CORS configuration: present/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /secret-value/);
}

console.log("production privacy check contract passed");