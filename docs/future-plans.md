# Future Plans

This document parks deferred feature ideas with context on why they were held and when to revisit them. It is not a backlog — items here are intentionally out of scope for the near term.

---

## Help Modal / In-App Guidance

### Why it was deferred

The app has several non-obvious gestures (long-press cycle counting, multi-photo Photo ID, map pinning) and an AI layer that is still evolving. Building help content before those surfaces stabilize would mean rewriting the copy on every significant change. The cost-to-value ratio is poor until the feature set settles and real user confusion signals are available.

### When to revisit

- After Reference AI ships and the full set of AI capabilities is documented in one place
- After at least one cycle of user feedback that surfaces specific confusion points
- When the gesture surface stops changing frequently enough that copy can be written once and trusted

### Recommendations

1. **Prioritize non-obvious gestures first.** Long-press to start a cycle count, multi-photo capture in Photo ID, and map pinning are the interactions users are least likely to discover on their own. Start there rather than documenting obvious flows.

2. **Scope to a lightweight modal, not a step-through onboarding tour.** A "?" button that opens a screen-aware cheat sheet is easier to build, easier to maintain, and less intrusive than a guided tour. Users can consult it on demand rather than sitting through upfront instruction they may not need.

3. **Write copy after Reference AI ships.** The AI feature set spans Photo ID, enrichment, search fallback, and the Reference assistant. Documenting them piecemeal will produce a fragmented help experience. Wait until they are all live and describe them together in one place.

4. **Consider a "What's New" variant instead of full documentation.** A brief changelog surface (e.g., a banner on first launch after an update) is cheaper to maintain than a comprehensive help doc and may address the same problem — users not knowing a feature exists — without requiring an exhaustive content effort.

5. **Measure before building.** Add a simple feedback mechanism (a thumbs-down on a result, a "Was this helpful?" prompt, or just watching support volume) before writing any copy. Real confusion signals should drive the content, not assumptions about what users will find hard.

---

## Schedule Nightly ANALYZE for Search Performance

### Why it was deferred

The current post-import `ANALYZE` covers the main path: after a bulk import, statistics are refreshed and full-text search stays fast. The concern is that incremental edits between imports may cause `reltuples` and other planner statistics to drift over time, gradually degrading search quality. However, the actual impact of that drift in production has not been measured. Adding `pg_cron` (required for a scheduled database job) introduces a dependency with non-trivial operational overhead, and committing to it before the problem is confirmed would be premature.

### When to revisit

- When production query plans or search latency metrics show inter-import degradation that cannot be explained by data volume alone
- When `reltuples` drift is measured and confirmed to be meaningful (not just theoretical)
- When `pg_cron` becomes low-cost to add — for example, if another scheduled job already justifies the dependency
- When the import cadence drops significantly and incremental edits become the dominant write pattern

### Recommendations

1. **Measure reltuples drift before committing.** Run `SELECT reltuples FROM pg_class WHERE relname = 'parts'` (or the relevant table) before and after a typical week of incremental edits. If drift is small, the scheduled job may not be worth the complexity.

2. **Deliver as a database migration, not a startup hook.** Registering a `pg_cron` job inside application startup code creates a race condition on redeployment (multiple instances may attempt registration simultaneously). The job should be created once, in a versioned migration.

3. **Verify with the existing FTS smoke-test.** The `pnpm --filter @workspace/db run verify-fts` smoke-test should be run after enabling the scheduled job to confirm search still returns expected results on the nightly cadence.

4. **Scope narrowly — ANALYZE only, not VACUUM ANALYZE.** A nightly `ANALYZE` on the search-relevant tables is sufficient to refresh planner statistics. A full `VACUUM ANALYZE` is heavier and should remain under autovacuum control unless autovacuum is explicitly found to be insufficient.
