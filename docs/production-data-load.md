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

**This is now handled automatically.** The API server startup migration
(`applyZoneSectionNumFix` in `artifacts/api-server/src/index.ts`) re-applies
the fix on every server boot, and the tracked Drizzle migration
`lib/db/drizzle/0033_zone_section_num_refix.sql` ensures the correction is
also applied during any fresh `push`. No manual script step is required after
loading zone data.

## Required steps after loading zone data into production

1. Load zone data into `warehouse_zone` (via API import or direct SQL).
2. Restart the API server (or let it restart automatically after deploy). The
   startup migration runs automatically and applies the `section_num` fix.
3. Verify: open the warehouse map in the app and confirm aisles 13–22 show
   correct section labels.

### Checklist

- [ ] Schema migrations applied (`pnpm --filter db push --force`)
- [ ] Zone data loaded into `warehouse_zone` (via API import or direct SQL)
- [ ] API server restarted (startup migration runs `applyZoneSectionNumFix` automatically)
- [ ] Verify: open the warehouse map in the app and confirm aisles 13–22 show correct section labels

## Relevant files

- `lib/db/drizzle/0016_zone_section_num_fix.sql` — the original canonical SQL
- `lib/db/drizzle/0033_zone_section_num_refix.sql` — tracked Drizzle migration (replacement)
- `artifacts/api-server/src/index.ts` — startup migration (`applyZoneSectionNumFix`)
- `scripts/post-merge.sh` — where drizzle push runs on every merge
