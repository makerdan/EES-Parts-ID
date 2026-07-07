---
name: drizzle generate broken — hand-write SQL migrations
description: In lib/db, drizzle-kit generate fails (partial meta snapshots); add columns by hand-writing a new drizzle/NNNN_*.sql and rely on schema:check scanning quoted identifiers.
---

`pnpm --filter @workspace/db run generate` is BROKEN in this repo: `drizzle/meta/`
only contains `0001_snapshot.json` + a partial `_journal.json`, so drizzle-kit
cannot diff against a current snapshot. Do NOT try to fix generate.

**How to add a column/table:** edit the TS schema in `lib/db/src/schema/`, then
hand-write the next migration file `lib/db/drizzle/NNNN_<name>.sql` with plain DDL
using `ADD COLUMN IF NOT EXISTS "col" <type> ...` (quoted, snake_case names). Apply
to the dev DB with `pnpm --filter @workspace/db run push` (drizzle-kit push works;
only generate is broken).

**Why the SQL file is still required:** `schema:check` (lib/db/scripts/schema-check.ts)
does NOT use drizzle snapshots — it enumerates every (table, column) from the TS
schema and asserts each appears as a quoted identifier `"col"` somewhere in the
concatenated `drizzle/*.sql`. A schema column with no matching quoted name in any
.sql file fails the check. So every new column needs its snake_case name present,
quoted, in a committed migration file — that is the whole contract.

**How to apply:** any time you add columns/tables to the drizzle schema here.
