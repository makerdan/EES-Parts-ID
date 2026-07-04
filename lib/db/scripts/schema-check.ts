#!/usr/bin/env tsx
/**
 * Drift check: verify every column defined in the Drizzle TypeScript schema
 * has a corresponding DDL statement in the committed SQL migration files.
 *
 * Exits 0 when schema and migrations are in sync.
 * Exits 1 when any table/column is missing from migrations, printing which
 * items are absent so the developer knows what to generate.
 *
 * Strategy: use drizzle-orm's getTableColumns helper + Symbol.for("drizzle:Name")
 * to enumerate all (table, column) pairs from the TypeScript schema, then scan
 * the SQL migration files for matching DDL.  This avoids the drizzle-kit
 * snapshot mechanism entirely, which is important because this project's meta
 * snapshot pre-dates many manually-written migrations.
 */
import { readdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { getTableColumns } from "drizzle-orm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(__dirname, "..");
const MIGRATIONS_DIR = join(DB_DIR, "drizzle");

// ---------------------------------------------------------------------------
// 1. Load every table exported from the schema index.
// ---------------------------------------------------------------------------
const schemaModule = (await import("../src/schema/index.ts")) as Record<
  string,
  unknown
>;

// drizzle-orm tags table objects with this symbol.
const DRIZZLE_NAME_SYMBOL = Symbol.for("drizzle:Name");

interface ColumnEntry {
  tableName: string;
  columnName: string;
}

const tableNames: string[] = [];
const columns: ColumnEntry[] = [];

for (const value of Object.values(schemaModule)) {
  if (value === null || typeof value !== "object") continue;
  if (!(DRIZZLE_NAME_SYMBOL in value)) continue;

  const tableName = (value as Record<symbol, unknown>)[
    DRIZZLE_NAME_SYMBOL
  ] as string;
  if (!tableName || typeof tableName !== "string") continue;

  tableNames.push(tableName);

  // getTableColumns returns an object keyed by field name; the .name property
  // is the actual SQL column name (snake_case).
  const cols = getTableColumns(value as Parameters<typeof getTableColumns>[0]);
  for (const col of Object.values(cols)) {
    const colName = (col as { name: string }).name;
    if (colName) {
      columns.push({ tableName, columnName: colName });
    }
  }
}

if (tableNames.length === 0) {
  console.error(
    "ERROR: No drizzle tables found in schema — check the import path."
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Concatenate all committed SQL migration files.
// ---------------------------------------------------------------------------
let sqlFiles: string[];
try {
  sqlFiles = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
} catch {
  console.error(
    `ERROR: Cannot read migrations directory: ${MIGRATIONS_DIR}`
  );
  process.exit(1);
}

if (sqlFiles.length === 0) {
  console.error(
    "ERROR: No SQL migration files found in the drizzle/ directory."
  );
  process.exit(1);
}

const allSQL = sqlFiles
  .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf-8"))
  .join("\n")
  .toLowerCase();

// ---------------------------------------------------------------------------
// 3. Check each table exists in migrations.
// ---------------------------------------------------------------------------
const missingTables: string[] = [];

for (const tableName of tableNames) {
  // A table must appear as a quoted identifier in at least one migration.
  if (!allSQL.includes(`"${tableName}"`)) {
    missingTables.push(tableName);
  }
}

// ---------------------------------------------------------------------------
// 4. Check each column exists in migrations (skip columns of missing tables).
// ---------------------------------------------------------------------------
const missingColumns: ColumnEntry[] = [];

for (const entry of columns) {
  if (missingTables.includes(entry.tableName)) continue;
  if (!allSQL.includes(`"${entry.columnName}"`)) {
    missingColumns.push(entry);
  }
}

// ---------------------------------------------------------------------------
// 5. Report.
// ---------------------------------------------------------------------------
if (missingTables.length === 0 && missingColumns.length === 0) {
  console.log(
    `OK  Schema and migrations are in sync (${tableNames.length} tables, ` +
      `${columns.length} columns checked).`
  );
  process.exit(0);
}

console.error("");
console.error(
  "FAIL  Drizzle schema has changes not present in committed migrations."
);
console.error("");

if (missingTables.length > 0) {
  console.error("Tables defined in schema but missing from migrations:");
  for (const t of missingTables) {
    console.error(`  - ${t}`);
  }
  console.error("");
}

if (missingColumns.length > 0) {
  console.error("Columns defined in schema but missing from migrations:");
  for (const c of missingColumns) {
    console.error(`  - ${c.tableName}.${c.columnName}`);
  }
  console.error("");
}

console.error(
  "To fix: generate a migration for the missing changes and commit it:"
);
console.error("  pnpm --filter @workspace/db run generate");
process.exit(1);
