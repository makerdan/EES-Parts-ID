import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type GeneratedManifest = {
  sourceFiles: string[];
  requiredFiles: string[];
  nonEmptyDirectories: string[];
};

const ROOT = resolve(__dirname, "../../../..");
const API_SPEC_SCRIPT = resolve(ROOT, "lib/api-spec/scripts/ensure-codegen.mjs");
const SERIAL_LOCK_SCRIPT = resolve(ROOT, "scripts/serial-lock.mjs");
const MANIFEST = JSON.parse(
  readFileSync(resolve(ROOT, "lib/api-spec/generated-output-manifest.json"), "utf8"),
) as GeneratedManifest;

const activeRoots: string[] = [];

function wait(ms: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await wait(10);
  }
}

function createGeneratedFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "ensure-codegen-"));
  activeRoots.push(root);
  const apiSpecDir = join(root, "lib/api-spec");
  mkdirSync(apiSpecDir, { recursive: true });
  writeFileSync(
    join(apiSpecDir, "package.json"),
    JSON.stringify({
      name: "@workspace/api-spec",
      version: "0.0.0",
      scripts: {
        codegen: "node ../../scripts/serial-lock.mjs --resource codegen -- pnpm run codegen:locked",
        "codegen:locked": "pnpm run dependency:check && orval --config ./orval.config.ts",
      },
      devDependencies: { orval: "8.22.0" },
    }),
  );
  writeFileSync(join(apiSpecDir, "openapi.yaml"), "openapi: 3.0.0\ninfo:\n  title: Fixture\n");
  writeFileSync(join(apiSpecDir, "orval.config.ts"), "export default {};\n");
  writeFileSync(join(apiSpecDir, "post-codegen.mjs"), "export {};\n");
  writeFileSync(
    join(root, "pnpm-lock.yaml"),
    [
      "lockfileVersion: '9.0'",
      "",
      "importers:",
      "  lib/api-spec:",
      "    devDependencies:",
      "      orval:",
      "        specifier: 8.22.0",
      "        version: 8.22.0",
      "",
      "packages:",
      "  orval@8.22.0:",
      "    resolution: {integrity: sha512-fixture-orval}",
      "  toolchain-leaf@1.0.0:",
      "    resolution: {integrity: sha512-fixture-leaf}",
      "",
      "snapshots:",
      "  orval@8.22.0:",
      "    dependencies:",
      "      toolchain-leaf: 1.0.0",
      "  toolchain-leaf@1.0.0: {}",
      "",
    ].join("\n"),
  );

  for (const path of new Set([...MANIFEST.sourceFiles, ...MANIFEST.requiredFiles])) {
    const absolutePath = join(root, path);
    mkdirSync(resolve(absolutePath, ".."), { recursive: true });
    writeFileSync(absolutePath, "export const generated = true;\n");
  }
  for (const path of MANIFEST.nonEmptyDirectories) {
    mkdirSync(join(root, path), { recursive: true });
  }
  return root;
}

function createFakePnpm(root: string): string {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "pnpm"),
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      "if (args[0] === '--version') { console.log('10.26.1'); process.exit(0); }",
      "if (args[0] === 'run' && args[1] === 'codegen') {",
      "  fs.appendFileSync(process.env.CODEGEN_COUNTER, process.pid + '\\n');",
      "  let activeFd;",
      "  try { activeFd = fs.openSync(process.env.CODEGEN_ACTIVE, 'wx'); }",
      "  catch { fs.appendFileSync(process.env.CODEGEN_EVENTS, 'OVERLAP\\n'); process.exit(9); }",
      "  fs.appendFileSync(process.env.CODEGEN_EVENTS, 'boot:start\\n');",
      "  setTimeout(() => { fs.closeSync(activeFd); fs.rmSync(process.env.CODEGEN_ACTIVE, { force: true }); fs.appendFileSync(process.env.CODEGEN_EVENTS, 'boot:end\\n'); process.exit(0); }, Number(process.env.CODEGEN_HOLD_MS || 0));",
      "  return;",
      "}",
      "process.exit(0);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return bin;
}

function ensureEnv(root: string, bin: string, lockFile: string) {
  return {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    CODEGEN_WORKSPACE_ROOT: root,
    CODEGEN_API_SPEC_DIR: join(root, "lib/api-spec"),
    CODEGEN_COUNTER: join(root, "codegen-count"),
    CODEGEN_ACTIVE: join(root, "codegen-active"),
    CODEGEN_EVENTS: join(root, "codegen-events"),
    SERIAL_LOCK_FILE: lockFile,
    SERIAL_LOCK_QUEUE_DIR: join(root, "queue"),
    SERIAL_LOCK_POLL_MS: "10",
    SERIAL_LOCK_TIMEOUT_MS: "5000",
    SERIAL_LOCK_STALE_HEARTBEAT_MS: "5000",
    SERIAL_LOCK_MAX_HOLD_MS: "5000",
    SERIAL_LOCK_HEARTBEAT_MS: "20",
    SERIAL_LOCK_HELD_PID: "",
    SERIAL_LOCK_HELD_RESOURCES: "",
  };
}

