#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter db push

# Re-seed dictionaries (fast, idempotent — always run to pick up new entries)
cd artifacts/api-server
DATABASE_URL="$DATABASE_URL" pnpm exec tsx src/seed/run.ts

# Import spreadsheet if inventory table is empty (idempotent upsert)
ROW_COUNT=$(psql "$DATABASE_URL" -t -c "SELECT COUNT(*) FROM inventory;" 2>/dev/null | tr -d ' \n' || echo "0")
if [ "$ROW_COUNT" = "0" ]; then
  echo "Inventory is empty — importing spreadsheet..."
  DATABASE_URL="$DATABASE_URL" pnpm exec tsx src/seed/import-spreadsheet.ts
else
  echo "Inventory already has $ROW_COUNT rows — skipping spreadsheet import."
fi
cd ../..
