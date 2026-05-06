/**
 * Seed script — populates the `synonym_group` table from the three existing
 * lookup tables (`synonym_map`, `electrical_slang_map`, `vendor_map`).
 *
 * Idempotent: rows are upserted by canonical term, so re-running is safe.
 * Vendor entries are stored as bidirectional groups: canonical = lowercased
 * code, synonyms = all full names, so both "SIE" and "siemens" in a row's
 * text expand to all group members.
 *
 * Usage (from workspace root):
 *   DATABASE_URL="$DATABASE_URL" \
 *   pnpm --filter @workspace/api-server exec tsx src/seed/synonym_group.ts
 */

import { db, pool } from "@workspace/db";
import {
  synonymGroupTable,
  synonymMapTable,
  electricalSlangMapTable,
  vendorMapTable,
} from "@workspace/db";
import { sql } from "drizzle-orm";

async function seedSynonymGroups() {
  console.log("Loading source tables…");

  const [synonymRows, slangRows, vendorRows] = await Promise.all([
    db.select().from(synonymMapTable),
    db.select().from(electricalSlangMapTable),
    db.select().from(vendorMapTable),
  ]);

  console.log(
    `  synonym_map: ${synonymRows.length}  ` +
    `electrical_slang_map: ${slangRows.length}  ` +
    `vendor_map: ${vendorRows.length}`,
  );

  // ── Build upsert rows ───────────────────────────────────────────────────────
  type UpsertRow = {
    canonical: string;
    synonyms: string[];
    categoryHint: string | null;
    notes: string | null;
  };

  const rows: UpsertRow[] = [];

  // synonym_map → canonical = term, synonyms = synonyms, category_hint = category
  for (const r of synonymRows) {
    rows.push({
      canonical: r.term.toLowerCase(),
      synonyms: r.synonyms.map(s => s.toLowerCase()),
      categoryHint: r.category || null,
      notes: null,
    });
  }

  // electrical_slang_map → canonical = slang_term, synonyms = standard_terms
  for (const r of slangRows) {
    const canonical = r.slangTerm.toLowerCase();
    // Don't duplicate if already added from synonym_map
    const alreadyAdded = rows.some(x => x.canonical === canonical);
    if (!alreadyAdded) {
      rows.push({
        canonical,
        synonyms: r.standardTerms.map(s => s.toLowerCase()),
        categoryHint: r.category || null,
        notes: r.notes || null,
      });
    }
  }

  // vendor_map → one bidirectional group per vendor:
  //   canonical = lowercased code, synonyms = all names lowercased
  for (const r of vendorRows) {
    const canonical = r.code.toLowerCase();
    const alreadyAdded = rows.some(x => x.canonical === canonical);
    if (!alreadyAdded) {
      rows.push({
        canonical,
        synonyms: r.names.map(n => n.toLowerCase()),
        categoryHint: "vendor",
        notes: null,
      });
    }
  }

  console.log(`\nUpserting ${rows.length} synonym_group rows…`);

  // Batch upsert in chunks to avoid oversized queries
  const CHUNK = 100;
  let inserted = 0;
  let updated = 0;

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const result = await db
      .insert(synonymGroupTable)
      .values(chunk)
      .onConflictDoUpdate({
        target: synonymGroupTable.canonical,
        set: {
          synonyms: sql`excluded.synonyms`,
          categoryHint: sql`excluded.category_hint`,
          notes: sql`excluded.notes`,
          updatedAt: sql`now()`,
        },
      })
      .returning({ id: synonymGroupTable.id });

    // All returned rows were either inserted or updated; we can't easily
    // distinguish without a separate count, so just track total.
    inserted += result.length;
    process.stdout.write(`  ${Math.min(i + CHUNK, rows.length)}/${rows.length}\r`);
  }

  console.log(`\nDone — ${inserted} rows upserted into synonym_group.`);

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(synonymGroupTable);
  console.log(`synonym_group now has ${total} rows.`);
}

seedSynonymGroups()
  .catch((err) => {
    console.error("synonym_group seed failed:", err);
    process.exit(1);
  })
  .finally(() => pool.end());