function runEnsure(root: string, bin: string, lockFile: string, holdMs = 0) {
  return new Promise<{ code: number; output: string }>((resolveRun) => {
    const child = spawn(process.execPath, [API_SPEC_SCRIPT], {
      cwd: ROOT,
      env: { ...ensureEnv(root, bin, lockFile), CODEGEN_HOLD_MS: String(holdMs) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("close", (code) => resolveRun({ code: code ?? 1, output }));
  });
}

function runSerialLock(
  lockFile: string,
  queueDir: string,
  command: string,
  overrides: Record<string, string> = {},
) {
  return new Promise<{ code: number; output: string }>((resolveRun) => {
    const child = spawn(
      process.execPath,
      [
        SERIAL_LOCK_SCRIPT,
        "--resource",
        "codegen",
        "--priority",
        "2",
        "--",
        process.execPath,
        "-e",
        command,
      ],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          SERIAL_LOCK_FILE: lockFile,
          SERIAL_LOCK_QUEUE_DIR: queueDir,
          SERIAL_LOCK_POLL_MS: "10",
          SERIAL_LOCK_TIMEOUT_MS: "5000",
          SERIAL_LOCK_STALE_HEARTBEAT_MS: "5000",
          SERIAL_LOCK_MAX_HOLD_MS: "5000",
          SERIAL_LOCK_HEARTBEAT_MS: "1000",
          SERIAL_LOCK_HELD_PID: "",
          SERIAL_LOCK_HELD_RESOURCES: "",
          ...overrides,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("close", (code) => resolveRun({ code: code ?? 1, output }));
  });
}

afterEach(() => {
  for (const root of activeRoots) rmSync(root, { recursive: true, force: true });
  activeRoots.length = 0;
});

describe("codegen ownership and cache identity", () => {
  it("serializes concurrent ensure runs on the shared codegen resource", async () => {
    const root = createGeneratedFixture();
    const bin = createFakePnpm(root);
    const lockFile = join(root, "codegen.lock");

    const [first, second] = await Promise.all([
      runEnsure(root, bin, lockFile, 250),
      runEnsure(root, bin, lockFile, 250),
    ]);

    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(readFileSync(join(root, "codegen-count"), "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("serializes boot ensure against a post-merge codegen owner", async () => {
    const root = createGeneratedFixture();
    const bin = createFakePnpm(root);
    const lockFile = join(root, "codegen.lock");
    const queueDir = join(root, "queue");
    const postMerge = runSerialLock(
      lockFile,
      queueDir,
      "const fs = require('node:fs'); fs.appendFileSync(process.env.CODEGEN_EVENTS, 'post:start\\n'); setTimeout(() => { fs.appendFileSync(process.env.CODEGEN_EVENTS, 'post:end\\n'); process.exit(0); }, 250)",
      {
        CODEGEN_ACTIVE: join(root, "codegen-active"),
        CODEGEN_EVENTS: join(root, "codegen-events"),
      },
    );
    await waitFor(() => existsSync(lockFile), "post-merge codegen lock");
    const boot = runEnsure(root, bin, lockFile, 100);

    expect((await postMerge).code).toBe(0);
    expect((await boot).code).toBe(0);
    expect(readFileSync(join(root, "codegen-events"), "utf8")).not.toContain("OVERLAP");
  });

  it("regenerates for a resolved Orval change but ignores unrelated lockfile changes", async () => {
    const root = createGeneratedFixture();
    const bin = createFakePnpm(root);
    const lockFile = join(root, "codegen.lock");
    const lockfile = join(root, "pnpm-lock.yaml");

    expect((await runEnsure(root, bin, lockFile)).code).toBe(0);
    const unchangedCount = readFileSync(join(root, "codegen-count"), "utf8").trim().split("\n").length;

    writeFileSync(lockfile, `${readFileSync(lockfile, "utf8")}\n# unrelated workspace change\n`);
    expect((await runEnsure(root, bin, lockFile)).code).toBe(0);
    expect(readFileSync(join(root, "codegen-count"), "utf8").trim().split("\n")).toHaveLength(unchangedCount);

    writeFileSync(
      lockfile,
      readFileSync(lockfile, "utf8").replace("fixture-leaf", "fixture-leaf-updated"),
    );
    expect((await runEnsure(root, bin, lockFile)).code).toBe(0);
    expect(readFileSync(join(root, "codegen-count"), "utf8").trim().split("\n")).toHaveLength(
      unchangedCount + 1,
    );

    writeFileSync(
      lockfile,
      readFileSync(lockfile, "utf8")
        .replaceAll("8.22.0", "8.23.0")
        .replace("fixture-orval", "fixture-orval-updated"),
    );
    expect((await runEnsure(root, bin, lockFile)).code).toBe(0);
    expect(readFileSync(join(root, "codegen-count"), "utf8").trim().split("\n")).toHaveLength(
      unchangedCount + 2,
    );
  });

  it("does not let a stale owner release a successor's lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "serial-lock-replacement-"));
    activeRoots.push(root);
    const lockFile = join(root, "codegen.lock");
    const queueDir = join(root, "queue");
    const staleOwner = runSerialLock(
      lockFile,
      queueDir,
      "setTimeout(() => process.exit(0), 300)",
      { SERIAL_LOCK_STALE_HEARTBEAT_MS: "50" },
    );
    await waitFor(() => existsSync(lockFile), "stale owner lock");
    await wait(100);

    const successor = runSerialLock(
      lockFile,
      queueDir,
      "setTimeout(() => process.exit(require('node:fs').existsSync(process.env.SERIAL_LOCK_FILE) ? 0 : 8), 250)",
      { SERIAL_LOCK_STALE_HEARTBEAT_MS: "50" },
    );

    expect((await staleOwner).code).toBe(0);
    expect((await successor).code).toBe(0);
    expect(existsSync(lockFile)).toBe(false);
  });
});