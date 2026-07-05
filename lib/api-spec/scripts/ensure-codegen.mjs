/**
 * ensure-codegen: idempotent, cross-process-safe codegen guard for dev boot.
 *
 * Problem it solves:
 *   `parts-id` and `api-server` boot their dev workflows concurrently. The
 *   previous `predev` ran `orval` with `clean: true` on every boot, which
 *   deletes `lib/api-zod/src/generated/` (and the api-client-react generated
 *   dir) and then rewrites it. `api-server` imports `@workspace/api-zod` at
 *   startup; if it resolves the barrel during that clean-then-rewrite window,
 *   `export * from "./generated/api"` points at a missing file and the process
 *   dies with ERR_MODULE_NOT_FOUND.
 *
 * How this fixes it:
 *   - A file lock serializes codegen across all concurrently-booting workflows,
 *     so a destructive clean can never overlap another process' import.
 *   - A content hash of the codegen inputs (openapi.yaml + orval.config.ts +
 *     post-codegen.mjs) is compared against a persisted marker. When the spec
 *     is unchanged and all generated files are present, we skip `orval`
 *     entirely — a normal boot never cleans+rewrites the shared directory.
 *   - Only when the spec actually changed (or generated files are missing) do
 *     we run the real `codegen` (orval clean+rewrite + typecheck), and that run
 *     happens while holding the lock, so no other workflow imports mid-clean.
 */

import { spawnSync } from "node:child_process";
import {
  createHash,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiSpecDir = resolve(__dirname, "..");
const root = resolve(apiSpecDir, "..", "..");

const apiZodGen = resolve(root, "lib", "api-zod", "src", "generated");
const apiClientReactGen = resolve(
  root,
  "lib",
  "api-client-react",
  "src",
  "generated",
);

// Inputs whose contents fully determine the generated output.
const INPUT_FILES = [
  resolve(apiSpecDir, "openapi.yaml"),
  resolve(apiSpecDir, "orval.config.ts"),
  resolve(apiSpecDir, "post-codegen.mjs"),
];

// Files that must exist (and be non-empty) for a boot to be safe.
const REQUIRED_FILES = [
  resolve(apiZodGen, "api.ts"),
  resolve(apiClientReactGen, "api.ts"),
  resolve(apiClientReactGen, "api.schemas.ts"),
];

// Directories that must exist and contain at least one file.
const REQUIRED_NONEMPTY_DIRS = [resolve(apiZodGen, "types")];

const cacheDir = resolve(apiSpecDir, ".cache");
const markerPath = resolve(cacheDir, "codegen-marker.json");
const lockDir = resolve(cacheDir, "codegen.lock");

const LOCK_WAIT_TIMEOUT_MS = 600_000; // hard cap: fail loudly rather than wait forever
const LOCK_STALE_MS = 600_000; // last-resort steal when owner pid is unknowable
const POLL_INTERVAL_MS = 200;

function log(msg) {
  console.log(`[ensure-codegen] ${msg}`);
}

function sleepSync(ms) {
  // Synchronous sleep so the guard blocks predev until codegen is ready.
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

function computeInputHash() {
  const hash = createHash("sha256");
  for (const file of INPUT_FILES) {
    hash.update(file);
    hash.update("\0");
    try {
      hash.update(readFileSync(file));
    } catch {
      hash.update("<missing>");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

function generatedOutputPresent() {
  for (const file of REQUIRED_FILES) {
    try {
      if (statSync(file).size === 0) return false;
    } catch {
      return false;
    }
  }
  for (const dir of REQUIRED_NONEMPTY_DIRS) {
    try {
      if (readdirSync(dir).length === 0) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function readMarker() {
  try {
    return JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    return null;
  }
}

function writeMarker(hash) {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    markerPath,
    JSON.stringify({ hash, updatedAt: new Date().toISOString() }, null, 2),
  );
}

function inSync(hash) {
  const marker = readMarker();
  return !!marker && marker.hash === hash && generatedOutputPresent();
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true; // signal delivered — process exists
  } catch (err) {
    // EPERM means the process exists but we may not signal it — still alive.
    return err.code === "EPERM";
  }
}

function ownerIsDead() {
  // Decide whether the current lock holder has crashed and can be stolen.
  // Primary signal: the owner pid is no longer alive (reliable — same container).
  // Fallback: if the owner file is unreadable, only steal after LOCK_STALE_MS.
  let owner = null;
  try {
    owner = JSON.parse(readFileSync(resolve(lockDir, "owner"), "utf8"));
  } catch {
    owner = null;
  }
  if (owner && Number.isInteger(owner.pid)) {
    if (owner.pid === process.pid) return false;
    return !pidAlive(owner.pid);
  }
  // Owner unknown — fall back to a very generous age check.
  try {
    return Date.now() - statSync(lockDir).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/**
 * Acquire the codegen lock. Returns true only while the lock is held by this
 * process. Returns false ONLY when the hard timeout is exceeded while another
 * *live* process holds the lock — in that case the caller must NOT run codegen
 * (running unlocked would reintroduce the clean/import race).
 */
function acquireLock() {
  mkdirSync(cacheDir, { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(lockDir); // atomic: throws EEXIST if held
      writeFileSync(
        resolve(lockDir, "owner"),
        JSON.stringify({ pid: process.pid, at: Date.now() }),
      );
      return true;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      // Someone else holds the lock. Steal it only if the owner has crashed.
      if (ownerIsDead()) {
        log("stealing lock from a dead owner process");
        try {
          rmSync(lockDir, { recursive: true, force: true });
        } catch {
          /* another process may have cleaned it; retry */
        }
        continue;
      }
      if (Date.now() > deadline) {
        // A live process still holds the lock. Never run codegen unlocked.
        return false;
      }
      sleepSync(POLL_INTERVAL_MS);
    }
  }
}

function releaseLock() {
  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

function runCodegen() {
  log("spec changed or generated output missing — running codegen (orval)");
  const result = spawnSync("pnpm", ["run", "codegen"], {
    cwd: apiSpecDir,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `codegen failed with exit code ${result.status ?? "unknown"}`,
    );
  }
}

function main() {
  const hash = computeInputHash();

  // Fast path without the lock: already in sync, nothing to do.
  if (inSync(hash)) {
    log("generated api clients are up to date — skipping codegen");
    return;
  }

  const locked = acquireLock();
  if (!locked) {
    // We never got the lock (a live process held it past the hard timeout).
    // Running codegen unlocked would re-open the clean/import race, so we don't.
    // Best case, that other process already finished a valid regeneration.
    if (inSync(hash) || generatedOutputPresent()) {
      log(
        "another codegen holds the lock; generated output is present — proceeding without regenerating",
      );
      return;
    }
    throw new Error(
      "timed out waiting for another codegen to finish and no valid generated output is present",
    );
  }

  try {
    // Re-check under the lock: another process may have just regenerated.
    if (inSync(hash)) {
      log("generated api clients became up to date while waiting — skipping");
      return;
    }
    runCodegen();
    if (!generatedOutputPresent()) {
      throw new Error(
        "codegen completed but expected generated files are still missing",
      );
    }
    writeMarker(hash);
    log("codegen complete and generated output verified");
  } finally {
    releaseLock();
  }
}

main();
