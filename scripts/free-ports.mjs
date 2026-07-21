#!/usr/bin/env node
/**
 * free-ports.mjs — reliably free TCP ports before starting a server.
 *
 * TEMPLATE — adaptation points:
 *   1. PORTS: pass ports as CLI args, or hard-code a default list below.
 *   2. ENV GUARD: set FREE_PORTS_DISABLE=1 to make this script a no-op
 *      (rename the variable to suit your project; keep a guard so the sweep
 *      can never run recursively or in production).
 *   3. WRAPPER_COMMS: extend with any extra dev-server wrappers your stack
 *      uses (e.g. "deno", "bun", "turbo").
 *   4. --include-own-tree: only pass this flag BETWEEN serialized steps,
 *      when nothing in your own process tree should legitimately hold the
 *      swept ports (see comment at the flag below).
 *
 * Usage:
 *   node scripts/free-ports.mjs <port> [<port>...]
 *
 * For each port this script:
 *   1. Finds every process LISTENing on it (pure /proc parsing — no
 *      lsof/fuser dependency; `fuser` is often missing from PATH under Nix,
 *      and a silently no-op `fuser -k` is worse than nothing).
 *   2. Walks UP the parent chain through pnpm/npm/node/sh wrappers so the
 *      whole supervising tree dies, not just the socket holder (a bare
 *      port-kill leaves package-manager zombies that respawn or confuse
 *      later restarts). The climb stops before: PID 1, any ancestor of THIS
 *      process (so it can never kill its own workflow shell / test runner),
 *      and any process whose comm is not a known script-runner/shell wrapper.
 *   3. SIGTERMs the whole tree (root + descendants), waits up to 3 s, then
 *      SIGKILLs survivors, and finally waits (up to 5 s) until the port is
 *      confirmed free.
 *
 * It is a strict no-op when the port is already free, and never touches
 * processes outside the discovered holder trees.
 *
 * Process names are never trusted for holder discovery: the Nix Node.js
 * build reports its comm as "MainThread" rather than "node". Holders are
 * matched by socket inode via /proc/<pid>/fd.
 */
import { readFileSync, readdirSync, readlinkSync } from "node:fs";

// ── Env guard ───────────────────────────────────────────────────────────────
// FREE_PORTS_GUARD=1 makes the sweep a no-op. It guards against recursive
// execution (a swept process's restart command re-invoking the sweep) and
// lets callers disable the sweep entirely without editing scripts.
if (process.env.FREE_PORTS_GUARD === "1") {
  console.log("free-ports: FREE_PORTS_GUARD=1 — skipping sweep.");
  process.exit(0);
}
if (process.env.NODE_ENV === "production" || process.env.REPLIT_DEPLOYMENT === "1") {
  console.error("free-ports: refusing to run in production.");
  process.exit(2);
}

const argv = process.argv.slice(2);
// --include-own-tree: also kill holders that belong to this process's own
// ancestor tree (but never the ancestors themselves). Needed by serialized
// heavy-test runners: orphaned webServers from a finished step get
// reparented under a still-alive supervisor (a subreaper), so the normal
// own-tree exemption would wrongly protect them and the next step fails
// with "port already used". Only safe BETWEEN steps, when nothing in our
// tree should legitimately hold the swept ports.
const includeOwnTree = argv.includes("--include-own-tree");
const ports = argv
  .filter((a) => /^\d+$/.test(a))
  .map(Number)
  .filter((p) => p > 0 && p <= 65535);
if (ports.length === 0) {
  console.error("Usage: free-ports.mjs [--include-own-tree] <port> [<port>...]");
  process.exit(2);
}

// ── /proc helpers ───────────────────────────────────────────────────────────

/** Return { comm, ppid } for a pid, or null if it's gone. */
function statOf(pid) {
  let raw;
  try {
    raw = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  const close = raw.lastIndexOf(")");
  const comm = raw.slice(raw.indexOf("(") + 1, close);
  const rest = raw.slice(close + 2).split(" ");
  return { comm, ppid: Number(rest[1]) };
}

/**
 * Best-effort executable name for a pid: basename of argv[0] from
 * /proc/pid/cmdline, falling back to comm. Needed because the Nix Node.js
 * build reports comm as "MainThread" rather than "node".
 */
function execNameOf(pid) {
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    const argv0 = cmdline.split("\0")[0];
    if (argv0) return argv0.split("/").pop();
  } catch {
    // fall through
  }
  return statOf(pid)?.comm ?? "";
}

function allPids() {
  return readdirSync("/proc").filter((n) => /^\d+$/.test(n)).map(Number);
}

/** Set of inodes of sockets LISTENing on `port` (tcp4 + tcp6). */
function listeningInodes(port) {
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  const inodes = new Set();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10) continue;
      const [, local, , st] = cols;
      if (st !== "0A") continue; // LISTEN
      if (local.endsWith(`:${hexPort}`)) inodes.add(cols[9]);
    }
  }
  return inodes;
}

