#!/usr/bin/env node
/**
 * Repository boundary contract.
 *
 * The current tree is the merge-blocking surface. Reachable-history paths are
 * reported as remediation findings because removing them requires an owner-led
 * history rewrite; this check must not imply that such a rewrite happened.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL("../..", import.meta.url)));
const ALLOWED_ARCHIVES = new Set([
  "artifacts/failure-gate-skill.zip",
  "artifacts/task-triage-skill.zip",
]);
const PUBLIC_LAYOUT_PATH = "data/public/warehouse-zones.csv";
const SAFE_EMAIL_DOMAINS = new Set([
  "example.com",
  "example.org",
  "example.net",
  "example.test",
  "test.invalid",
  "localhost",
  "replit.local",
]);
const SAFE_EXAMPLE_VALUES = new Set([
  "dbname",
  "host",
  "password",
  "postgres",
  "user",
]);

function git(args) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function trackedPaths() {
  return git(["ls-files", "-z"]).split("\0").filter(Boolean);
}

function isSafeExample(value) {
  const normalized = value.trim();
  return (
    SAFE_EXAMPLE_VALUES.has(normalized.toLowerCase()) ||
    /^(?:x{6,}|fake(?:[-_].*)?|example(?:[-_].*)?|placeholder(?:[-_].*)?|replace(?:[-_]?me)?|your(?:[-_].*)?|test(?:[-_].*)?|jest(?:[-_].*)?|changeme|password)$/i.test(
      normalized,
    ) ||
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

function contentFindings(filePath, content) {
  if (filePath === "scripts/test/public-repository-boundary.test.mjs" && content === undefined) {
    return [];
  }
  const text = readableText(filePath, content);
  if (text === null) return [];

  const findings = [];
  const add = (kind, value) => findings.push(`${filePath}: ${kind} (${value.slice(0, 80)})`);
  const generatedOutput = /(?:^|\/)(?:static-build|node_modules)\//i.test(filePath);
  const testFixture = /(?:__tests__|\.test\.|\.spec\.)/i.test(filePath);

  if (/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(text)) {
    add("private key material", "private-key-header");
  }
  for (const [kind, pattern] of [
    ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/g],
    ["Google API key", /\bAIza[0-9A-Za-z_-]{20,}\b/g],
    ["GitHub token", /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g],
    ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
    ["Clerk/OpenAI-style key", /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9_-]{20,}\b/g],
  ]) {
    for (const match of text.matchAll(pattern)) {
      const syntheticTestValue =
        testFixture && /(?:test|fake|abc123|xyz789|workflow|token)/i.test(match[0]);
      if (!isSafeExample(match[0]) && !syntheticTestValue) add(kind, match[0]);
    }
  }

  for (const match of text.matchAll(/\b(?:postgres(?:ql)?):\/\/([^:\s/]+):([^@\s]+)@/gi)) {
    if (!isSafeExample(match[1]) || !isSafeExample(match[2])) {
      add("database credential in connection URL", match[0]);
    }
  }

  if (!generatedOutput) {
    for (const match of text.matchAll(
      /\b(?:API_KEY|SECRET(?:_KEY)?|PASSWORD|ACCESS_TOKEN|AUTH_TOKEN|DATABASE_URL|(?:CLERK|GITHUB|OPENAI|POE|AWS)_[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))\s*[:=]\s*(?:"([^"]+)"|'([^']+)'|([a-z0-9][a-z0-9._-]{15,}))/g,
    )) {
      const value = match[1] ?? match[2] ?? match[3] ?? "";
      if (
        value &&
        !isSafeExample(value) &&
        !value.startsWith("process.env") &&
        !value.startsWith("$") &&
        !(testFixture && /(?:test|fake|jest|abc123|xyz789|workflow)/i.test(value))
      ) {
        add("credential-shaped assignment", match[0]);
      }
    }
  }

  const packageMetadata = /(?:^|\/)(?:package\.json|pnpm-lock\.yaml)$/.test(filePath);
  if (!generatedOutput && !packageMetadata) {
    for (const match of text.matchAll(/\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g)) {
      const domain = match[1].toLowerCase();
      const reservedDomain =
        SAFE_EMAIL_DOMAINS.has(domain) ||
        domain.endsWith(".example") ||
        domain.endsWith(".test");
      if (!reservedDomain) {
        add("non-synthetic email address", match[0]);
      }
    }
  }

  if (/(^|\/)(?:fixtures?|seeds?)\//i.test(filePath) && /\b(?:clerk_)?user_[A-Za-z0-9]{15,}\b/.test(text)) {
    add("non-synthetic user fixture identifier", "user-id");
  }

  return findings;
}

export function scanPaths(paths, contents = new Map()) {
  const findings = [];
  for (const filePath of paths) {
    const pathIssue = pathFinding(filePath);
    if (pathIssue) findings.push(`${filePath}: ${pathIssue}`);
    findings.push(...contentFindings(filePath, contents.get(filePath)));
  }
  return findings;
}

export function scanHistoryMetadata() {
  const historyPaths = git(["rev-list", "--objects", "--all"])
    .split("\n")
    .map((line) => line.replace(/^[0-9a-f]+ /, ""))
    .filter(Boolean);
  return [...new Set(historyPaths.filter((filePath) => pathFinding(filePath)))].sort();
}

function runSelfTests() {
  const synthetic = new Map([
    [PUBLIC_LAYOUT_PATH, "aisle_key,section,is_inventory,svg_x\nA-1,1,t,0"],
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

  const credential = "API_KEY=" + "not-a-placeholder-secret-value-123456";
  const credentialFindings = scanPaths(["fixture.txt"], new Map([["fixture.txt", credential]]));
  assert(credentialFindings.some((finding) => finding.includes("fixture.txt")), "credential negative control was not rejected");

  const userDataFindings = scanPaths(
    ["fixtures/production-users.json"],
    new Map([["fixtures/production-users.json", '{"email":"person@private.example.invalid"}']]),
  );
  assert(userDataFindings.some((finding) => finding.includes("non-synthetic email")), "user-data negative control was not rejected");
}

function main() {
  runSelfTests();
  const findings = scanPaths(trackedPaths());
  assert(
    findings.length === 0,
    [
      "Public repository boundary violations detected:",
      ...findings.map((finding) => `  - ${finding}`),
      "Remove the private file or replace the credential/data with a synthetic example.",
    ].join("\n"),
  );

  const historyFindings = scanHistoryMetadata();
  console.log(
    `Public repository boundary: ${trackedPaths().length} tracked paths checked; ` +
      `${historyFindings.length} historical private path(s) require owner-led remediation.`,
  );
  if (historyFindings.length > 0) {
    console.log(`Historical remediation paths: ${historyFindings.join(", ")}`);
  }
}

if (
  process.argv[1] &&
  relative(process.cwd(), process.argv[1]) === relative(process.cwd(), fileURLToPath(import.meta.url))
) {
  main();
}