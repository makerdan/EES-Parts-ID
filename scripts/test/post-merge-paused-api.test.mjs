import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isApiActiveAtEntry } from "../check-post-merge-api-active.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const emptyTable = "sl local_address rem_address st\n";
const listeningTable = `${emptyTable}0: 0100007F:0BB9 00000000:0000 0A\n`;

assert.equal(isApiActiveAtEntry({ port: 3001, socketTables: [emptyTable], processArguments: [] }), false);
assert.equal(isApiActiveAtEntry({ port: 3001, socketTables: [listeningTable], processArguments: [] }), true);
assert.equal(
  isApiActiveAtEntry({
    port: 3001,
    socketTables: [emptyTable],
    processArguments: [["/usr/bin/node", "/store/bin/pnpm", "--filter", "@workspace/api-server", "run", "dev"]],
  }),
  true,
);
assert.equal(
  isApiActiveAtEntry({
    port: 3001,
    socketTables: [emptyTable],
    processArguments: [["/usr/bin/node", `${root}/artifacts/api-server/node_modules/tsx/dist/cli.mjs`, "src/index.ts"]],
  }),
  true,
);
assert.equal(
  isApiActiveAtEntry({
    port: 3001,
    socketTables: [emptyTable],
    processArguments: [["/usr/bin/node", "/store/bin/pnpm", "--filter", "@workspace/parts-id", "run", "dev"]],
  }),
  false,
);

const fixture = mkdtempSync(join(tmpdir(), "post-merge-paused-api-"));
try {
  const bin = join(fixture, "bin");
  const calls = join(fixture, "calls");
  mkdirSync(bin);
  function mock(name, body) {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/bash\n${body}\n`);
    chmodSync(path, 0o755);
  }
  mock("git", 'printf "git:%s\\n" "$*" >> "$CALL_LOG"\nexit 0');
  mock("timeout", 'printf "timeout:%s\\n" "$*" >> "$CALL_LOG"\nexit 0');
  mock("curl", 'printf "curl:%s\\n" "$*" >> "$CALL_LOG"\necho \'{"status":"error"}\'');
  mock("sleep", 'printf "sleep:%s\\n" "$*" >> "$CALL_LOG"\nexit 0');
  mock("node", `
printf "node:%s\\n" "$*" >> "$CALL_LOG"
case "$1" in
  *check-post-merge-api-active.mjs) exit "$FAKE_API_ACTIVITY_EXIT" ;;
  -e)
    if [[ "$2" == *dev-ports.json* ]]; then printf '3001'; exit 0; fi
    exit 1 ;;
esac
exit 0`);

  function run(activityExit) {
    writeFileSync(calls, "");
    const result = spawnSync("bash", [join(root, "scripts/post-merge.sh")], {
      cwd: root,
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        PORT: "",
        REPLIT_DEV_DOMAIN: "mock-domain.test",
        CODEGEN_SETTLE_FLOOR_SECS: "0",
        CODEGEN_SETTLE_MAX_SECS: "0",
        CODEGEN_SETTLE_POLL_SECS: "1",
        GITHUB_TOKEN: "",
        CALL_LOG: calls,
        FAKE_API_ACTIVITY_EXIT: String(activityExit),
      },
    });
    if (result.error) throw result.error;
    return { status: result.status, output: result.stdout + result.stderr, calls: readFileSync(calls, "utf8") };
  }

  const paused = run(1);
  assert.equal(paused.status, 0, paused.output);
  assert.match(paused.output, /Live API health, sibling service, and SVG viewBox checks deferred/);
  assert.match(paused.output, /API client regenerated/);
  assert.doesNotMatch(paused.calls, /curl:|free-ports\.mjs/);

  const unhealthy = run(0);
  assert.equal(unhealthy.status, 1, unhealthy.output);
  assert.match(unhealthy.output, /API Server is still not healthy after restart/);
  assert.doesNotMatch(unhealthy.output, /checks deferred/);
  assert.match(unhealthy.calls, /curl:/);
  assert.match(unhealthy.calls, /free-ports\.mjs/);

  console.log("Post-merge paused-API regression: paused setup defers live checks; unhealthy active API fails.");
} finally {
  rmSync(fixture, { recursive: true, force: true });
}