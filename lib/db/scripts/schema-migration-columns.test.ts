import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  collectMigrationColumns,
  findMissingColumns,
} from "./schema-migration-columns.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

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