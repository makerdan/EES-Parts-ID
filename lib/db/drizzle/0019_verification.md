# Migration 0019 — expanded_description verification log

**Date:** 2026-06-11  
**Migration file:** `lib/db/drizzle/0019_expanded_description.sql`

---

## Summary

The `expanded_description` column and FTS GIN index are ready in dev.  
**Production verification is pending a user-initiated Publish** — the Replit  
Publish flow diffs dev vs. prod schemas and applies the SQL automatically.

---

## Dev verification (2026-06-11T21:11:11Z)

### 1. Column present

```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'inventory'
  AND column_name  = 'expanded_description';
```

Result:

```
column_name          | data_type | is_nullable
expanded_description | text      | YES
```

✅ Column present in dev.

### 2. FTS GIN index present and covering expanded_description

```sql
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename  = 'inventory'
  AND indexname  = 'inventory_fts_idx';
```

Result:

```
inventory_fts_idx | CREATE INDEX inventory_fts_idx ON public.inventory
  USING gin (to_tsvector('english'::regconfig,
    ((((((((COALESCE(vendor, ''::text) || ' '::text)
       || COALESCE(catalog, ''::text)) || ' '::text)
       || COALESCE(description, ''::text)) || ' '::text)
       || COALESCE(expanded_description, ''::text)) || ' '::text)
       || immutable_array_to_string(ai_keywords, ' '::text))))
```

✅ Index covers `expanded_description`.

### 3. EXPLAIN confirms index scan (not seq scan)

```sql
EXPLAIN (FORMAT TEXT)
SELECT id, vendor, catalog, description, expanded_description
FROM inventory
WHERE to_tsvector('english',
    coalesce(vendor,'') || ' ' || coalesce(catalog,'') || ' ' ||
    coalesce(description,'') || ' ' ||
    coalesce(expanded_description,'') || ' ' ||
    immutable_array_to_string(ai_keywords,' ')
) @@ plainto_tsquery('english','circuit breaker')
LIMIT 10;
```

Result:

```
Limit  (cost=7.02..8.65 rows=1 width=81)
  ->  Bitmap Heap Scan on inventory  (cost=7.02..8.65 rows=1 width=81)
        Recheck Cond: (to_tsvector(...) @@ '''circuit'' & ''breaker'''::tsquery)
        ->  Bitmap Index Scan on inventory_fts_idx  (cost=0.00..7.02 rows=1 width=0)
              Index Cond: (to_tsvector(...) @@ '''circuit'' & ''breaker'''::tsquery)
```

✅ Planner uses **Bitmap Index Scan on `inventory_fts_idx`** — no sequential scan.

### 4. API routes

- `POST /inventory/expand-descriptions` — admin-only SSE stream, queries  
  `WHERE expanded_description IS NULL`, calls OpenAI, streams results back.
- `PATCH /inventory/:id/expanded-description` — saves approved expansion,  
  invalidates the reference-answer cache.

✅ Both routes correctly reference `inventoryTable.expandedDescription`.

---

## Issue found and fixed during verification

The Replit auto-migration (post-merge schema diff) applied **only the column  
addition** from drizzle's schema model. The raw DDL in `0019_expanded_description.sql`  
that rebuilds `inventory_fts_idx` was **not executed automatically** — the index  
was silently absent from dev.

Fix applied: manually executed the `DROP INDEX IF EXISTS … CREATE INDEX …`  
block from the migration against the dev database.  
The same SQL will be executed against production by the Publish flow.

---

## Production status (pre-publish)

```sql
-- run with environment: "production"
SELECT column_name FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'inventory'
  AND column_name = 'expanded_description';
```

Result: *(empty — column not yet present)*

**Action required:** click **Publish** in the Replit UI. The platform will apply  
`0019_expanded_description.sql` to production automatically. After publish, re-run  
the column check and EXPLAIN above to confirm production matches dev.
