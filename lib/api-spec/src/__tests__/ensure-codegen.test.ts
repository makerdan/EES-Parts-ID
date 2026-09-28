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
const CODEGEN_RUNNER = resolve(ROOT, "lib/api-spec/scripts/run-codegen.mjs");
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
        codegen: "node ../../scripts/serial-lock.mjs --resource codegen -- node ./scripts/run-codegen.mjs",
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
      "if ((args[0] === 'run' && args[1] === 'dependency:check') || (args[0] === 'exec' && args[1] === 'orval')) { fs.appendFileSync(process.env.CODEGEN_COMMANDS, args.join(' ') + '\\n'); }",
      "if ((args[0] === 'exec' && args[1] === 'orval') || (args[0] === 'run' && args[1] === 'codegen')) {",
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
    CODEGEN_COMMANDS: join(root, "codegen-commands"),
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
  it("rejects direct invocation of the internal generator runner", async () => {
    const result = await new Promise<{ code: number; output: string }>((resolveRun) => {
      const child = spawn(process.execPath, [CODEGEN_RUNNER], {
        cwd: ROOT,
        env: {
          ...process.env,
          SERIAL_LOCK_HELD_PID: "",
          SERIAL_LOCK_HELD_RESOURCES: "",
          SERIAL_LOCK_HELD_TOKEN: "",
          SERIAL_LOCK_FILE: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      child.on("close", (code) => resolveRun({ code: code ?? 1, output }));
    });

    expect(result.code).toBe(2);
    expect(result.output).toContain("refusing to run without the live shared codegen lock");
  });

  it("refuses to start codegen when the lock token is replaced before runner startup", async () => {
    const root = createGeneratedFixture();
    const bin = createFakePnpm(root);
    const lockFile = join(root, "codegen.lock");
    const queueDir = join(root, "queue");
    const result = await runSerialLock(
      lockFile,
      queueDir,
      "const fs = require('node:fs'); const { spawnSync } = require('node:child_process'); const sleep = ms => { const shared = new Int32Array(new SharedArrayBuffer(4)); Atomics.wait(shared, 0, 0, ms); }; let lines; do { lines = fs.readFileSync(process.env.SERIAL_LOCK_FILE, 'utf8').split('\\n'); if (lines[5]?.trim()) break; sleep(10); } while (true); lines[4] = 'successor-token'; const replacement = process.env.SERIAL_LOCK_FILE + '.replacement'; fs.writeFileSync(replacement, lines.join('\\n')); fs.renameSync(replacement, process.env.SERIAL_LOCK_FILE); const runner = spawnSync(process.execPath, [process.env.CODEGEN_RUNNER], { cwd: process.cwd(), env: process.env, encoding: 'utf8' }); process.stdout.write(runner.stdout || ''); process.stderr.write(runner.stderr || ''); process.exit(runner.status ?? 1)",
      {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        CODEGEN_RUNNER: CODEGEN_RUNNER,
        CODEGEN_COMMANDS: join(root, "codegen-commands"),
      },
    );

    expect(result.code).toBe(2);
    expect(result.output).toContain(
      "[api-spec codegen] refusing to run without the live shared codegen lock",
    );
    expect(existsSync(join(root, "codegen-commands"))).toBe(false);
  });

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
    const ownerReadyFile = join(root, "owner-ready");
    const ownerReleaseFile = join(root, "owner-release");
    const successorReadyFile = join(root, "successor-ready");
    const successorReleaseFile = join(root, "successor-release");
    const waitForRelease = [
      "const fs = require('node:fs');",
      "fs.writeFileSync(process.env.TEST_READY_FILE, 'ready');",
      "const interval = setInterval(() => {",
      "  if (!fs.existsSync(process.env.TEST_RELEASE_FILE)) return;",
      "  clearInterval(interval);",
      "  process.exit(fs.existsSync(process.env.SERIAL_LOCK_FILE) ? 0 : 8);",
      "}, 10);",
    ].join("\n");
    const staleOwner = runSerialLock(
      lockFile,
      queueDir,
      waitForRelease,
      {
        SERIAL_LOCK_STALE_HEARTBEAT_MS: "50",
        TEST_READY_FILE: ownerReadyFile,
        TEST_RELEASE_FILE: ownerReleaseFile,
      },
    );
    let successor: ReturnType<typeof runSerialLock> | undefined;
    try {
      await waitFor(
        () => existsSync(ownerReadyFile) && existsSync(lockFile) &&
          Number(readFileSync(lockFile, "utf8").split("\n")[5]) > 0,
        "attached stale owner",
      );
      const oldToken = readFileSync(lockFile, "utf8").split("\n")[4]?.trim();
      expect(oldToken).toBeTruthy();

      successor = runSerialLock(
        lockFile,
        queueDir,
        waitForRelease,
        {
          SERIAL_LOCK_STALE_HEARTBEAT_MS: "50",
          TEST_READY_FILE: successorReadyFile,
          TEST_RELEASE_FILE: successorReleaseFile,
        },
      );
      await waitFor(() => existsSync(successorReadyFile), "successor lock");
      const successorToken = readFileSync(lockFile, "utf8").split("\n")[4]?.trim();
      expect(successorToken).toBeTruthy();
      expect(successorToken).not.toBe(oldToken);

      // Reclaiming a stale lease terminates the old worker; it must not report success.
      expect(await staleOwner).toMatchObject({ code: 1 });
      expect(readFileSync(lockFile, "utf8").split("\n")[4]?.trim()).toBe(successorToken);

      writeFileSync(successorReleaseFile, "release");
      expect(await successor).toMatchObject({ code: 0 });
      expect(existsSync(lockFile)).toBe(false);
    } finally {
      writeFileSync(ownerReleaseFile, "release");
      writeFileSync(successorReleaseFile, "release");
      await staleOwner;
      if (successor) await successor;
    }
  });
});