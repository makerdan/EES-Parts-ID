import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const apiServerRoot = join(repositoryRoot, "artifacts/api-server");
const integrationRoots = [
  join(apiServerRoot, "__tests__"),
  join(apiServerRoot, "src", "__tests__"),
];
const IGNORED_DISCOVERY_DIRECTORIES = new Set(["generated", "helpers"]);
const sharedTestDbPath = join(
  apiServerRoot,
  "__tests__",
  "helpers",
  "testDb.ts",
);
const globalSetupPath = join(apiServerRoot, "jest.globalSetup.cjs");

const SHARED_HELPERS = new Set([
  "bestEffortFixtureCleanup",
  "cleanupDictionaryFixtures",
  "cleanupEditableItem",
  "cleanupFixtures",
  "cleanupTestUser",
  "restoreAdminPreferences",
  "seedDictionaryFixtures",
  "seedEditableItem",
  "seedFixtures",
  "seedTestUser",
  "snapshotAdminPreferences",
  "workerQualifiedUserId",
]);

const GLOBAL_SETUP_ALLOWLIST = new Set([
  "artifacts/api-server/jest.globalSetup.cjs",
]);
const SHARED_HELPER_ALLOWLIST = new Set([
  "artifacts/api-server/__tests__/helpers/testDb.ts",
]);
const MOCKED_GLOBAL_SETUP_TEST_ALLOWLIST = new Set([
  "artifacts/api-server/__tests__/jestGlobalSetup.integration.test.ts",
]);
const LEGACY_BROAD_CLEANUP_ALLOWLIST = new Map([
  [
    "artifacts/api-server/src/__tests__/expandDescriptionJob.integration.test.ts",
    "This suite snapshots pre-existing expansion jobs before its deterministic sweep.",
  ],
  [
    "artifacts/api-server/__tests__/aiTranslatePartCard.integration.test.ts",
    "The cache table is a dedicated test namespace with a fixed cleanup prefix.",
  ],
]);

