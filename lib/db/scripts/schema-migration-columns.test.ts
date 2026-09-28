import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  collectMigrationColumns,
  findMissingColumns,
} from "./schema-migration-columns.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(__dirname, "..");
const MIGRATIONS_DIR = join(DB_DIR, "drizzle");
const SCHEMA_CHECK = join(__dirname, "schema-check.ts");
const TSX_CLI = join(DB_DIR, "node_modules/tsx/dist/cli.mjs");

test("a column on another table does not satisfy the target table", () => {
  const fixture = readFileSync(
    join(__dirname, "../drizzle/fixtures/schema-check-shared-column.sql"),
    "utf8",
  );
  const migrationColumns = collectMigrationColumns(fixture);

  assert.equal(migrationColumns.get("other_table")?.has("shared_column"), true);
  assert.equal(
    migrationColumns.get("target_table")?.has("shared_column") ?? false,
    false,
  );
  assert.deepEqual(
    findMissingColumns(
      [{ tableName: "target_table", columnName: "shared_column" }],
      migrationColumns,
    ),
    [{ tableName: "target_table", columnName: "shared_column" }],
  );
});

test("ADD COLUMN remains associated with its ALTER TABLE target", () => {
  const migrationColumns = collectMigrationColumns(`
    ALTER TABLE "target_table"
      ADD COLUMN IF NOT EXISTS "shared_column" text;
  `);

  assert.equal(migrationColumns.get("target_table")?.has("shared_column"), true);
  assert.equal(
    migrationColumns.get("other_table")?.has("shared_column") ?? false,
    false,
  );
  assert.deepEqual(
    findMissingColumns(
      [{ tableName: "target_table", columnName: "shared_column" }],
      migrationColumns,
    ),
    [],
  );
});

test("schema-check reports every missing column in one run", () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "schema-check-migrations-"));

  try {
    for (const fileName of readdirSync(MIGRATIONS_DIR)) {
      if (!fileName.endsWith(".sql")) continue;

      let sql = readFileSync(join(MIGRATIONS_DIR, fileName), "utf8");
      if (fileName === "0044_inventory_snapshot_audit.sql") {
        for (const missingColumn of [
          '  "snapshot_id" text NOT NULL,\n',
          '  "action" text NOT NULL,\n',
        ]) {
          assert.equal(sql.includes(missingColumn), true);
          sql = sql.replace(missingColumn, "");
        }
      }
      writeFileSync(join(fixtureDir, fileName), sql);
    }

    const result = spawnSync(process.execPath, [TSX_CLI, SCHEMA_CHECK], {
      cwd: DB_DIR,
      encoding: "utf8",
      env: {
        ...process.env,
        SCHEMA_CHECK_MIGRATIONS_DIR: fixtureDir,
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /inventory_snapshot_audit\.snapshot_id/);
    assert.match(result.stderr, /inventory_snapshot_audit\.action/);
    assert.equal(
      result.stderr.match(/inventory_snapshot_audit\.(snapshot_id|action)/g)
        ?.length,
      2,
    );
    assert.match(result.stderr, /pnpm --filter @workspace\/db run generate/);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("schema-check rejects a missing table with complete repair guidance", () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "schema-check-migrations-"));

  try {
    for (const fileName of readdirSync(MIGRATIONS_DIR)) {
      if (!fileName.endsWith(".sql")) continue;

      const sql =
        fileName === "0044_inventory_snapshot_audit.sql" ||
        fileName === "0047_manual_inventory_backup_status.sql" ||
        fileName === "0048_manual_inventory_backup_lease.sql"
          ? ""
          : readFileSync(join(MIGRATIONS_DIR, fileName), "utf8");
      writeFileSync(join(fixtureDir, fileName), sql);
    }

    const result = spawnSync(process.execPath, [TSX_CLI, SCHEMA_CHECK], {
      cwd: DB_DIR,
      encoding: "utf8",
      env: {
        ...process.env,
        SCHEMA_CHECK_MIGRATIONS_DIR: fixtureDir,
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /Tables defined in schema but missing from migrations:/,
    );
    assert.match(result.stderr, /^\s+- inventory_snapshot_audit$/m);
    for (const columnName of [
      "id",
      "admin_clerk_user_id",
      "snapshot_id",
      "action",
      "row_count",
      "outcome",
      "created_at",
      "lease_expires_at",
    ]) {
      assert.match(
        result.stderr,
        new RegExp(`inventory_snapshot_audit\\.${columnName}`),
      );
    }
    assert.match(
      result.stderr,
      /To fix missing tables: add a CREATE TABLE migration/,
    );
    assert.match(result.stderr, /pnpm --filter @workspace\/db run generate/);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