/** PIDs of processes holding a socket listening on `port`. */
function listenersOf(port) {
  const inodes = listeningInodes(port);
  if (inodes.size === 0) return [];
  const holders = [];
  for (const pid of allPids()) {
    let fds;
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue; // permission or gone
    }
    for (const fd of fds) {
      let link;
      try {
        link = readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      const m = link.match(/^socket:\[(\d+)\]$/);
      if (m && inodes.has(m[1])) {
        holders.push(pid);
        break;
      }
    }
  }
  return holders;
}

// ── Tree discovery ──────────────────────────────────────────────────────────

/** Ancestor chain of this script (inclusive) — never kill any of these. */
function selfAncestors() {
  const set = new Set();
  let pid = process.pid;
  while (pid > 1 && !set.has(pid)) {
    set.add(pid);
    const s = statOf(pid);
    if (!s) break;
    pid = s.ppid;
  }
  set.add(1);
  return set;
}

const PROTECTED = selfAncestors();

/**
 * A holder is "our own" if walking its parent chain reaches one of our
 * ancestors (other than PID 1) before hitting init. Example: Playwright
 * starts its webServer BEFORE globalSetup runs, so the current run's servers
 * are sibling subtrees under the same Playwright process — killing them
 * would sabotage the very run this sweep is protecting. Stale servers from a
 * dead previous run are reparented to PID 1 and therefore never match.
 */
function isOwnedByProtected(pid) {
  let current = pid;
  for (let i = 0; i < 64; i++) {
    const s = statOf(current);
    if (!s) return false;
    const parent = s.ppid;
    if (parent <= 1) return false;
    if (PROTECTED.has(parent)) return true;
    current = parent;
  }
  return false;
}

// Wrapper comms we are allowed to climb through / consider part of a stale
// dev-server tree. Anything else (workflow supervisors, editors, language
// servers, system daemons) is a hard boundary.
const WRAPPER_COMMS = new Set([
  "node", "sh", "bash", "dash", "pnpm", "npm", "npx", "tsx", "vite", "esbuild",
]);

function isWrapper(pid) {
  const s = statOf(pid);
  if (!s) return false;
  return WRAPPER_COMMS.has(s.comm) || WRAPPER_COMMS.has(execNameOf(pid));
}

/** Climb from a holder to the top of its pnpm/node wrapper chain. */
function treeRootOf(pid) {
  let current = pid;
  for (let i = 0; i < 32; i++) {
    const s = statOf(current);
    if (!s) return current;
    const parent = s.ppid;
    if (parent <= 1 || PROTECTED.has(parent)) return current;
    if (!isWrapper(parent)) return current;
    current = parent;
  }
  return current;
}

/** All descendants of `root` (inclusive), via a ppid map snapshot. */
function subtreeOf(root) {
  const children = new Map();
  for (const pid of allPids()) {
    const s = statOf(pid);
    if (!s) continue;
    if (!children.has(s.ppid)) children.set(s.ppid, []);
    children.get(s.ppid).push(pid);
  }
  const out = [];
  const queue = [root];
  while (queue.length > 0) {
    const pid = queue.pop();
    out.push(pid);
    for (const child of children.get(pid) ?? []) queue.push(child);
  }
  return out;
}

// ── Kill logic ──────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function signalAll(pids, signal) {
  for (const pid of pids) {
    if (PROTECTED.has(pid)) continue; // paranoid double-guard
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

async function waitPortFree(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (listeningInodes(port).size === 0) return true;
    await sleep(150);
  }
  return listeningInodes(port).size === 0;
}

async function freePort(port) {
  const holders = listenersOf(port);
  if (holders.length === 0) {
    if (listeningInodes(port).size > 0) {
      // Socket exists but holder is invisible (permissions). Nothing safe to do.
      console.error(`free-ports: port ${port} is LISTENing but no owning process is visible.`);
      return false;
    }
    return true; // no-op: port already free
  }

  const victims = new Set();
  for (const holder of holders) {
    if (PROTECTED.has(holder)) {
      console.error(`free-ports: refusing to kill own ancestor pid ${holder} holding port ${port}.`);
      return false;
    }
    if (!includeOwnTree && isOwnedByProtected(holder)) {
      console.log(
        `free-ports: port ${port} held by pid ${holder}, which belongs to this run's own process tree — leaving it alone.`,
      );
      continue;
    }
    const root = treeRootOf(holder);
    for (const pid of subtreeOf(root)) {
      if (!PROTECTED.has(pid)) victims.add(pid);
    }
  }

  if (victims.size === 0) {
    // Every holder belongs to this run's own process tree — nothing to kill.
    return true;
  }

  console.log(
    `free-ports: port ${port} held by pid(s) ${holders.join(", ")} — terminating tree (${victims.size} process(es)).`,
  );
  signalAll(victims, "SIGTERM");
  if (await waitPortFree(port, 3_000)) return true;

  console.log(`free-ports: port ${port} still bound after SIGTERM grace — escalating to SIGKILL.`);
  signalAll(victims, "SIGKILL");
  if (await waitPortFree(port, 5_000)) return true;

  console.error(`free-ports: FAILED to free port ${port}.`);
  return false;
}

let ok = true;
for (const port of ports) {
  // Sequential on purpose: overlapping tree-kills could race on shared parents.
  // eslint-disable-next-line no-await-in-loop
  ok = (await freePort(port)) && ok;
}
process.exit(ok ? 0 : 1);