function lineNumberAt(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

function relativePath(filePath) {
  return relative(repositoryRoot, filePath).replaceAll("\\", "/");
}

function findAll(source, pattern) {
  return [...source.matchAll(pattern)].map((match) => ({
    offset: match.index ?? 0,
    text: match[0],
  }));
}

function canonicalHelperNamesInSource(source) {
  const importedNames = [
    ...source.matchAll(
      /import\s+(?:type\s+)?([\s\S]*?)\s+from\s+["'](?:\.\/helpers\/testDb|(?:\.\.\/)+__tests__\/helpers\/testDb)["']/g,
    ),
  ]
    .map((match) => match[1] ?? "")
    .join("\n");

  return [...SHARED_HELPERS].filter((name) =>
    new RegExp(`\\b${name}\\b`).test(importedNames),
  );
}

function helperNamesInSource(source) {
  return canonicalHelperNamesInSource(source).filter((name) =>
    new RegExp(`\\b${name}\\s*\\(`).test(source),
  );
}

function hasLifecycleContract(source) {
  return (
    /\bafter(?:All|Each)\s*\(/.test(source) ||
    /\bfinally\s*\{/.test(source) ||
    /\bfinally\s*\(/.test(source) ||
    /\bcleanup[A-Z]\w*\s*\(/.test(source)
  );
}

function hasExactCleanupEvidence(source) {
  return (
    /\b(?:inArray|eq|and|or)\s*\(/.test(source) ||
    /\b(?:seeded|inserted|created|owned|session)[A-Z]\w*(?:Ids?|s)?\b/.test(
      source,
    ) ||
    /\b(?:workerQualifiedUserId|process\.pid|JEST_WORKER_ID)\b/.test(source) ||
    /\b(?:delete|remove)[A-Z]\w*\s*\(/.test(source)
  );
}

function mutationMatches(source) {
  return findAll(
    source,
    /\b(?:db|freshDb|delayedGeneration\.db|failedGeneration\.db)\s*\.\s*(?:insert|update|delete|execute)\s*\(/g,
  );
}

function broadCleanupMatches(source) {
  return findAll(
    source,
    /\b(?:db|freshDb|delayedGeneration\.db|failedGeneration\.db)\s*\.\s*delete\s*\([\s\S]{0,700}?\.(?:where|execute)\s*\([\s\S]{0,700}?(?:\bLIKE\b|\bILIKE\b|\bNOT\s+IN\b|\bIS\s+NOT\s+NULL\b|\bIS\s+NULL\b)/gi,
  );
}

function analyzeFixtureSource(source, filePath) {
  const path = relativePath(filePath);
  const errors = [];
  const isGlobalSetup = GLOBAL_SETUP_ALLOWLIST.has(path);
  const isSharedHelper = SHARED_HELPER_ALLOWLIST.has(path);
  const mutations = mutationMatches(source);
  const hasMutation = mutations.length > 0;
  const approvedHelpers = helperNamesInSource(source);
  const hasCleanupHelper = approvedHelpers.some((name) =>
    /^(?:bestEffortFixtureCleanup|cleanup|restore)/.test(name),
  );
  const hasWorkerQualifiedNamespace =
    /\b(?:workerQualifiedUserId|process\.pid|JEST_WORKER_ID)\b/.test(source);

  if (!isGlobalSetup && !isSharedHelper && hasMutation) {
    if (
      !hasCleanupHelper &&
      !hasLifecycleContract(source) &&
      !LEGACY_BROAD_CLEANUP_ALLOWLIST.has(path)
    ) {
      const mutation = mutations[0];
      errors.push({
        line: lineNumberAt(source, mutation.offset),
        message:
          "database mutation has no fixture lifecycle contract; add exact afterAll/afterEach/finally cleanup or use a canonical helper from __tests__/helpers/testDb",
      });
    }

    if (
      !hasCleanupHelper &&
      !hasExactCleanupEvidence(source) &&
      !LEGACY_BROAD_CLEANUP_ALLOWLIST.has(path)
    ) {
      const mutation = mutations[0];
      errors.push({
        line: lineNumberAt(source, mutation.offset),
        message:
          "database mutation has no exact ownership evidence; use a captured row ID, worker-qualified key, singleton snapshot/restore, or an approved shared helper",
      });
    }
  }

  if (
    !isGlobalSetup &&
    !isSharedHelper &&
    !MOCKED_GLOBAL_SETUP_TEST_ALLOWLIST.has(path)
  ) {
    for (const match of findAll(
      source,
      /\b(?:closePool|pool\s*\.\s*end|client\s*\.\s*end)\s*\(/g,
    )) {
      errors.push({
        line: lineNumberAt(source, match.offset),
        message:
          "shared database client shutdown is forbidden in integration fixtures; only standalone helper closePool may close its own pool",
      });
    }
  }

  if (!isGlobalSetup && !isSharedHelper) {
    for (const match of broadCleanupMatches(source)) {
      if (
        hasWorkerQualifiedNamespace ||
        LEGACY_BROAD_CLEANUP_ALLOWLIST.has(path)
      ) {
        continue;
      }
      errors.push({
        line: lineNumberAt(source, match.offset),
        message:
          "cleanup predicate can remove unowned rows; use captured IDs, exact worker-qualified keys, or document an intentional allowlist entry",
      });
    }
  }

  if (isGlobalSetup) {
    if (
      !/DATABASE_ENV=test/.test(source) ||
      !/databaseEnvironment\?\.trim\(\)\.toLowerCase\(\) !== ["']test["']/.test(
        source,
      )
    ) {
      errors.push({
        line: 1,
        message:
          "global database setup must fail closed unless DATABASE_ENV is exactly test",
      });
    }
    if (/\bDROP\s+(?:TABLE|FUNCTION)\b[\s\S]{0,160}\bCASCADE\b/i.test(source)) {
      errors.push({
        line: lineNumberAt(source, source.search(/\bCASCADE\b/i)),
        message:
          "global fixture cleanup must not use CASCADE; inspect dependencies explicitly instead",
      });
    }
  }

  return { path, mutations, approvedHelpers, errors };
}

function discoverIntegrationFiles(roots = integrationRoots) {
  const discoveredFiles = new Set();
  const visitedDirectories = new Set();

  function visit(directory) {
    if (visitedDirectories.has(directory)) {
      return;
    }
    visitedDirectories.add(directory);

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (IGNORED_DISCOVERY_DIRECTORIES.has(entry.name)) {
          continue;
        }
        visit(join(directory, entry.name));
        continue;
      }

      if (entry.isFile() && entry.name.endsWith(".integration.test.ts")) {
        discoveredFiles.add(join(directory, entry.name));
      }
    }
  }

  for (const root of roots) {
    visit(root);
  }

  return [...discoveredFiles].sort();
}

function report(errors, fallbackPath) {
  return errors
    .map(
      ({ path, line, message }) =>
        `API fixture ownership contract: ${path ?? fallbackPath}:${line} — ${message}`,
    )
    .join("\n");
}

function assertFixtureContract(filePath, source) {
  const result = analyzeFixtureSource(source, filePath);
  assert.equal(result.errors.length, 0, report(result.errors, result.path));
  return result;
}

// Regression checks for the guard itself. These keep the contract from
// silently becoming permissive when its source patterns are changed.
const syntheticPath = join(
  apiServerRoot,
  "__tests__",
  "synthetic.integration.test.ts",
);
assert.match(
  report(
    analyzeFixtureSource(
      "beforeAll(async () => { await db.insert(inventoryTable).values({ catalog: 'JEST-X' }); });",
      syntheticPath,
    ).errors,
    relativePath(syntheticPath),
  ),
  /no fixture lifecycle contract/,
);
assert.match(
  report(
    analyzeFixtureSource(
      "afterAll(async () => { await db.delete(inventoryTable).where(sql`catalog LIKE 'JEST-%'`); });",
      syntheticPath,
    ).errors,
    relativePath(syntheticPath),
  ),
  /cleanup predicate can remove unowned rows/,
);
assert.match(
  report(
    analyzeFixtureSource(
      "afterAll(async () => { await pool.end(); });",
      syntheticPath,
    ).errors,
    relativePath(syntheticPath),
  ),
  /shared database client shutdown is forbidden/,
);
assert.equal(
  analyzeFixtureSource(
    [
      'import { cleanupFixtures } from "./helpers/testDb";',
      "beforeAll(async () => { await seedFixtures([]); });",
      "afterAll(async () => { await cleanupFixtures(); });",
    ].join("\n"),
    syntheticPath,
  ).errors.length,
  0,
);
assert.equal(
  analyzeFixtureSource(
    "afterAll(async () => { await db.delete(inventoryTable).where(eq(inventoryTable.id, insertedId)); });",
    syntheticPath,
  ).errors.length,
  0,
);
assert.match(
  report(
    analyzeFixtureSource(
      [
        "function cleanupFixtures() {}",
        "beforeAll(async () => { await db.insert(inventoryTable).values({ catalog: 'JEST-X' }); });",
        "afterAll(async () => { await cleanupFixtures(); });",
      ].join("\n"),
      syntheticPath,
    ).errors,
    relativePath(syntheticPath),
  ),
  /no exact ownership evidence/,
);

const nestedDiagnosticPath = join(
  apiServerRoot,
  "__tests__",
  "nested",
  "synthetic.integration.test.ts",
);
const nestedDiagnosticResult = analyzeFixtureSource(
  [
    "beforeAll(async () => {",
    "  await db.insert(inventoryTable).values({ catalog: 'JEST-NESTED' });",
    "});",
  ].join("\n"),
  nestedDiagnosticPath,
);
assert.ok(
  report(
    nestedDiagnosticResult.errors,
    relativePath(nestedDiagnosticPath),
  ).includes(`${relativePath(nestedDiagnosticPath)}:2 —`),
  "Fixture diagnostics must retain nested suite paths and source lines.",
);

const discoveryFixtureRoot = mkdtempSync(
  join(tmpdir(), "api-fixture-ownership-contract-"),
);
try {
  const nestedFixtureDirectory = join(
    discoveryFixtureRoot,
    "__tests__",
    "nested",
    "deep",
  );
  const helperFixtureDirectory = join(
    discoveryFixtureRoot,
    "__tests__",
    "helpers",
  );
  const generatedFixtureDirectory = join(
    discoveryFixtureRoot,
    "__tests__",
    "generated",
  );
  mkdirSync(nestedFixtureDirectory, { recursive: true });
  mkdirSync(helperFixtureDirectory, { recursive: true });
  mkdirSync(generatedFixtureDirectory, { recursive: true });

  const nestedFixturePath = join(
    nestedFixtureDirectory,
    "nested.integration.test.ts",
  );
  writeFileSync(nestedFixturePath, "");
  writeFileSync(join(helperFixtureDirectory, "helper.integration.test.ts"), "");
  writeFileSync(
    join(generatedFixtureDirectory, "generated.integration.test.ts"),
    "",
  );

  const discoveredSyntheticFiles = discoverIntegrationFiles([
    join(discoveryFixtureRoot, "__tests__"),
    nestedFixtureDirectory,
  ]);
  assert.deepEqual(
    discoveredSyntheticFiles,
    [nestedFixturePath],
    "Nested integration suites must be included once while helper and generated files stay excluded.",
  );
} finally {
  rmSync(discoveryFixtureRoot, { recursive: true, force: true });
}

const fixtureFiles = discoverIntegrationFiles();
assert.ok(
  fixtureFiles.length > 0,
  "Fixture ownership discovery found no integration suites; update the guard if the test layout changes.",
);

const results = fixtureFiles.map((filePath) =>
  assertFixtureContract(filePath, readFileSync(filePath, "utf8")),
);
assert.equal(
  results.length,
  new Set(results.map(({ path }) => path)).size,
  "Fixture ownership discovery must not scan an integration suite twice.",
);

assertFixtureContract(sharedTestDbPath, readFileSync(sharedTestDbPath, "utf8"));
assertFixtureContract(globalSetupPath, readFileSync(globalSetupPath, "utf8"));

assert.ok(
  results.some(({ mutations }) => mutations.length > 0),
  "Fixture ownership discovery found no database mutations; update the guard if the fixture API changes.",
);

console.log(
  `API fixture ownership contract passed for ${fixtureFiles.length} integration suites, shared test helpers, and Jest global setup.`,
);
