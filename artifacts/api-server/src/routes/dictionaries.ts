/**
 * Dictionary lookup endpoints (abbreviations, vendors, synonyms,
 * misspellings, slang). All read-only and cached aggressively on the
 * client — the maps change on a per-deploy cadence, not per-request.
 */
import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  abbreviationMapTable,
  vendorMapTable,
  synonymMapTable,
  misspellingMapTable,
  electricalSlangMapTable,
} from "@workspace/db";

const router = Router();

// GET /dictionaries/lookup?term=...
router.get("/lookup", async (req, res) => {
  try {
    const term = String(req.query["term"] ?? "").toLowerCase().trim();
    if (!term) return void res.status(400).json({ error: "term is required" });

    const [abbrevs, vendorRows, synonymRows, misspellingRow, slangRows] = await Promise.all([
      db
        .select()
        .from(abbreviationMapTable)
        .where(sql`LOWER(${abbreviationMapTable.abbreviation}) = ${term}`)
        .limit(5),
      db
        .select()
        .from(vendorMapTable)
        .where(
          sql`LOWER(${vendorMapTable.code}) = ${term} OR ${term} = ANY(SELECT LOWER(unnest(${vendorMapTable.names})))`,
        )
        .limit(5),
      db
        .select()
        .from(synonymMapTable)
        .where(
          sql`LOWER(${synonymMapTable.term}) = ${term} OR ${term} = ANY(SELECT LOWER(unnest(${synonymMapTable.synonyms})))`,
        )
        .limit(10),
      db
        .select()
        .from(misspellingMapTable)
        .where(sql`LOWER(${misspellingMapTable.misspelling}) = ${term}`)
        .limit(1),
      db
        .select()
        .from(electricalSlangMapTable)
        .where(
          sql`LOWER(${electricalSlangMapTable.slangTerm}) = ${term}`,
        )
        .limit(5),
    ]);

    res.json({
      abbreviations: abbrevs.flatMap(a => a.expansions),
      synonyms: synonymRows.flatMap(s => s.synonyms),
      correction: misspellingRow[0]?.correction ?? null,
      vendorNames: vendorRows.flatMap(v => v.names),
      slangTerms: slangRows.flatMap(s => s.standardTerms),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Lookup failed" });
  }
});

export default router;
