#!/usr/bin/env node
/**
 * Repository boundary contract.
 *
 * The current tree is the merge-blocking surface. Reachable-history paths are
 * reported as remediation findings because removing them requires an owner-led
 * history rewrite; this check must not imply that such a rewrite happened.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getTierSteps } from "../validation-steps.mjs";
import {
  buildGitHubProtectionSnapshot,
  evaluateGitHubProtectionFreshness,
} from "../lib/github-validation-evidence.mjs";

const ROOT = join(fileURLToPath(new URL("../..", import.meta.url)));
const ALLOWED_ARCHIVES = new Set([
  "artifacts/failure-gate-skill.zip",
  "artifacts/task-triage-skill.zip",
]);
const PUBLIC_LAYOUT_PATH = "data/public/warehouse-zones.csv";
const SECURITY_POLICY_PATH = "SECURITY.md";
const DATA_CLASSIFICATION_PATH = "docs/public-data-classification.md";
const RELEASE_CHECKLIST_PATH = "docs/public-release-checklist.md";
const PROTECTION_STATUS_PATH = "docs/validation/github-protection-status.md";
const SAFE_EMAIL_DOMAINS = new Set([
  "example.com",
  "example.org",
  "example.net",
  "example.test",
  "test.invalid",
  "invalid",
  "localhost",
  "replit.local",
]);
const SAFE_EXAMPLE_VALUES = new Set([
  "dbname",
  "host",
  "__clerk_client_jwt",
  "password",
  "postgres",
  "user",
]);
const PUBLIC_LAYOUT_COLUMNS = [
  "aisle_key",
  "section",
  "is_inventory",
  "svg_x",
  "svg_y",
  "svg_width",
  "svg_height",
  "sort_order",
];
const PUBLIC_DATA_FILES = new Set([
  "data/public/README.md",
  PUBLIC_LAYOUT_PATH,
]);
const MAX_HISTORY_OBJECTS = 50_000;
const MAX_HISTORY_BLOB_BYTES = 64 * 1024 * 1024;
const MAX_HISTORY_SCAN_BYTES = 512 * 1024 * 1024;
const MAX_FINDINGS = 200;
const PROVIDER_PULL_REF_PATTERN = /^(?:refs\/pull\/\d+\/(?:head|merge)|refs\/remotes\/pull\/\d+\/(?:head|merge))$/;
const PROTECTION_REPOSITORY = "makerdan/EES-Parts-ID";
const PROTECTION_POLICY = {
  actions: {
    canApprovePullRequestReviews: false,
    defaultWorkflowPermissions: "read",
    shaPinningRequired: true,
  },
  branchProtection: {
    allowDeletions: false,
    allowForcePushes: false,
    enforceAdmins: true,
    requiredConversationResolution: true,
    requiredPullRequestReviews: true,
  },
  selectedActions: {
    githubOwnedAllowed: true,
    patterns: ["pnpm/action-setup@*"],
    policy: "selected",
    verifiedAllowed: false,
  },
  requiredChecks: ["CI / required"],
  strict: true,
};
const PROTECTION_PERMISSIONS = {
  actions: "read",
  contents: "read",
};

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

function gitOptional(args) {
  try {
    return git(args);
  } catch {
    return "";
  }
}

function gitIn(directory, args) {
  return execFileSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

function gitOptionalIn(directory, args) {
  try {
    return gitIn(directory, args);
  } catch {
    return "";
  }
}

function writeGitRaceShim({
  shimDirectory,
  repository,
  raceCommit,
  markerPath,
  targetRef,
  triggerRef,
  environmentPrefix,
  triggerAfterReadCount = 1,
  realGit,
}) {
  const gitShim = join(shimDirectory, "git");
  const envRepository = `${environmentPrefix}_REPO`;
  const envCommit = `${environmentPrefix}_COMMIT`;
  const envMarker = `${environmentPrefix}_MARKER`;
  const readCountPath = `${markerPath}.count`;
  writeFileSync(
    gitShim,
    `#!/usr/bin/env node
const { execFileSync, spawnSync } = require("node:child_process");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");

const realGit = ${JSON.stringify(realGit)};
const repository = ${JSON.stringify(repository)};
const raceCommit = ${JSON.stringify(raceCommit)};
const markerPath = ${JSON.stringify(markerPath)};
const readCountPath = ${JSON.stringify(readCountPath)};
const targetRef = ${JSON.stringify(targetRef)};
const triggerRef = ${JSON.stringify(triggerRef)};
const triggerAfterReadCount = ${JSON.stringify(triggerAfterReadCount)};
const args = process.argv.slice(2);
const result = spawnSync(realGit, args, { stdio: "inherit" });
const status = result.status ?? 1;

if (
  status === 0 &&
  process.env[${JSON.stringify(envRepository)}] === repository &&
  process.env[${JSON.stringify(envCommit)}] === raceCommit &&
  process.env[${JSON.stringify(envMarker)}] === markerPath &&
  !existsSync(markerPath) &&
  args.length === 5 &&
  args[0] === "-C" &&
  args[1] === repository &&
  args[2] === "rev-parse" &&
  args[3] === "--verify" &&
  args[4] === triggerRef
) {
  const readCount = Number.parseInt(existsSync(readCountPath) ? readFileSync(readCountPath, "utf8") : "0", 10) + 1;
  writeFileSync(readCountPath, String(readCount));
  if (readCount >= triggerAfterReadCount && !existsSync(markerPath)) {
    writeFileSync(markerPath, "triggered\\n");
    execFileSync(realGit, ["-C", repository, "update-ref", targetRef, raceCommit], { stdio: "inherit" });
  }
}

process.exit(status);
`,
  );
  chmodSync(gitShim, 0o755);
  return gitShim;
}

function writeGitLockOrderingShim({
  shimDirectory,
  repository,
  lockFile,
  beforeLockMarker,
  afterLockMarker,
  realGit,
}) {
  const gitShim = join(shimDirectory, "git");
  writeFileSync(
    gitShim,
    `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { existsSync, writeFileSync } = require("node:fs");

const realGit = ${JSON.stringify(realGit)};
const repository = ${JSON.stringify(repository)};
const lockFile = ${JSON.stringify(lockFile)};
const beforeLockMarker = ${JSON.stringify(beforeLockMarker)};
const afterLockMarker = ${JSON.stringify(afterLockMarker)};
const args = process.argv.slice(2);
const result = spawnSync(realGit, args, { stdio: "inherit" });
const status = result.status ?? 1;

if (
  status === 0 &&
  args.length === 5 &&
  args[0] === "-C" &&
  args[1] === repository &&
  args[2] === "rev-parse" &&
  args[3] === "--verify" &&
  args[4] === "HEAD^{commit}"
) {
  writeFileSync(existsSync(lockFile) ? afterLockMarker : beforeLockMarker, "observed\\n");
}

process.exit(status);
`,
  );
  chmodSync(gitShim, 0o755);
  return gitShim;
}

function createHistoryCheckoutFixture() {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "history-completeness-fixture-"));
  const sourceRepository = join(fixtureRoot, "source");
  const shallowCheckout = join(fixtureRoot, "shallow-checkout");
  const completeCheckout = join(fixtureRoot, "complete-checkout");

  try {
    gitIn(fixtureRoot, ["init", "--quiet", sourceRepository]);
    gitIn(sourceRepository, ["config", "user.email", "history-fixture@example.com"]);
    gitIn(sourceRepository, ["config", "user.name", "History Fixture"]);
    writeFileSync(
      join(sourceRepository, "ordinary-source.js"),
      [
        "const API_",
        'KEY = "history-secret-',
        'value-123456";\nexport const revision = "base";\n',
      ].join(""),
    );
    mkdirSync(join(sourceRepository, "exports"), { recursive: true });
    writeFileSync(join(sourceRepository, "exports", "customer.csv"), "customer,email\n1,private@example.test\n");
    gitIn(sourceRepository, ["add", "ordinary-source.js", "exports/customer.csv"]);
    gitIn(sourceRepository, ["commit", "--quiet", "-m", "base fixture revision"]);
    const baseCommit = gitIn(sourceRepository, ["rev-parse", "HEAD"]);
    writeFileSync(join(sourceRepository, "ordinary-source.js"), "export const revision = 'approved';\n");
    gitIn(sourceRepository, ["add", "ordinary-source.js"]);
    gitIn(sourceRepository, ["commit", "--quiet", "-m", "approved fixture revision"]);
    const approvedCommit = gitIn(sourceRepository, ["rev-parse", "HEAD"]);
    gitIn(sourceRepository, ["update-ref", "refs/pull/42/head", baseCommit]);
    const branchName = gitIn(sourceRepository, ["branch", "--show-current"]);
    const sourceUrl = pathToFileURL(sourceRepository).href;

    execFileSync("git", ["clone", "--quiet", "--depth", "1", sourceUrl, shallowCheckout], {
      cwd: ROOT,
      encoding: "utf8",
    });
    execFileSync("git", ["clone", "--quiet", sourceUrl, completeCheckout], {
      cwd: ROOT,
      encoding: "utf8",
    });
    gitIn(completeCheckout, ["update-ref", "refs/heads/review/approved", baseCommit]);

    return {
      root: fixtureRoot,
      shallowCheckout,
      completeCheckout,
      branchName,
      baseCommit,
      approvedCommit,
    };
  } catch (error) {
    rmSync(fixtureRoot, { recursive: true, force: true });
    throw error;
  }
}

function runSyncHelper(args, env = {}) {
  const effectiveArgs = [...args];
  if (effectiveArgs.includes("--verify") && !effectiveArgs.includes("--release-record")) {
    const repositoryIndex = effectiveArgs.indexOf("--repo");
    const repository =
      repositoryIndex >= 0 ? effectiveArgs[repositoryIndex + 1] : mkdtempSync(join(tmpdir(), "github-sync-records-"));
    const recordNumber = runSyncHelper.recordNumber++;
    effectiveArgs.push(
      "--release-id",
      `test-release-${recordNumber}`,
      "--release-record",
      join(repository, `.release-record-${recordNumber}.json`),
    );
  }
  const result = spawnSync("bash", [join(ROOT, "scripts/sync-github.sh"), ...effectiveArgs], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}
runSyncHelper.recordNumber = 1;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function trackedPaths() {
  return git(["ls-files", "-z"])
    .split("\0")
    .filter(Boolean)
    .filter((filePath) => existsSync(join(ROOT, filePath)));
}

function isSafeExample(value) {
  const normalized = value.trim();
  return (
    SAFE_EXAMPLE_VALUES.has(normalized.toLowerCase()) ||
    /^(?:x{6,}|fake(?:[-_].*)?|example(?:[-_].*)?|placeholder(?:[-_].*)?|replace(?:[-_]?me)?|your(?:[-_].*)?|test(?:[-_].*)?|jest(?:[-_].*)?|changeme|password)$/i.test(
      normalized,
    ) ||
    /^(?:sk|pk)_test_(?:fake(?:[-_].*)?|configured|abc123|workflow)$/i.test(normalized) ||
    /(?:^|_)x{6,}(?:$|[_-])/i.test(normalized)
  );
}

function pathFinding(filePath) {
  const normalized = filePath.replaceAll("\\", "/").toLowerCase();
  if (ALLOWED_ARCHIVES.has(normalized)) return null;
  if (normalized.startsWith(".agents/skills/.account-projections")) {
    return "generated account skill projection";
  }

  const segments = normalized.split("/");
  const privateDirectories = new Set([
    "attached_assets",
    "uploads",
    "upload",
    "storage",
    "backups",
    "backup",
    "dumps",
    "dump",
  ]);
  if (segments.some((segment) => privateDirectories.has(segment))) {
    return "private upload/storage/export directory";
  }
  if (segments[0] === "exports" || /(^|\/)inventory_export(?:[-_].*)?\./.test(normalized)) {
    return "operational or inventory export";
  }
  if (/(^|\/)warehouse[_-]zones[_-]backup(?:[-_].*)?\./.test(normalized)) {
    return "database-shaped warehouse backup";
  }
  if (/\.(?:sql\.gz|dump|bak|backup|sqlite|sqlite3|db|zip|7z|tar|tgz|gz)$/.test(normalized)) {
    return "database backup or archive";
  }
  if (/\.sql$/.test(normalized) && !normalized.startsWith("lib/db/drizzle/")) {
    return "SQL export outside the migration source directory";
  }
  if (/(?:^|\/)(?:debug|server|request|deployment)[-_].*\.log$/.test(normalized)) {
    return "generated operational log";
  }
  return null;
}

function readableText(filePath, content) {
  if (content !== undefined) return content;
  const bytes = readFileSync(join(ROOT, filePath));
  if (bytes.includes(0)) return null;
  return bytes.toString("utf8");
}

function parseCsvLine(line) {
  const fields = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      fields.push(field);
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) return null;
  fields.push(field);
  return fields;
}

function publicDataFindings(filePath, content) {
  const normalized = filePath.replaceAll("\\", "/");
  if (!normalized.toLowerCase().startsWith("data/public/")) return [];
  if (!PUBLIC_DATA_FILES.has(normalized)) return ["unapproved public-data path or file type"];
  if (normalized === "data/public/README.md") return [];

  const text = readableText(filePath, content);
  if (text === null) return ["public layout is not valid UTF-8 CSV"];
  const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length < 2) return ["public layout is empty"];

  const header = parseCsvLine(lines[0]);
  if (
    !header ||
    header.length !== PUBLIC_LAYOUT_COLUMNS.length ||
    header.some((column, index) => column !== PUBLIC_LAYOUT_COLUMNS[index])
  ) {
    return ["public layout schema is not approved"];
  }

  const findings = [];
  for (const [lineIndex, line] of lines.slice(1).entries()) {
    const values = parseCsvLine(line);
    if (!values || values.length !== PUBLIC_LAYOUT_COLUMNS.length) {
      findings.push(`public layout row ${lineIndex + 2} has the wrong column count`);
      continue;
    }
    const row = Object.fromEntries(
      PUBLIC_LAYOUT_COLUMNS.map((column, index) => [column, values[index].trim()]),
    );
    if (!/^aisle-\d+$/.test(row.aisle_key)) findings.push("public layout aisle_key has an invalid value type");
    if (row.section !== "" && !/^\d+$/.test(row.section)) {
      findings.push("public layout section has an invalid value type");
    }
    if (!/^[tf]$/.test(row.is_inventory)) {
      findings.push("public layout is_inventory has an invalid value type");
    }
    for (const column of ["svg_x", "svg_y", "svg_width", "svg_height"]) {
      const value = Number(row[column]);
      if (!Number.isFinite(value) || value < 0 || row[column] === "") {
        findings.push(`public layout ${column} has an invalid value type`);
      }
    }
    if (!/^\d+$/.test(row.sort_order)) {
      findings.push("public layout sort_order has an invalid value type");
    }
  }
  return [...new Set(findings)];
}

function contentFindingRecords(filePath, content) {
  const text = readableText(filePath, content);
  if (text === null) return [];

  const findings = [];
  const add = (kind) => findings.push({ filePath, kind });

  if (/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(text)) add("private key material");
  for (const [kind, pattern] of [
    ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/g],
    ["Google API key", /\bAIza[0-9A-Za-z_-]{20,}\b/g],
    ["GitHub token", /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g],
    ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
    ["Clerk/OpenAI-style key", /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9_-]{20,}\b/g],
  ]) {
    for (const match of text.matchAll(pattern)) {
      const publicClerkKey = kind === "Clerk/OpenAI-style key" && /^pk_(?:test|live)_/.test(match[0]);
      if (!isSafeExample(match[0]) && !publicClerkKey) add(kind);
    }
  }

  for (const match of text.matchAll(/\b(?:postgres(?:ql)?):\/\/([^:\s/]+):([^@\s]+)@/gi)) {
    if (!isSafeExample(match[1]) || !isSafeExample(match[2])) {
      add("database credential in connection URL");
    }
  }

  for (const match of text.matchAll(
    /\b(?:API_KEY|SECRET(?:_KEY)?|PASSWORD|ACCESS_TOKEN|AUTH_TOKEN|DATABASE_URL|(?:CLERK|GITHUB|OPENAI|POE|AWS)_[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))\s*[:=]\s*(?:"([^"]+)"|'([^']+)'|([a-z0-9][a-z0-9._-]{15,}))/g,
  )) {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    const assignment = match[0].split(/[:=]/, 1)[0].trim();
    const publicClerkKey = /PUBLISHABLE_KEY$/.test(assignment) && /^pk_(?:test|live)_/.test(value);
    if (
      value &&
      !isSafeExample(value) &&
      !publicClerkKey &&
      !value.startsWith("process.env") &&
      !value.startsWith("$")
    ) {
      add("credential-shaped assignment");
    }
  }

  const packageMetadata = /(?:^|\/)(?:package\.json|pnpm-lock\.yaml)$/.test(filePath);
  if (!packageMetadata) {
    for (const match of text.matchAll(/\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g)) {
      const domain = match[1].toLowerCase();
      const reservedDomain =
        SAFE_EMAIL_DOMAINS.has(domain) ||
        domain.endsWith(".example") ||
        domain.endsWith(".test") ||
        domain.endsWith(".invalid");
      if (!reservedDomain) {
        add("non-synthetic email address");
      }
    }
  }

  if (/(^|\/)(?:fixtures?|seeds?)\//i.test(filePath) && /\b(?:clerk_)?user_[A-Za-z0-9]{15,}\b/.test(text)) {
    add("non-synthetic user fixture identifier");
  }
  return findings;
}

function formatFinding({ filePath, kind }, historical = false) {
  return `${historical ? "historical blob" : filePath}: ${kind}`;
}

function boundedDiagnostics(findings) {
  const lines = [];
  let bytes = 0;
  for (const finding of findings) {
    const line = `  - ${finding}`;
    if (lines.length >= MAX_FINDINGS || bytes + line.length > 12_000) break;
    lines.push(line);
    bytes += line.length;
  }
  if (lines.length < findings.length) {
    lines.push(`  - ${findings.length - lines.length} additional finding(s) omitted.`);
  }
  return lines.join("\n");
}

function contentFindings(filePath, content) {
  return contentFindingRecords(filePath, content).map((finding) => formatFinding(finding));
}

function listValues(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return String(value ?? "")
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function refObjectMap(refLines) {
  return new Map(
    refLines
      .split("\n")
      .map((line) => line.trim().split(/\s+/, 2))
      .filter(([ref, objectName]) => ref && objectName)
      .map(([ref, objectName]) => [ref, objectName]),
  );
}

function refCandidates(refName) {
  const candidates = [refName];
  if (refName.startsWith("refs/heads/")) {
    candidates.push(`refs/remotes/origin/${refName.slice("refs/heads/".length)}`);
  }
  if (refName.startsWith("refs/pull/")) {
    candidates.push(`refs/remotes/pull/${refName.slice("refs/pull/".length)}`);
  }
  return candidates;
}

function requiredRefObject(refsByName, refName) {
  return refCandidates(refName).map((candidate) => refsByName.get(candidate)).find(Boolean);
}

function historyRefKind(refName) {
  if (PROVIDER_PULL_REF_PATTERN.test(refName)) return "provider-retained pull-request ref";
  if (
    refName.startsWith("refs/heads/") ||
    /^refs\/remotes\/[^/]+\/(?:heads\/)?/.test(refName)
  ) {
    return "branch head";
  }
  return "other public ref";
}

function historyRefNames(repository) {
  return gitOptionalIn(repository, ["for-each-ref", "--format=%(refname)"]).split("\n").filter(Boolean);
}

export function fetchProviderPullRefs(repository = ROOT, expectedOrigin) {
  const origin = gitOptionalIn(repository, ["config", "--get", "remote.origin.url"]);
  const trustedOrigin = expectedOrigin
    ? origin === expectedOrigin
    : /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)makerdan\/EES-Parts-ID(?:\.git)?\/?$/.test(origin);
  assert(trustedOrigin, "Public repository history scan is incomplete: origin is not the expected GitHub repository.");
  try {
    execFileSync("git", ["-C", repository, "fetch", "--prune", "--no-tags", "origin", "+refs/pull/*/head:refs/pull/*/head"], {
      encoding: "utf8",
      stdio: "pipe",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    throw new Error("Public repository history scan is incomplete: cannot fetch provider-retained pull-request refs from origin; check GitHub access.");
  }
}

export function historyCompleteness({
  repository = ROOT,
  shallow,
  refs,
  head,
  replaceRefs,
  promisor,
  requiredRefs,
  requiredCommit,
} = {}) {
  const isShallow =
    shallow ?? gitOptionalIn(repository, ["rev-parse", "--is-shallow-repository"]).trim() === "true";
  const refLines =
    refs ?? gitOptionalIn(repository, ["for-each-ref", "--format=%(refname) %(objectname)"]).trim();
  const headOid = head ?? gitOptionalIn(repository, ["rev-parse", "--verify", "HEAD"]).trim();
  const hasReplaceRefs = replaceRefs ?? gitOptionalIn(repository, ["replace", "-l"]).trim();
  const hasPromisor =
    promisor ?? gitOptionalIn(repository, ["config", "--get-regexp", "remote\\..*\\.promisor"]).trim();
  const refsByName = refObjectMap(refLines);
  const requiredRefNames = listValues(requiredRefs ?? process.env.BOUNDARY_REQUIRED_REF);
  const expectedCommit = requiredCommit ?? process.env.BOUNDARY_REQUIRED_COMMIT?.trim();
  const refNames = [...refsByName.keys()];
  const hasBranchHead = refNames.some((refName) => historyRefKind(refName) === "branch head");
  const hasProviderPullRefs = refNames.some((refName) => historyRefKind(refName) === "provider-retained pull-request ref");
  const reasons = [];
  if (isShallow) reasons.push("shallow checkout");
  if (refsByName.size === 0) reasons.push("no complete ref set");
  if (!hasBranchHead) reasons.push("branch heads are absent from the fetched ref set");
  if (!hasProviderPullRefs) reasons.push("provider-retained pull-request refs are absent from the fetched ref set");
  if (!headOid) reasons.push("missing HEAD");
  if (headOid && refsByName.size > 0 && ![...refsByName.values()].includes(headOid)) {
    reasons.push("HEAD is not present in the fetched ref set");
  }
  if (requiredRefNames.some((refName) => !requiredRefObject(refsByName, refName))) {
    reasons.push("required ref is absent");
  }
  if (expectedCommit && headOid !== expectedCommit) {
    reasons.push("required commit does not match HEAD");
  }
  if (
    expectedCommit &&
    requiredRefNames
      .map((refName) => requiredRefObject(refsByName, refName))
      .some((refObject) => refObject && refObject !== expectedCommit)
  ) {
    reasons.push("required ref does not point to the required commit");
  }
  if (hasReplaceRefs) reasons.push("replace refs are active");
  if (hasPromisor) reasons.push("partial clone promises are active");
  return { complete: reasons.length === 0, reasons };
}

export function historyObjects(repository = ROOT) {
  const refNames = historyRefNames(repository);
  const recordsByObject = new Map();
  for (const refName of refNames) {
    const refKind = historyRefKind(refName);
    const lines = gitOptionalIn(repository, ["rev-list", "--objects", refName]).split("\n").filter(Boolean);
    for (const line of lines) {
      const separator = line.indexOf(" ");
      const oid = separator === -1 ? line : line.slice(0, separator);
      const filePath = separator === -1 ? "" : line.slice(separator + 1);
      const existing = recordsByObject.get(oid);
      if (existing) {
        if (!existing.refKinds.includes(refKind)) existing.refKinds.push(refKind);
        if (!existing.filePath && filePath) existing.filePath = filePath;
      } else {
        recordsByObject.set(oid, { oid, filePath, refKinds: [refKind] });
      }
    }
  }
  const lines = [...recordsByObject.values()];
  if (lines.length > MAX_HISTORY_OBJECTS) {
    return { bounded: false, reason: "reachable object count exceeds scan limit", records: [] };
  }
  const records = lines;
  if (records.length === 0) return { bounded: true, records: [] };
  const checks = execFileSync("git", ["-C", repository, "cat-file", "--batch-check"], {
    input: `${records.map(({ oid }) => oid).join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const metadata = checks.split("\n").filter(Boolean).map((line) => line.split(" "));
  return {
    bounded: true,
    records: records.map((record, index) => ({
      ...record,
      type: metadata[index]?.[1] ?? "unknown",
      size: Number(metadata[index]?.[2] ?? Number.POSITIVE_INFINITY),
    })),
  };
}

export function scanHistoricalContentEntries(entries) {
  const findings = [];
  for (const { filePath, content } of entries) {
    for (const finding of contentFindingRecords(filePath, content)) {
      if (findings.length < MAX_FINDINGS) findings.push(formatFinding(finding, true));
    }
  }
  return findings;
}

export function scanHistoricalPathEntries(entries) {
  return [...new Set(entries.map(({ filePath }) => pathFinding(filePath)).filter(Boolean))].sort();
}

export function scanHistoryContents(records, repository = ROOT) {
  const blobs = records.filter(({ type, size }) => type === "blob");
  const selected = [];
  let totalBytes = 0;
  let skipped = 0;
  for (const record of blobs) {
    if (record.size > MAX_HISTORY_BLOB_BYTES || totalBytes + record.size > MAX_HISTORY_SCAN_BYTES) {
      skipped += 1;
      continue;
    }
    selected.push(record);
    totalBytes += record.size;
  }
  if (skipped > 0) {
    return {
      complete: false,
      scannedBlobs: 0,
      skippedBlobs: skipped,
      findings: ["historical blob scan exceeded its bounded content budget"],
    };
  }
  if (selected.length === 0) return { complete: true, scannedBlobs: 0, skippedBlobs: 0, findings: [] };

  const output = execFileSync("git", ["-C", repository, "cat-file", "--batch"], {
    input: `${selected.map(({ oid }) => oid).join("\n")}\n`,
    maxBuffer: MAX_HISTORY_SCAN_BYTES + 64 * 1024 * 1024,
  });
  let offset = 0;
  const findings = [];
  let scannedBlobs = 0;
  for (const record of selected) {
    const headerEnd = output.indexOf(10, offset);
    if (headerEnd === -1) {
      return { complete: false, scannedBlobs, skippedBlobs: 0, findings: ["historical blob output was truncated"] };
    }
    const [oid, type, sizeText] = output.toString("utf8", offset, headerEnd).split(" ");
    const size = Number(sizeText);
    offset = headerEnd + 1;
    const body = output.subarray(offset, offset + size);
    offset += size + 1;
    if (oid !== record.oid || type !== "blob" || body.length !== size) {
      return { complete: false, scannedBlobs, skippedBlobs: 0, findings: ["historical blob output was inconsistent"] };
    }
    scannedBlobs += 1;
    if (body.includes(0)) continue;
      const entryFindings = scanHistoricalContentEntries([
        { filePath: record.filePath, content: body.toString("utf8") },
      ]);
      for (const finding of entryFindings) {
        for (const refKind of record.refKinds ?? ["historical blob"]) {
          if (findings.length >= MAX_FINDINGS) break;
          findings.push(`${refKind}: ${finding.replace(/^historical blob: /, "")}`);
        }
      }
  }
  return { complete: true, scannedBlobs, skippedBlobs: 0, findings };
}

export function assertProtectionControlStatuses(document, current) {
  const controlRows = [...document.matchAll(/^\| ([^|\n]+) \| `(verified|stale|unverified|owner-action-required)` \|/gm)];
  assert(controlRows.length === 13, "protection status must classify every provider control");
  if (current) {
    for (const control of ["Secret scanning", "Push protection", "Dependency alerts"]) {
      assert(controlRows.some((row) => row[1] === control && row[2] === "verified"),
        `current protection status must verify ${control}`);
    }
  } else {
    assert(controlRows.every((row) => row[2] === "stale"),
      "stale protection evidence cannot support a current or verified control claim");
    assert(/none of these\s+controls is verified for the current checkout/.test(document),
      "stale protection status must explicitly refuse current release approval");
  }
}

export function assertReleaseDocumentation() {
  const security = readFileSync(join(ROOT, SECURITY_POLICY_PATH), "utf8");
  const classification = readFileSync(join(ROOT, DATA_CLASSIFICATION_PATH), "utf8");
  const checklist = readFileSync(join(ROOT, RELEASE_CHECKLIST_PATH), "utf8");
  const readiness = readFileSync(join(ROOT, "docs/public-repository-readiness.md"), "utf8");
  const protectionStatus = readFileSync(join(ROOT, PROTECTION_STATUS_PATH), "utf8");
  const coverage = readFileSync(join(ROOT, "docs/validation/github-actions-coverage.md"), "utf8");
  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");

  for (const phrase of [
    "fetch-depth: 0",
    "fetch-tags: true",
    "refs/pull/*/head:refs/pull/*/head",
    "BOUNDARY_REQUIRED_REF",
    "BOUNDARY_REQUIRED_COMMIT",
  ]) {
    assert(ci.includes(phrase), `CI history checkout is missing "${phrase}"`);
  }

  for (const heading of ["Supported versions", "Reporting a vulnerability", "Secret and credential handling", "Clerk and Replit boundaries"]) {
    assert(security.includes(`## ${heading}`), `security policy is missing "${heading}"`);
  }
  for (const phrase of ["public map/layout data", "Replit Secrets", "database exports", "uploaded files", "Do not commit"]) {
    assert(security.toLowerCase().includes(phrase.toLowerCase()), `security policy is missing "${phrase}"`);
  }

  for (const phrase of ["Public source", "Public layout reference", "Private runtime data", "Private uploaded objects", "Secret material", "Replit-hosted PostgreSQL"]) {
    assert(classification.includes(phrase), `data classification is missing "${phrase}"`);
  }

  for (const phrase of [
    "public-repository-boundary.test.mjs",
    "routeAuthorizationMatrix.integration.test.ts",
    "privateObjectAccess.integration.test.ts",
    "publicWarehouseLayout.integration.test.ts",
    "tracked-tree and history scan",
    "Secret scanning",
    "owner-action-required",
  ]) {
    assert(checklist.includes(phrase), `release checklist is missing "${phrase}"`);
  }
  for (const phrase of [
    "POLICY_REFUSAL",
    "VERIFIED_SYNCHRONIZATION",
    "VERIFICATION_FAILURE",
    "--locked-verify",
    "public-release",
    "coordination lock",
    "--verify",
    "--approved-commit",
    "approved commit ID",
    "--release-id",
    "--release-record",
    "approved_commit_id",
    "verification_status",
  ]) {
    assert(checklist.includes(phrase), `release checklist is missing sync state "${phrase}"`);
    assert(readiness.includes(phrase), `repository readiness is missing sync state "${phrase}"`);
  }

  const statusValues = [...protectionStatus.matchAll(/`(verified|owner-action-required|unverified)`/g)].map((match) => match[1]);
  assert(statusValues.includes("verified"), "protection status does not define verified controls");
  assert(statusValues.includes("unverified"), "protection status does not define unverified evidence");
  for (const control of ["Secret scanning", "Push protection", "Dependency alerts", "Required validation"]) {
    assert(protectionStatus.includes(`| ${control} |`), `protection status is missing "${control}"`);
  }

  const targetRepository = protectionStatus.match(/^\*\*Target repository:\*\*\s+`([^`]+)`\s*$/m)?.[1];
  const targetRevision = protectionStatus.match(/^\*\*Target revision SHA:\*\*\s+`([^`]+)`\s*$/m)?.[1];
  const policyText = protectionStatus.match(/^\*\*Policy context:\*\*\s+`([^`]+)`\s*$/m)?.[1];
  const permissionsText = protectionStatus.match(/^\*\*Permission context:\*\*\s+`([^`]+)`\s*$/m)?.[1];
  const freshnessResult = protectionStatus.match(/^\*\*Freshness result:\*\*\s+`([^`]+)`\s*$/m)?.[1];
  assert(targetRepository, "protection status is missing target repository identity");
  assert(targetRevision, "protection status is missing target revision SHA");
  assert(policyText, "protection status is missing policy context");
  assert(permissionsText, "protection status is missing permission context");
  assert(freshnessResult, "protection status is missing freshness result");

  let policy;
  let permissions;
  try {
    policy = JSON.parse(policyText);
    permissions = JSON.parse(permissionsText);
  } catch {
    throw new Error("protection status policy and permission contexts must be valid JSON");
  }
  const currentContext = {
    repository: PROTECTION_REPOSITORY,
    revisionSha: git(["rev-parse", "--verify", "HEAD^{commit}"]).trim(),
    policy: PROTECTION_POLICY,
    permissions: PROTECTION_PERMISSIONS,
  };
  let snapshot;
  try {
    snapshot = buildGitHubProtectionSnapshot({
      repository: targetRepository,
      revisionSha: targetRevision,
      policy,
      permissions,
      capabilities: {},
      controls: {},
      capturedAt: protectionStatus.match(/^\*\*Assessment date:\*\*\s+([^\s]+)\s*$/m)?.[1],
    });
  } catch (error) {
    throw new Error(`protection status snapshot is incomplete: ${error.message}`);
  }
  const freshness = evaluateGitHubProtectionFreshness(snapshot, currentContext);
  assert(freshnessResult === freshness.status, "protection status freshness result does not match its evidence context");
  assertProtectionControlStatuses(protectionStatus, freshness.current);
  assert(targetRepository === PROTECTION_REPOSITORY, "protection status targets the wrong repository");
  if (freshness.current) {
    assert(targetRevision === currentContext.revisionSha, "protection status targets a stale repository revision");
    assert(JSON.stringify(policy) === JSON.stringify(PROTECTION_POLICY), "protection status policy context is not the release policy");
    assert(JSON.stringify(permissions) === JSON.stringify(PROTECTION_PERMISSIONS),
      "protection status permission context is not the read-only release context");
  }

  const boundaryStep = getTierSteps("fast").find(([name]) => name === "public-repository-boundary");
  assert(boundaryStep?.[1] === "node scripts/test/public-repository-boundary.test.mjs", "boundary guard is not registered in test-fast");
  assert(coverage.includes("| public-repository-boundary | `CI / required` → `pnpm run test-standard-plus`"), "boundary guard is not mapped to the existing GitHub validation path");
  assert((ci.match(/pnpm run test-standard-plus/g) ?? []).length === 1, "CI duplicates or omits the canonical validation tier");
}

export function assertSyncHelperFailsClosed() {
  const legacyNoOp = runSyncHelper([]);
  assert(legacyNoOp.status === 2, "legacy no-argument helper call did not return policy-refusal status");
  assert(legacyNoOp.output.includes("POLICY_REFUSAL"), "legacy no-argument refusal was not labeled");

  const directSync = runSyncHelper(["--sync"]);
  assert(directSync.status === 2, "direct GitHub synchronization did not return policy-refusal status");
  assert(directSync.output.includes("POLICY_REFUSAL"), "direct synchronization refusal was not labeled");

  const repository = mkdtempSync(join(tmpdir(), "github-sync-contract-"));
  try {
    gitIn(repository, ["init", "--quiet"]);
    gitIn(repository, ["config", "user.email", "contract@example.com"]);
    gitIn(repository, ["config", "user.name", "Boundary Contract"]);
    writeFileSync(join(repository, "README.md"), "approved snapshot\n");
    gitIn(repository, ["add", "README.md"]);
    gitIn(repository, ["commit", "--quiet", "-m", "approved snapshot"]);
    const approvedCommit = gitIn(repository, ["rev-parse", "HEAD"]);
    const currentBranch = gitIn(repository, ["branch", "--show-current"]);
    gitIn(repository, ["update-ref", "refs/heads/snapshot/approved", approvedCommit]);

    const lockedReleaseRecordPath = join(repository, "locked-release", "release.json");
    const lockedVerified = runSyncHelper([
      "--locked-verify",
      "--repo",
      repository,
      "--approved-ref",
      "refs/heads/snapshot/approved",
      "--approved-commit",
      approvedCommit,
      "--release-id",
      "locked-release",
      "--release-record",
      lockedReleaseRecordPath,
    ]);
    assert(lockedVerified.status === 0, `locked verification did not pass: ${lockedVerified.output}`);
    assert(lockedVerified.output.includes("VERIFIED_SYNCHRONIZATION"), "locked verification was not labeled");
    assert(existsSync(lockedReleaseRecordPath), "locked verification did not publish its release record");
    assert(
      JSON.parse(readFileSync(lockedReleaseRecordPath, "utf8")).workspace_revision === approvedCommit,
      "locked verification did not capture the immutable workspace revision",
    );

    const orderingRealGit = execFileSync("bash", ["-lc", "command -v git"], { encoding: "utf8" }).trim();
    const orderingShimDirectory = mkdtempSync(join(tmpdir(), "github-sync-lock-ordering-shim-"));
    const orderingLockFile = join(repository, "ordering-release.lock");
    const beforeLockMarker = join(orderingShimDirectory, "head-read-before-lock");
    const afterLockMarker = join(orderingShimDirectory, "head-read-after-lock");
    writeGitLockOrderingShim({
      shimDirectory: orderingShimDirectory,
      repository,
      lockFile: orderingLockFile,
      beforeLockMarker,
      afterLockMarker,
      realGit: orderingRealGit,
    });
    const orderedLockedVerification = runSyncHelper(
      [
        "--locked-verify",
        "--repo",
        repository,
        "--approved-ref",
        "refs/heads/snapshot/approved",
        "--approved-commit",
        approvedCommit,
        "--release-id",
        "ordered-locked-release",
        "--release-record",
        join(repository, "ordered-locked-release", "release.json"),
      ],
      {
        PATH: `${orderingShimDirectory}:${process.env.PATH ?? ""}`,
        SERIAL_LOCK_FILE: orderingLockFile,
      },
    );
    assert(
      orderedLockedVerification.status === 0,
      `ordered locked verification did not pass: ${orderedLockedVerification.output}`,
    );
    assert(!existsSync(beforeLockMarker), "locked verification read HEAD before acquiring the coordination lock");
    assert(existsSync(afterLockMarker), "locked verification did not read HEAD while holding the coordination lock");

    const blockedLockFile = join(repository, "blocked-release.lock");
    const blockedReleaseRecordPath = join(repository, "blocked-release", "release.json");
    const blockedBeforeLockMarker = join(orderingShimDirectory, "blocked-head-read-before-lock");
    const blockedAfterLockMarker = join(orderingShimDirectory, "blocked-head-read-after-lock");
    writeGitLockOrderingShim({
      shimDirectory: orderingShimDirectory,
      repository,
      lockFile: blockedLockFile,
      beforeLockMarker: blockedBeforeLockMarker,
      afterLockMarker: blockedAfterLockMarker,
      realGit: orderingRealGit,
    });
    const blockedVerification = spawnSync(
      "flock",
      [
        "--exclusive",
        `${blockedLockFile}.guard`,
        "bash",
        join(ROOT, "scripts/sync-github.sh"),
        "--locked-verify",
        "--repo",
        repository,
        "--approved-ref",
        "refs/heads/snapshot/approved",
        "--approved-commit",
        approvedCommit,
        "--release-id",
        "blocked-release",
        "--release-record",
        blockedReleaseRecordPath,
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          SERIAL_LOCK_FILE: blockedLockFile,
          SERIAL_LOCK_TIMEOUT_MS: "25",
          SERIAL_LOCK_POLL_MS: "5",
          PATH: `${orderingShimDirectory}:${process.env.PATH ?? ""}`,
        },
      },
    );
    const blockedOutput = `${blockedVerification.stdout ?? ""}${blockedVerification.stderr ?? ""}`;
    assert(blockedVerification.status !== 0, "verification succeeded while repository lock acquisition was blocked");
    assert(
      blockedOutput.includes("[serial-lock]") &&
        blockedOutput.includes("timed out") &&
        blockedOutput.includes("public-release"),
      "lock acquisition failure was not explicit",
    );
    assert(!blockedOutput.includes("VERIFIED_SYNCHRONIZATION"), "blocked verification reported synchronization success");
    assert(!existsSync(blockedReleaseRecordPath), "blocked verification produced release evidence");
    assert(!existsSync(blockedBeforeLockMarker), "blocked verification read HEAD before acquiring the coordination lock");
    assert(!existsSync(blockedAfterLockMarker), "blocked verification read HEAD despite failing to acquire the coordination lock");

    const verified = runSyncHelper([
      "--verify",
      "--repo",
      repository,
      "--expected-revision",
      approvedCommit,
      "--approved-ref",
      "refs/heads/snapshot/approved",
      "--approved-commit",
      approvedCommit,
      "--release-id",
      "release-approval-identity",
      "--release-record",
      join(repository, "release-approval-identity.json"),
    ]);
    assert(verified.status === 0, "exact approved snapshot tree did not verify");
    assert(verified.output.includes("VERIFIED_SYNCHRONIZATION"), "verified synchronization was not labeled");
    assert(verified.output.includes(`approved commit ${approvedCommit}`), "immutable approved commit was not recorded");
    const releaseRecordPath = join(repository, "release-approval-identity.json");
    const releaseRecord = JSON.parse(readFileSync(releaseRecordPath, "utf8"));
    assert(releaseRecord.release_id === "release-approval-identity", "release record is not tied to the reviewed release");
    assert(releaseRecord.approved_ref === "refs/heads/snapshot/approved", "release record lost the approved ref");
    assert(releaseRecord.approved_commit_id === approvedCommit, "release record lost the approved commit identity");
    assert(releaseRecord.workspace_revision === approvedCommit, "release record lost the workspace revision");
    assert(
      releaseRecord.verification_status === "VERIFIED_SYNCHRONIZATION",
      "release record lost the successful verification status",
    );
    assert((statSync(releaseRecordPath).mode & 0o222) === 0, "release record was not made read-only");
    const immutableRecord = readFileSync(releaseRecordPath, "utf8");
    const repeatedVerification = runSyncHelper([
      "--verify",
      "--repo",
      repository,
      "--expected-revision",
      approvedCommit,
      "--approved-ref",
      "refs/heads/snapshot/approved",
      "--approved-commit",
      approvedCommit,
      "--release-id",
      "release-approval-identity",
      "--release-record",
      releaseRecordPath,
    ]);
    assert(repeatedVerification.status === 3, "later verification overwrote an existing release record");
    assert(
      repeatedVerification.output.includes("release record already exists"),
      "existing release record was not protected",
    );
    assert(readFileSync(releaseRecordPath, "utf8") === immutableRecord, "release record changed after later verification");

    writeFileSync(join(repository, "README.md"), "different workspace tree\n");
    gitIn(repository, ["add", "README.md"]);
    gitIn(repository, ["commit", "--quiet", "-m", "different workspace tree"]);
    const mismatchedRevision = gitIn(repository, ["rev-parse", "HEAD"]);
    const mismatch = runSyncHelper([
      "--verify",
      "--repo",
      repository,
      "--expected-revision",
      mismatchedRevision,
      "--approved-ref",
      "refs/heads/snapshot/approved",
      "--approved-commit",
      approvedCommit,
    ]);
    assert(mismatch.status === 3, "mismatched tree did not return verification-failure status");
    assert(mismatch.output.includes("VERIFICATION_FAILURE"), "tree mismatch was not labeled");
    assert(!mismatch.output.includes("VERIFIED_SYNCHRONIZATION"), "tree mismatch was reported as verified");

    const staleExpectedRevision = runSyncHelper([
      "--verify",
      "--repo",
      repository,
      "--expected-revision",
      approvedCommit,
      "--approved-ref",
      "refs/heads/snapshot/approved",
      "--approved-commit",
      approvedCommit,
    ]);
    assert(staleExpectedRevision.status === 3, "stale expected revision did not return verification-failure status");
    assert(staleExpectedRevision.output.includes("expected revision is stale"), "stale expected revision was not classified");
    assert(staleExpectedRevision.output.includes("selected repository workspace"), "stale revision diagnostic did not identify the workspace");
    assert(!staleExpectedRevision.output.includes("VERIFIED_SYNCHRONIZATION"), "stale expected revision was reported as verified");

    gitIn(repository, ["update-ref", `refs/heads/${currentBranch}`, approvedCommit]);
    const mismatchedApproval = runSyncHelper([
      "--verify",
      "--repo",
      repository,
      "--expected-revision",
      approvedCommit,
      "--approved-ref",
      "refs/heads/snapshot/approved",
      "--approved-commit",
      mismatchedRevision,
    ]);
    assert(mismatchedApproval.status === 3, "mismatched approved commit did not return verification-failure status");
    assert(
      mismatchedApproval.output.includes("does not match supplied approved commit"),
      "mismatched approved commit was not classified",
    );
    assert(!mismatchedApproval.output.includes("VERIFIED_SYNCHRONIZATION"), "mismatched approved commit was reported as verified");

    gitIn(repository, ["update-ref", `refs/heads/${currentBranch}`, approvedCommit]);
    const raceCommit = mismatchedRevision;
    const shimDirectory = mkdtempSync(join(tmpdir(), "github-sync-git-shim-"));
    const markerPath = join(shimDirectory, "race-triggered");
    const realGit = execFileSync("bash", ["-lc", "command -v git"], { encoding: "utf8" }).trim();
    writeGitRaceShim({
      shimDirectory,
      repository,
      raceCommit,
      markerPath,
      targetRef: `refs/heads/${currentBranch}`,
      triggerRef: "HEAD^{commit}",
      environmentPrefix: "SYNC_RACE",
      realGit,
    });
    const raced = runSyncHelper(
      [
        "--verify",
        "--repo",
        repository,
        "--expected-revision",
        approvedCommit,
        "--approved-ref",
        "refs/heads/snapshot/approved",
        "--approved-commit",
        approvedCommit,
      ],
      {
        PATH: `${shimDirectory}:${process.env.PATH ?? ""}`,
        SYNC_RACE_REPO: repository,
        SYNC_RACE_COMMIT: raceCommit,
        SYNC_RACE_MARKER: markerPath,
      },
    );
    assert(raced.status === 3, "workspace revision race did not return verification-failure status");
    assert(raced.output.includes("revision changed during verification"), "workspace revision race was not classified");
    assert(!raced.output.includes("VERIFIED_SYNCHRONIZATION"), "workspace revision race was reported as verified");
    rmSync(shimDirectory, { recursive: true, force: true });

    gitIn(repository, ["update-ref", `refs/heads/${currentBranch}`, approvedCommit]);
    const lockedRaceShimDirectory = mkdtempSync(join(tmpdir(), "github-sync-locked-race-shim-"));
    const lockedRaceMarkerPath = join(lockedRaceShimDirectory, "race-triggered");
    const lockedRaceReleaseRecordPath = join(repository, "locked-race-release", "release.json");
    writeGitRaceShim({
      shimDirectory: lockedRaceShimDirectory,
      repository,
      raceCommit,
      markerPath: lockedRaceMarkerPath,
      targetRef: `refs/heads/${currentBranch}`,
      triggerRef: "HEAD^{commit}",
      triggerAfterReadCount: 2,
      environmentPrefix: "SYNC_LOCKED_RACE",
      realGit,
    });
    const lockedRace = runSyncHelper(
      [
        "--locked-verify",
        "--repo",
        repository,
        "--approved-ref",
        "refs/heads/snapshot/approved",
        "--approved-commit",
        approvedCommit,
        "--release-id",
        "locked-race-release",
        "--release-record",
        lockedRaceReleaseRecordPath,
      ],
      {
        PATH: `${lockedRaceShimDirectory}:${process.env.PATH ?? ""}`,
        SYNC_LOCKED_RACE_REPO: repository,
        SYNC_LOCKED_RACE_COMMIT: raceCommit,
        SYNC_LOCKED_RACE_MARKER: lockedRaceMarkerPath,
      },
    );
    assert(lockedRace.status === 3, "locked workspace revision race did not return verification-failure status");
    assert(
      lockedRace.output.includes("revision changed during verification"),
      "locked workspace revision race was not classified",
    );
    assert(!lockedRace.output.includes("VERIFIED_SYNCHRONIZATION"), "locked workspace revision race was reported as verified");
    assert(existsSync(lockedRaceMarkerPath), "locked workspace revision race was not injected");
    assert(!existsSync(lockedRaceReleaseRecordPath), "locked workspace revision race published release evidence");
    assert(
      gitIn(repository, ["rev-parse", "HEAD"]) === raceCommit,
      "locked workspace revision race did not change the workspace revision",
    );
    rmSync(lockedRaceShimDirectory, { recursive: true, force: true });

    gitIn(repository, ["update-ref", `refs/heads/${currentBranch}`, approvedCommit]);
    gitIn(repository, ["update-ref", "refs/heads/snapshot/approved", approvedCommit]);
    const approvedRefShimDirectory = mkdtempSync(join(tmpdir(), "github-sync-approved-ref-shim-"));
    const approvedRefMarkerPath = join(approvedRefShimDirectory, "race-triggered");
    writeGitRaceShim({
      shimDirectory: approvedRefShimDirectory,
      repository,
      raceCommit,
      markerPath: approvedRefMarkerPath,
      targetRef: "refs/heads/snapshot/approved",
      triggerRef: "refs/heads/snapshot/approved^{commit}",
      environmentPrefix: "SYNC_APPROVED_REF_RACE",
      realGit,
    });
    const approvedRefRace = runSyncHelper(
      [
        "--verify",
        "--repo",
        repository,
        "--expected-revision",
        approvedCommit,
        "--approved-ref",
        "refs/heads/snapshot/approved",
        "--approved-commit",
        approvedCommit,
      ],
      {
        PATH: `${approvedRefShimDirectory}:${process.env.PATH ?? ""}`,
        SYNC_APPROVED_REF_RACE_REPO: repository,
        SYNC_APPROVED_REF_RACE_COMMIT: raceCommit,
        SYNC_APPROVED_REF_RACE_MARKER: approvedRefMarkerPath,
      },
    );
    assert(approvedRefRace.status === 3, "approved ref race did not return verification-failure status");
    assert(approvedRefRace.output.includes("approved ref changed during verification"), "approved ref race was not classified");
    assert(!approvedRefRace.output.includes("VERIFIED_SYNCHRONIZATION"), "approved ref race was reported as verified");
    assert(existsSync(approvedRefMarkerPath), "approved ref race was not injected");
    assert(gitIn(repository, ["rev-parse", "HEAD"]) === approvedCommit, "approved ref race changed the workspace revision");
    assert(
      gitIn(repository, ["rev-parse", "refs/heads/snapshot/approved"]) === raceCommit,
      "approved ref race did not move the approved ref",
    );
    rmSync(approvedRefShimDirectory, { recursive: true, force: true });

    gitIn(repository, ["update-ref", `refs/heads/${currentBranch}`, approvedCommit]);
    gitIn(repository, ["update-ref", "refs/pull/1575/head", approvedCommit]);
    const pullRequestRefShimDirectory = mkdtempSync(join(tmpdir(), "github-sync-pull-request-ref-shim-"));
    const pullRequestRefMarkerPath = join(pullRequestRefShimDirectory, "race-triggered");
    writeGitRaceShim({
      shimDirectory: pullRequestRefShimDirectory,
      repository,
      raceCommit,
      markerPath: pullRequestRefMarkerPath,
      targetRef: "refs/pull/1575/head",
      triggerRef: "refs/pull/1575/head^{commit}",
      environmentPrefix: "SYNC_PULL_REQUEST_REF_RACE",
      realGit,
    });
    const pullRequestRefRace = runSyncHelper(
      [
        "--verify",
        "--repo",
        repository,
        "--expected-revision",
        approvedCommit,
        "--approved-ref",
        "refs/pull/1575/head",
        "--approved-commit",
        approvedCommit,
      ],
      {
        PATH: `${pullRequestRefShimDirectory}:${process.env.PATH ?? ""}`,
        SYNC_PULL_REQUEST_REF_RACE_REPO: repository,
        SYNC_PULL_REQUEST_REF_RACE_COMMIT: raceCommit,
        SYNC_PULL_REQUEST_REF_RACE_MARKER: pullRequestRefMarkerPath,
      },
    );
    assert(pullRequestRefRace.status === 3, "pull-request approved ref race did not return verification-failure status");
    assert(
      pullRequestRefRace.output.includes("approved ref changed during verification"),
      "pull-request approved ref race was not classified",
    );
    assert(!pullRequestRefRace.output.includes("VERIFIED_SYNCHRONIZATION"), "pull-request ref race was reported as verified");
    assert(existsSync(pullRequestRefMarkerPath), "pull-request approved ref race was not injected");
    assert(gitIn(repository, ["rev-parse", "HEAD"]) === approvedCommit, "pull-request ref race changed the workspace revision");
    assert(
      gitIn(repository, ["rev-parse", "refs/pull/1575/head"]) === raceCommit,
      "pull-request ref race did not move the approved ref",
    );
    rmSync(pullRequestRefShimDirectory, { recursive: true, force: true });

    const unsupportedRef = runSyncHelper([
      "--verify",
      "--repo",
      repository,
      "--expected-revision",
      approvedCommit,
      "--approved-ref",
      "refs/heads/main",
      "--approved-commit",
      approvedCommit,
    ]);
    assert(unsupportedRef.status === 3, "unsupported approval ref did not fail verification");
    assert(unsupportedRef.output.includes("VERIFICATION_FAILURE"), "unsupported approval ref was not labeled");
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
}

export function scanPaths(paths, contents = new Map()) {
  const findings = [];
  for (const filePath of paths) {
    const pathIssue = pathFinding(filePath);
    if (pathIssue) findings.push(`${filePath}: ${pathIssue}`);
    findings.push(...publicDataFindings(filePath, contents.get(filePath)).map((kind) => `${filePath}: ${kind}`));
    findings.push(...contentFindings(filePath, contents.get(filePath)));
  }
  return findings;
}

export function scanHistoryMetadata(repository = ROOT) {
  const objects = historyObjects(repository);
  if (!objects.bounded) return [objects.reason];
  const findings = new Set();
  for (const record of objects.records) {
    const pathIssue = pathFinding(record.filePath);
    if (!pathIssue) continue;
    for (const refKind of record.refKinds ?? ["other public ref"]) {
      findings.add(`${refKind}: ${pathIssue}`);
    }
  }
  return [...findings].sort();
}

function runSelfTests() {
  assertReleaseDocumentation();
  const protectionStatus = readFileSync(join(ROOT, PROTECTION_STATUS_PATH), "utf8");
  let rejectedStaleClaim = false;
  try {
    assertProtectionControlStatuses(
      protectionStatus.replace("| Secret scanning | `stale` |", "| Secret scanning | `verified` |"),
      false,
    );
  } catch (error) {
    rejectedStaleClaim = /stale protection evidence cannot support/.test(String(error));
  }
  assert(rejectedStaleClaim, "a stale snapshot must reject a verified control");

  const revision = "abcdef0123456789abcdef0123456789abcdef01";
  const context = {
    repository: PROTECTION_REPOSITORY,
    revisionSha: revision,
    policy: PROTECTION_POLICY,
    permissions: PROTECTION_PERMISSIONS,
  };
  const snapshot = buildGitHubProtectionSnapshot({
    ...context,
    capabilities: {},
    controls: {},
  });
  const stale = evaluateGitHubProtectionFreshness(snapshot, {
    ...context,
    revisionSha: "0123456789abcdef0123456789abcdef01234567",
  });
  assert(!stale.current && stale.status === "stale", "stale protection evidence was accepted as current");
  const incomplete = evaluateGitHubProtectionFreshness(snapshot, {
    repository: PROTECTION_REPOSITORY,
    revisionSha: revision,
    policy: PROTECTION_POLICY,
  });
  assert(!incomplete.current && incomplete.status === "stale", "incomplete protection evidence was accepted as current");
  const incompletePolicy = evaluateGitHubProtectionFreshness(snapshot, {
    ...context,
    policy: { requiredChecks: ["CI / required"], strict: true },
  });
  assert(!incompletePolicy.current && incompletePolicy.status === "stale", "incomplete policy evidence was accepted as current");
  assert(incompletePolicy.reasons.includes("policy evidence is incomplete"), "incomplete policy evidence was not reported");
  const wrongRepository = evaluateGitHubProtectionFreshness(snapshot, {
    ...context,
    repository: "another-owner/EES-Parts-ID",
  });
  assert(!wrongRepository.current && wrongRepository.status === "stale", "wrong-repository evidence was accepted as current");

  const policyChanges = [
    ["required pull-request reviews", "branchProtection", { requiredPullRequestReviews: false }],
    ["conversation resolution", "branchProtection", { requiredConversationResolution: false }],
    ["administrator enforcement", "branchProtection", { enforceAdmins: false }],
    ["force-push block", "branchProtection", { allowForcePushes: true }],
    ["branch-deletion block", "branchProtection", { allowDeletions: true }],
    ["default workflow token", "actions", { defaultWorkflowPermissions: "write" }],
    ["workflow-token PR approval", "actions", { canApprovePullRequestReviews: true }],
    ["Actions SHA pinning", "actions", { shaPinningRequired: false }],
    ["selected-actions policy", "selectedActions", { policy: "all" }],
    ["GitHub-owned Actions allowlist", "selectedActions", { githubOwnedAllowed: false }],
    ["verified marketplace Actions allowlist", "selectedActions", { verifiedAllowed: true }],
    ["selected Actions pattern allowlist", "selectedActions", { patterns: ["actions/checkout@*"] }],
  ];
  for (const [label, section, change] of policyChanges) {
    const changedContext = {
      ...context,
      policy: {
        ...context.policy,
        [section]: { ...context.policy[section], ...change },
      },
    };
    const changed = evaluateGitHubProtectionFreshness(snapshot, changedContext);
    assert(!changed.current && changed.status === "stale", `${label} policy change was accepted as current`);
    assert(changed.reasons.includes("policy evidence changed"), `${label} policy change did not report changed policy evidence`);
  }

  assertSyncHelperFailsClosed();

  const synthetic = new Map([
    [
      PUBLIC_LAYOUT_PATH,
      [
        PUBLIC_LAYOUT_COLUMNS.join(","),
        "aisle-1,1,t,0,0,10,10,0",
      ].join("\n"),
    ],
    ["fixtures/synthetic-users.json", '{"email":"worker@example.com","id":"fixture-user-001"}'],
    ["lib/db/drizzle/0040_example.sql", "CREATE TABLE example (id integer);"],
  ]);
  assert(scanPaths([...synthetic.keys()], synthetic).length === 0, "safe examples/layout were rejected");

  const archive = scanPaths(["exports/inventory_export.csv"], new Map([["exports/inventory_export.csv", "vendor,catalog"]]));
  assert(archive.some((finding) => finding.includes("exports/inventory_export.csv")), "export path negative control was not rejected");

  const upload = scanPaths(["attached_assets/customer.pdf"], new Map([["attached_assets/customer.pdf", "not inspected"]]));
  assert(upload.some((finding) => finding.includes("attached_assets/customer.pdf")), "upload path negative control was not rejected");

  const accountProjection = scanPaths(
    [".agents/skills/.account-projections/private-skill/SKILL.md"],
    new Map([[".agents/skills/.account-projections/private-skill/SKILL.md", "# private account skill"]]),
  );
  assert(accountProjection.some((finding) => finding.includes("generated account skill projection")), "account projection negative control was not rejected");

  const credential = ["API_", "KEY=", "not-a-placeholder-secret-value-123456"].join("");
  const credentialFindings = scanPaths(["fixture.txt"], new Map([["fixture.txt", credential]]));
  assert(credentialFindings.some((finding) => finding.includes("fixture.txt")), "credential negative control was not rejected");
  assert(
    !credentialFindings.some((finding) => finding.includes("not-a-placeholder-secret-value-123456")),
    "credential diagnostics exposed a matched value",
  );

  const generatedCredential = [
    ["DATABASE_", "URL="].join(""),
    ["postgresql://", "real-user:real-password", "@", "db.example.com/app"].join(""),
  ].join("");
  const generatedFindings = scanPaths(
    ["artifacts/parts-id/static-build/index.js"],
    new Map([["artifacts/parts-id/static-build/index.js", generatedCredential]]),
  );
  assert(
    generatedFindings.some((finding) => finding.includes("database credential in connection URL")),
    "generated output was not scanned",
  );
  assert(!generatedFindings.some((finding) => finding.includes("real-password")), "generated diagnostics exposed a matched value");

  const generatedContact = ["maintainer@", ["vendor", "co"].join(".")].join("");
  const generatedContactFindings = scanPaths(
    ["artifacts/parts-id/static-build/contact.js"],
    new Map([["artifacts/parts-id/static-build/contact.js", generatedContact]]),
  );
  assert(
    generatedContactFindings.some((finding) => finding.includes("non-synthetic email")),
    "generated bundle contact data was not rejected",
  );

  const userDataFindings = scanPaths(
    ["fixtures/production-users.json"],
    new Map([["fixtures/production-users.json", `{"email":"${["person@", "private.example.com"].join("")}"}`]]),
  );
  assert(userDataFindings.some((finding) => finding.includes("non-synthetic email")), "user-data negative control was not rejected");
  assert(
    !scanPaths(
      ["data/public/unsafe.csv"],
      new Map([["data/public/unsafe.csv", ["id,email\n1,x", "@", "y.com"].join("")]]),
    ).every((finding) => !finding.includes("unapproved public-data")),
    "unapproved public data was accepted",
  );

  const unsafeLayout = "aisle_key,section,is_inventory,secret\naisle-1,1,t,customer";
  assert(
    scanPaths([PUBLIC_LAYOUT_PATH], new Map([[PUBLIC_LAYOUT_PATH, unsafeLayout]])).some((finding) =>
      finding.includes("public layout schema"),
    ),
    "unsafe public layout schema was accepted",
  );
  assert(
    !historyCompleteness({ shallow: true, refs: "refs/heads/main abc", head: "abc" }).complete,
    "shallow history was accepted",
  );
  assert(
    historyCompleteness({
      refs: "refs/remotes/origin/main abc\nrefs/pull/42/head abc",
      head: "abc",
      requiredRefs: ["refs/heads/main"],
      requiredCommit: "abc",
    }).complete,
    "complete required history refs were rejected",
  );
  const missingRequiredRef = historyCompleteness({
    refs: "refs/remotes/origin/main abc",
    head: "abc",
    requiredRefs: ["refs/pull/42/merge"],
    requiredCommit: "abc",
  });
  assert(!missingRequiredRef.complete && missingRequiredRef.reasons.includes("required ref is absent"), "missing required ref was accepted");
  const mismatchedRequiredCommit = historyCompleteness({
    refs: "refs/remotes/origin/main older\nrefs/pull/42/head older",
    head: "abc",
    requiredRefs: ["refs/heads/main"],
    requiredCommit: "abc",
  });
  assert(
    !mismatchedRequiredCommit.complete &&
      mismatchedRequiredCommit.reasons.includes("required ref does not point to the required commit"),
    "required ref commit mismatch was accepted",
  );

  const checkoutFixture = createHistoryCheckoutFixture();
  try {
    const missingProviderRefs = historyCompleteness({
      repository: checkoutFixture.completeCheckout,
      requiredRefs: [`refs/heads/${checkoutFixture.branchName}`],
      requiredCommit: checkoutFixture.approvedCommit,
    });
    assert(
      !missingProviderRefs.complete &&
        missingProviderRefs.reasons.includes("provider-retained pull-request refs are absent from the fetched ref set"),
      "a normal clone without provider refs was accepted",
    );
    let rejectedWrongOrigin = false;
    try {
      fetchProviderPullRefs(checkoutFixture.completeCheckout);
    } catch (error) {
      rejectedWrongOrigin = error.message.includes("origin is not the expected GitHub repository");
    }
    assert(rejectedWrongOrigin, "fetch accepted an untrusted origin");
    const unavailableOrigin = pathToFileURL(join(checkoutFixture.root, "unavailable")).href;
    gitIn(checkoutFixture.completeCheckout, ["remote", "set-url", "origin", unavailableOrigin]);
    let rejectedUnavailableOrigin = false;
    try {
      fetchProviderPullRefs(checkoutFixture.completeCheckout, unavailableOrigin);
    } catch (error) {
      rejectedUnavailableOrigin = error.message.includes("cannot fetch provider-retained pull-request refs");
    }
    assert(rejectedUnavailableOrigin, "failed provider fetch was accepted");
    gitIn(checkoutFixture.completeCheckout, ["remote", "set-url", "origin", pathToFileURL(join(checkoutFixture.root, "source")).href]);
    fetchProviderPullRefs(checkoutFixture.completeCheckout, pathToFileURL(join(checkoutFixture.root, "source")).href);
    assert(
      gitIn(checkoutFixture.completeCheckout, ["rev-parse", "refs/pull/42/head"]) === checkoutFixture.baseCommit,
      "provider pull refs were not fetched into the normal clone",
    );
    const shallowCheckout = historyCompleteness({
      repository: checkoutFixture.shallowCheckout,
      requiredRefs: [`refs/heads/${checkoutFixture.branchName}`],
      requiredCommit: checkoutFixture.approvedCommit,
    });
    assert(
      !shallowCheckout.complete && shallowCheckout.reasons.includes("shallow checkout"),
      "real shallow checkout was accepted as complete history",
    );

    const missingCheckoutRef = historyCompleteness({
      repository: checkoutFixture.completeCheckout,
      requiredRefs: ["refs/pull/43/head"],
      requiredCommit: checkoutFixture.approvedCommit,
    });
    assert(
      !missingCheckoutRef.complete && missingCheckoutRef.reasons.includes("required ref is absent"),
      "real checkout with a missing pull-request ref was accepted",
    );

    const mismatchedCheckoutCommit = historyCompleteness({
      repository: checkoutFixture.completeCheckout,
      requiredRefs: ["refs/heads/review/approved"],
      requiredCommit: checkoutFixture.approvedCommit,
    });
    assert(
      !mismatchedCheckoutCommit.complete &&
        mismatchedCheckoutCommit.reasons.includes("required ref does not point to the required commit"),
      "real checkout with a mismatched required ref commit was accepted",
    );

    const completeCheckout = historyCompleteness({
      repository: checkoutFixture.completeCheckout,
      requiredRefs: [`refs/heads/${checkoutFixture.branchName}`],
      requiredCommit: checkoutFixture.approvedCommit,
    });
    assert(completeCheckout.complete, "real complete checkout was rejected");

    const fixtureObjects = historyObjects(checkoutFixture.completeCheckout);
    assert(fixtureObjects.bounded, "real complete checkout history objects were not bounded");
    const fixtureContent = scanHistoryContents(fixtureObjects.records, checkoutFixture.completeCheckout);
    assert(
      fixtureContent.findings.some((finding) => finding.includes("branch head: credential-shaped assignment")),
      "historical ordinary source content was not scanned through branch heads",
    );
    assert(
      fixtureContent.findings.some((finding) => finding.includes("provider-retained pull-request ref: credential-shaped assignment")),
      "historical ordinary source content was not scanned through provider-retained pull-request refs",
    );
    const fixtureMetadata = scanHistoryMetadata(checkoutFixture.completeCheckout);
    assert(
      fixtureMetadata.includes("branch head: operational or inventory export"),
      "branch-head historical path diagnostics were not classified",
    );
    assert(
      fixtureMetadata.includes("provider-retained pull-request ref: operational or inventory export"),
      "provider-retained pull-request historical path diagnostics were not classified separately",
    );
    assert(
      !fixtureContent.findings.join("\n").includes("history-secret-value-123456") &&
        !fixtureContent.findings.join("\n").includes("ordinary-source.js"),
      "historical ordinary-source diagnostics exposed a value or raw path",
    );
  } finally {
    rmSync(checkoutFixture.root, { recursive: true, force: true });
  }

  const pathOnlyHistory = scanHistoricalPathEntries([
    { filePath: "ordinary-source.js" },
    { filePath: "exports/customer.csv" },
  ]);
  assert(pathOnlyHistory.some((finding) => finding.includes("export")), "history path classification missed the export path");
  assert(
    scanHistoricalPathEntries([{ filePath: "ordinary-source.js" }]).length === 0,
    "path-only history scan reported a content finding",
  );
  const historicalSecret = scanHistoricalContentEntries([
    {
      filePath: ["private-", "customer-export.txt"].join(""),
      content: "API_" + "KEY=" + "history-secret-value-123456",
    },
  ]);
  assert(historicalSecret.length > 0, "historical content negative control was not rejected");
  assert(!historicalSecret.join("\n").includes("history-secret-value-123456"), "historical diagnostics exposed a matched value");
  assert(!historicalSecret.join("\n").includes("private-customer-export.txt"), "historical diagnostics exposed a private path");

  const selfFindings = scanPaths(["scripts/test/public-repository-boundary.test.mjs"]);
  assert(
    !selfFindings.some((finding) => finding.includes("not-a-placeholder-secret-value-123456")),
    "scanner source is exempt from its own content checks",
  );
}

function main() {
  runSelfTests();
  const findings = scanPaths(trackedPaths());
  assert(
    findings.length === 0,
    [
      "Public repository boundary violations detected:",
      boundedDiagnostics(findings),
      "Remove the private file or replace the credential/data with a synthetic example.",
    ].join("\n"),
  );

  fetchProviderPullRefs();
  const completeness = historyCompleteness();
  assert(
    completeness.complete,
    `Public repository history scan is incomplete: ${completeness.reasons.join(", ")}.`,
  );
  const historyFindings = scanHistoryMetadata();
  const objects = historyObjects();
  assert(objects.bounded, `Public repository history scan is incomplete: ${objects.reason}.`);
  const historyContent = scanHistoryContents(objects.records);
  assert(
    historyContent.complete,
    `Public repository history content scan is incomplete: ${historyContent.findings[0]}.`,
  );
  console.log(
    `Public repository boundary: ${trackedPaths().length} tracked paths checked; ` +
      `${historyFindings.length} historical private path category(ies) require owner-led remediation; ` +
      `${historyContent.scannedBlobs} reachable blobs scanned for protected content.`,
  );
  if (historyFindings.length > 0) {
    console.log("Historical remediation includes private path categories; raw historical paths are intentionally redacted.");
  }
  if (historyContent.findings.length > 0) {
    console.log(
      `Historical protected-content findings: ${historyContent.findings.length}` +
        (historyContent.findings.length === MAX_FINDINGS ? " (output capped)." : "."),
    );
  }
}

if (
  process.argv[1] &&
  relative(process.cwd(), process.argv[1]) === relative(process.cwd(), fileURLToPath(import.meta.url))
) {
  main();
}