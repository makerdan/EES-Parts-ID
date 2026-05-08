#!/usr/bin/env node
// Reclaims $PORT before `expo start` so the Expo CLI never silently hops
// ports or hangs on its interactive port-conflict prompt. Linux-only: relies
// on /proc/net/tcp(6) and /proc/<pid>/fd/* because fuser/lsof/ss are not
// available in this artifact's Nix runtime.
//
// Operator note: this preflight will SIGTERM (then SIGKILL) ANY local process
// holding $PORT, not just a leftover Metro/Expo. That is intentional for the
// Replit dev workflow where $PORT is dedicated to this artifact, but be aware
// of it if you ever invoke this script in a shared environment.
const fs = require('fs');

const port = Number.parseInt(process.env.PORT ?? '', 10);
if (!Number.isFinite(port) || port <= 0 || port > 65535) {
  console.error(
    "[free-port] PORT env var is missing or not a valid port; refusing to start so expo can't fall back to an unintended port"
  );
  process.exit(1);
}

const portHex = port.toString(16).toUpperCase().padStart(4, '0');

function listenInodesForPort() {
  const inodes = new Set();
  for (const procPath of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let content;
    try {
      content = fs.readFileSync(procPath, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n').slice(1);
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 10) continue;
      const localAddress = parts[1];
      const state = parts[3];
      const inode = parts[9];
      if (state !== '0A') continue;
      const addrParts = localAddress.split(':');
      const addrPort = addrParts[addrParts.length - 1];
      if (!addrPort) continue;
      if (addrPort.toUpperCase() === portHex) {
        inodes.add(inode);
      }
    }
  }
  return inodes;
}

function pidsHoldingInodes(inodes) {
  const pids = new Set();
  if (inodes.size === 0) return pids;
  let entries;
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return pids;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let fds;
    try {
      fds = fs.readdirSync(`/proc/${entry}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let target;
      try {
        target = fs.readlinkSync(`/proc/${entry}/fd/${fd}`);
      } catch {
        continue;
      }
      const match = target.match(/^socket:\[(\d+)\]$/);
      if (match && inodes.has(match[1])) {
        pids.add(Number.parseInt(entry, 10));
        break;
      }
    }
  }
  return pids;
}

function tryKill(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function failHard(message) {
  console.error(`[free-port] ${message}`);
  process.exit(1);
}

(async () => {
  const initialInodes = listenInodesForPort();
  if (initialInodes.size === 0) {
    return;
  }

  const targets = [...pidsHoldingInodes(initialInodes)].filter((pid) => pid !== process.pid);

  if (targets.length === 0) {
    failHard(
      `port ${port} is already in use but no owning PID was found; refusing to start so expo doesn't silently hop to a different port`
    );
  }

  console.error(
    `[free-port] port ${port} is held by PID(s): ${targets.join(', ')}; sending SIGTERM`
  );
  for (const pid of targets) tryKill(pid, 'SIGTERM');

  let released = false;
  for (let i = 0; i < 15; i++) {
    await sleep(200);
    if (listenInodesForPort().size === 0) {
      released = true;
      break;
    }
  }

  if (!released) {
    console.error(`[free-port] port ${port} still held after SIGTERM; sending SIGKILL`);
    for (const pid of targets) tryKill(pid, 'SIGKILL');
    for (let i = 0; i < 10; i++) {
      await sleep(200);
      if (listenInodesForPort().size === 0) {
        released = true;
        break;
      }
    }
  }

  if (!released) {
    failHard(
      `port ${port} is still held after SIGKILL; refusing to start so expo doesn't silently hop to a different port`
    );
  }

  console.error(`[free-port] port ${port} released`);
})();
