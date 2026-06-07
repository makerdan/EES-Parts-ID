# Production Data-Load Runbook

## Context

Migration `0016_zone_section_num_fix.sql` corrects `section_num` values in
`warehouse_zone` for all numeric aisles (13–22). It does this with two UPDATE
statements that reference specific zone row IDs (431–935).

**Problem:** Drizzle runs all pending migrations — including 0016 — during
`post-merge.sh` (`pnpm --filter db push --force`). If the production database
is empty at that point, the UPDATE statements in 0016 match zero rows and are
effectively no-ops. When zone data is loaded later, the `section_num` values
will be the raw sequential values from the import rather than the spatially
correct ones, and the **Map it!** feature will show wrong section numbers for
all numeric aisles.

## Required steps after loading zone data into production

Run the fix immediately after any bulk zone data load:

```bash
DATABASE_URL="$PROD_DATABASE_URL" \
  pnpm --filter @workspace/api-server exec tsx src/scripts/apply-zone-section-fix.ts
```

The script re-applies both UPDATE statements from `0016_zone_section_num_fix.sql`
and reports how many rows were affected. If the count is 0, the zone data was
not present when the script ran — recheck that zones were loaded first.

### What the script does

1. Negates all existing `section_num` values for numeric aisles (step 1 of 0016 — clears unique-index slots)
2. Re-assigns the correct spatial `section_num` for each known zone ID (step 2 of 0016)
3. Prints a row count so you can confirm it had an effect

### Checklist

- [ ] Schema migrations applied (`pnpm --filter db push --force`)
- [ ] Zone data loaded into `warehouse_zone` (via API import or direct SQL)
- [ ] `apply-zone-section-fix.ts` run against the production database
- [ ] Verify: open the warehouse map in the app and confirm aisles 13–22 show correct section labels

## Relevant files

- `lib/db/drizzle/0016_zone_section_num_fix.sql` — the canonical SQL
- `artifacts/api-server/src/scripts/apply-zone-section-fix.ts` — the runnable script
- `scripts/post-merge.sh` — where drizzle push runs on every merge
