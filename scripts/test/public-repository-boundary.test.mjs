#!/usr/bin/env node
/**
 * Repository boundary contract.
 *
 * The current tree is the merge-blocking surface. Reachable-history paths are
 * reported as remediation findings because removing them requires an owner-led
 * history rewrite; this check must not imply that such a rewrite happened.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { getTierSteps } from "../validation-steps.mjs";

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
const ALLOWED_GENERATED_EMAILS = new Set([
  ["support@", "clerk.com"].join(""),
  ["nicolas.charpentier079@", "gmail.com"].join(""),
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

function runSyncHelper(args) {
  const result = spawnSync("bash", [join(ROOT, "scripts/sync-github.sh"), ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

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
      const generatedBundle = /(?:^|\/)static-build\//i.test(filePath);
      if (!reservedDomain && !(generatedBundle && ALLOWED_GENERATED_EMAILS.has(match[0]))) {
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

function historyCompleteness({ shallow, refs, head, replaceRefs, promisor } = {}) {
  const isShallow = shallow ?? gitOptional(["rev-parse", "--is-shallow-repository"]).trim() === "true";
  const refLines = refs ?? gitOptional(["for-each-ref", "--format=%(refname) %(objectname)"]).trim();
  const headOid = head ?? gitOptional(["rev-parse", "--verify", "HEAD"]).trim();
  const hasReplaceRefs = replaceRefs ?? gitOptional(["replace", "-l"]).trim();
  const hasPromisor = promisor ?? gitOptional(["config", "--get-regexp", "remote\\..*\\.promisor"]).trim();
  const reasons = [];
  if (isShallow) reasons.push("shallow checkout");
  if (!refLines || refLines.split("\n").filter(Boolean).length === 0) reasons.push("no complete ref set");
  if (!headOid) reasons.push("missing HEAD");
  if (hasReplaceRefs) reasons.push("replace refs are active");
  if (hasPromisor) reasons.push("partial clone promises are active");
  return { complete: reasons.length === 0, reasons };
}

function historyObjects() {
  const lines = git(["rev-list", "--objects", "--all"]).split("\n").filter(Boolean);
  if (lines.length > MAX_HISTORY_OBJECTS) {
    return { bounded: false, reason: "reachable object count exceeds scan limit", records: [] };
  }
  const records = lines.map((line) => {
    const separator = line.indexOf(" ");
    return separator === -1
      ? { oid: line, filePath: "" }
      : { oid: line.slice(0, separator), filePath: line.slice(separator + 1) };
  });
  if (records.length === 0) return { bounded: true, records: [] };
  const checks = git(["cat-file", "--batch-check"], {
    input: `${records.map(({ oid }) => oid).join("\n")}\n`,
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

function scanHistoryContents(records) {
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

  const output = execFileSync("git", ["cat-file", "--batch"], {
    cwd: ROOT,
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
    findings.push(...scanHistoricalContentEntries([
      { filePath: record.filePath, content: body.toString("utf8") },
    ]).slice(0, MAX_FINDINGS - findings.length));
  }
  return { complete: true, scannedBlobs, skippedBlobs: 0, findings };
}

function assertReleaseDocumentation() {
  const security = readFileSync(join(ROOT, SECURITY_POLICY_PATH), "utf8");
  const classification = readFileSync(join(ROOT, DATA_CLASSIFICATION_PATH), "utf8");
  const checklist = readFileSync(join(ROOT, RELEASE_CHECKLIST_PATH), "utf8");
  const readiness = readFileSync(join(ROOT, "docs/public-repository-readiness.md"), "utf8");
  const protectionStatus = readFileSync(join(ROOT, PROTECTION_STATUS_PATH), "utf8");
  const coverage = readFileSync(join(ROOT, "docs/validation/github-actions-coverage.md"), "utf8");
  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");

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
  for (const phrase of ["POLICY_REFUSAL", "VERIFIED_SYNCHRONIZATION", "VERIFICATION_FAILURE", "--verify"]) {
    assert(checklist.includes(phrase), `release checklist is missing sync state "${phrase}"`);
    assert(readiness.includes(phrase), `repository readiness is missing sync state "${phrase}"`);
  }

  const statusValues = [...protectionStatus.matchAll(/`(verified|owner-action-required|unverified)`/g)].map((match) => match[1]);
  assert(statusValues.includes("verified"), "protection status does not distinguish verified controls");
  assert(statusValues.includes("unverified"), "protection status does not define unverified evidence");
  for (const control of ["Secret scanning", "Push protection", "Dependency alerts", "Required validation"]) {
    assert(protectionStatus.includes(`| ${control} |`), `protection status is missing "${control}"`);
  }
  assert(/Secret scanning \| `verified`/.test(protectionStatus), "secret scanning is not recorded as verified");
  assert(/Push protection \| `verified`/.test(protectionStatus), "push protection is not recorded as verified");
  assert(/Dependency alerts \| `verified`/.test(protectionStatus), "dependency alerts are not recorded as verified");

  const boundaryStep = getTierSteps("fast").find(([name]) => name === "public-repository-boundary");
  assert(boundaryStep?.[1] === "node scripts/test/public-repository-boundary.test.mjs", "boundary guard is not registered in test-fast");
  assert(coverage.includes("| public-repository-boundary | `CI / required` → `pnpm run test-standard-plus`"), "boundary guard is not mapped to the existing GitHub validation path");
  assert((ci.match(/pnpm run test-standard-plus/g) ?? []).length === 1, "CI duplicates or omits the canonical validation tier");
}

function assertSyncHelperFailsClosed() {
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
    const approvedTree = gitIn(repository, ["rev-parse", "HEAD^{tree}"]);
    gitIn(repository, ["update-ref", "refs/heads/snapshot/approved", approvedCommit]);

    const verified = runSyncHelper([
      "--verify",
      "--repo",
      repository,
      "--expected-tree",
      approvedTree,
      "--approved-ref",
      "refs/heads/snapshot/approved",
    ]);
    assert(verified.status === 0, "exact approved snapshot tree did not verify");
    assert(verified.output.includes("VERIFIED_SYNCHRONIZATION"), "verified synchronization was not labeled");

    writeFileSync(join(repository, "README.md"), "different workspace tree\n");
    gitIn(repository, ["add", "README.md"]);
    gitIn(repository, ["commit", "--quiet", "-m", "different workspace tree"]);
    const mismatchedTree = gitIn(repository, ["rev-parse", "HEAD^{tree}"]);
    const mismatch = runSyncHelper([
      "--verify",
      "--repo",
      repository,
      "--expected-tree",
      mismatchedTree,
      "--approved-ref",
      "refs/heads/snapshot/approved",
    ]);
    assert(mismatch.status === 3, "mismatched tree did not return verification-failure status");
    assert(mismatch.output.includes("VERIFICATION_FAILURE"), "tree mismatch was not labeled");
    assert(!mismatch.output.includes("VERIFIED_SYNCHRONIZATION"), "tree mismatch was reported as verified");

    const staleExpectedTree = runSyncHelper([
      "--verify",
      "--repo",
      repository,
      "--expected-tree",
      approvedTree,
      "--approved-ref",
      "refs/heads/snapshot/approved",
    ]);
    assert(staleExpectedTree.status === 3, "stale expected tree did not return verification-failure status");
    assert(staleExpectedTree.output.includes("expected tree is stale"), "stale expected tree was not classified");
    assert(staleExpectedTree.output.includes("selected repository workspace"), "stale tree diagnostic did not identify the workspace");
    assert(!staleExpectedTree.output.includes("VERIFIED_SYNCHRONIZATION"), "stale expected tree was reported as verified");

    const unsupportedRef = runSyncHelper([
      "--verify",
      "--repo",
      repository,
      "--expected-tree",
      approvedTree,
      "--approved-ref",
      "refs/heads/main",
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

export function scanHistoryMetadata() {
  const historyPaths = git(["rev-list", "--objects", "--all"])
    .split("\n")
    .map((line) => line.replace(/^[0-9a-f]+ /, ""))
    .filter(Boolean);
  return [...new Set(historyPaths.map((filePath) => pathFinding(filePath)).filter(Boolean))].sort();
}

function runSelfTests() {
  assertReleaseDocumentation();
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