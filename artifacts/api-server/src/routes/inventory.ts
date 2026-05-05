/**
 * Inventory routes — search, list, batch upsert, AI enrichment, per-item
 * keyword edits. The search endpoint runs a hybrid pg_trgm + ilike query
 * and returns dimension counts so the mobile app can render filter chips
 * without a second round-trip.
 */
import { Router } from "express";
import { eq, sql, ilike, or, and, desc } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  inventoryTable,
  abbreviationMapTable,
  vendorMapTable,
  synonymMapTable,
  misspellingMapTable,
  electricalSlangMapTable,
} from "@workspace/db";
import { batchProcessWithSSE } from "@workspace/integrations-openai-ai-server/batch";
import { getIndex as getInventoryFuseIndex } from "../lib/inventoryIndex";
import { verifyAdminToken } from "./admin";
import { expandMeasurements } from "../utils/measurementConversion";
import {
  normalizeMeasurement,
  parseCatalogNumber,
  correctMisspelling,
  extractSizeValue,
  getSeriesBase,
  itemFullText,
  tokenMatch,
  matchesChipFilters,
} from "../utils/searchHelpers";
import { generateKeywords } from "../utils/generateKeywords";
import { suggestDescription } from "../utils/suggestDescription";
import {
  buildVendorFullNameMap,
  lookupVendorFullName,
  withVendorFullName,
} from "../utils/vendorFullName";
import {
  blendPgScore,
  catalogScore,
  applyVendorBoost,
  shouldUpdateScore,
  fuseConfidence,
} from "../utils/scoreHelpers";
import { mergeBins, dedupeBinsCaseInsensitive } from "../utils/binLocations";
import { deriveTradeSizeTokens, parseTradeSizeInches, tradeSizeChipLabel } from "../utils/tradeSize";
import { classifyHandler } from "./categories";
import {
  categoryNodeTable,
  inventoryCategoryTable,
} from "@workspace/db";

const router = Router();

// ── GET /inventory/version ────────────────────────────────────────────────────
router.get("/version", async (_req, res) => {
  try {
    const result = await db
      .select({ updatedAt: sql<string>`MAX(updated_at)` })
      .from(inventoryTable);
    const updatedAt = result[0]?.updatedAt ?? null;
    res.json({ updatedAt });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to get inventory version" });
  }
});

// ── GET /inventory ────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query["page"] as string) || 1);
    const limit = Math.min(1000, Math.max(1, parseInt(req.query["limit"] as string) || 50));
    const offset = (page - 1) * limit;
    const unenrichedOnly = req.query["unenrichedOnly"] === "true";
    const whereClause = unenrichedOnly
      ? sql`${inventoryTable.enrichedAt} IS NULL`
      : undefined;

    const [items, countResult, vendors] = await Promise.all([
      whereClause
        ? db.select().from(inventoryTable).where(whereClause).limit(limit).offset(offset).orderBy(inventoryTable.vendor, inventoryTable.catalog)
        : db.select().from(inventoryTable).limit(limit).offset(offset).orderBy(inventoryTable.vendor, inventoryTable.catalog),
      whereClause
        ? db.select({ count: sql<number>`count(*)` }).from(inventoryTable).where(whereClause)
        : db.select({ count: sql<number>`count(*)` }).from(inventoryTable),
      db.select({ code: vendorMapTable.code, names: vendorMapTable.names }).from(vendorMapTable),
    ]);

    const vendorFullNameMap = buildVendorFullNameMap(vendors);

    res.json({
      items: items.map(item => withVendorFullName({
        ...item,
        binLocations: item.binLocations ?? [],
        aiKeywords: item.aiKeywords ?? [],
      }, vendorFullNameMap)),
      total: Number(countResult[0]?.count ?? 0),
      page,
      limit,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to list inventory" });
  }
});

// ── POST /inventory/search ────────────────────────────────────────────────────
// ── 16 required chip dimensions (must mirror FilterPanel.tsx CHIP_DIMS) ───────
const CHIP_DIMS_SERVER = [
  { key: "category",      options: ["Receptacle","Switch","Breaker","Wire","Conduit","Fitting","Box","Panel","Transformer","Fuse","Lighting","Motor","Connector","Dimmer","Sensor","Enclosure"] },
  { key: "amperage",      options: ["15A","20A","30A","40A","50A","60A","100A","150A","200A","400A"] },
  { key: "colorChip",     options: ["White","Black","Gray","Ivory","Almond","Red","Blue","Brown","Orange","Yellow"] },
  { key: "manufacturer",  options: ["Eaton","Square D","Hubbell","Leviton","Siemens","GE","Legrand","Cooper","Lutron","3M","Panduit","T&B","Belden","Southwire","ABB","Rockwell"] },
  { key: "sizeChip",      options: ['1/2"','3/4"','1"','1-1/4"','1-1/2"','2"','2-1/2"','3"','4"','6"','12.7mm','19.1mm','25.4mm','31.8mm','38.1mm','50.8mm','63.5mm','76.2mm','101.6mm','152.4mm'] },
  { key: "rating",        options: ["NEMA 1","NEMA 3R","NEMA 4","NEMA 4X","NEMA 12","NEMA 7","IP65","IP67","UL Listed","CSA"] },
  { key: "wireType",      options: ["THHN","THWN","NM-B","MC","UF","SER","Armored","Plenum","URD","USE"] },
  { key: "wireGauge",     options: ["#14","#12","#10","#8","#6","#4","#2","1/0","2/0","3/0","4/0","350","500"] },
  { key: "conduitType",   options: ["EMT","PVC","RMC","IMC","FMC","LFMC","ENT","HDPE","RTRC","GRC"] },
  { key: "conduitSize",   options: ['1/2"','3/4"','1"','1-1/4"','1-1/2"','2"','2-1/2"','3"','4"','12.7mm','19.1mm','25.4mm','31.8mm','38.1mm','50.8mm','63.5mm','76.2mm','101.6mm'] },
  { key: "boxType",       options: ["New Work","Old Work","Junction","Weatherproof","Fan Box","Handy","Pull Box","Extension"] },
  { key: "boxGangCount",  options: ["1-Gang","2-Gang","3-Gang","4-Gang","Multi-Gang"] },
  { key: "mountingType",  options: ["Surface","Flush","DIN Rail","Panel Mount","Pole Mount","Pendant","Track"] },
  { key: "environment",   options: ["Indoor","Outdoor","Wet","Damp","Plenum","Direct Burial","Hazardous"] },
  { key: "voltage",       options: ["120V","240V","208V","277V","480V","24V","12V","600V"] },
  { key: "poleCount",     options: ["1 Pole","2 Pole","3 Pole","4 Pole"] },
] as const;

router.post("/search", async (req, res) => {
  try {
    const {
      keywords = "",
      catalog: catalogInput = "",
      vendor: vendorInput = "",
      color = "",
      size = "",
      material = "",
      textNumbers = "",
      confidenceThreshold = 50,  // 0–100 percentage; divided by 100 for internal comparison
      // 16 structured chip dimensions (AND-logic applied post-FTS)
      category = "",
      amperage = "",
      colorChip = "",
      manufacturer = "",
      sizeChip = "",
      rating = "",
      wireType = "",
      wireGauge = "",
      conduitType = "",
      conduitSize = "",
      boxType = "",
      boxGangCount = "",
      mountingType = "",
      environment = "",
      voltage = "",
      poleCount = "",
    } = req.body as {
      keywords?: string;
      catalog?: string;
      vendor?: string;
      color?: string;
      size?: string;
      material?: string;
      textNumbers?: string;
      confidenceThreshold?: number;
      category?: string; amperage?: string; colorChip?: string; manufacturer?: string;
      sizeChip?: string; rating?: string; wireType?: string; wireGauge?: string;
      conduitType?: string; conduitSize?: string; boxType?: string; boxGangCount?: string;
      mountingType?: string; environment?: string; voltage?: string; poleCount?: string;
    };

    const activeChipFilters: Array<{ key: string; value: string }> = [
      { key: "category",     value: category },
      { key: "amperage",     value: amperage },
      { key: "colorChip",    value: colorChip },
      { key: "manufacturer", value: manufacturer },
      { key: "sizeChip",     value: sizeChip },
      { key: "rating",       value: rating },
      { key: "wireType",     value: wireType },
      { key: "wireGauge",    value: wireGauge },
      { key: "conduitType",  value: conduitType },
      { key: "conduitSize",  value: conduitSize },
      { key: "boxType",      value: boxType },
      { key: "boxGangCount", value: boxGangCount },
      { key: "mountingType", value: mountingType },
      { key: "environment",  value: environment },
      { key: "voltage",      value: voltage },
      { key: "poleCount",    value: poleCount },
    ].filter(f => f.value.trim() !== "");

    // Load dictionaries in parallel
    const [misspellings, abbreviations, vendors, synonyms, slang] = await Promise.all([
      db.select().from(misspellingMapTable),
      db.select().from(abbreviationMapTable),
      db.select().from(vendorMapTable),
      db.select().from(synonymMapTable),
      db.select().from(electricalSlangMapTable),
    ]);

    const correctionMap = new Map(misspellings.map(m => [m.misspelling, m.correction]));
    const abbrevMap = new Map(abbreviations.map(a => [a.abbreviation, a.expansions]));
    const vendorMapData = new Map(vendors.map(v => [v.code, v.names]));
    const vendorFullNameMap = buildVendorFullNameMap(vendors);
    const synonymMapLookup = new Map(synonyms.map(s => [s.term, s.synonyms]));
    const slangMap = new Map(slang.map(s => [s.slangTerm, s.standardTerms]));

    const reverseVendorMap = new Map<string, string>();
    for (const v of vendors) {
      for (const name of v.names) reverseVendorMap.set(name.toLowerCase(), v.code);
    }

    const allSearchText = [keywords, catalogInput, vendorInput, color, size, material, textNumbers]
      .filter(Boolean).join(" ");

    if (!allSearchText.trim()) {
      return void res.json({ results: [], totalMatches: 0, belowThreshold: 0 });
    }

    // Normalize, correct misspellings, expand terms
    const normalized = normalizeMeasurement(allSearchText);
    const words = normalized.split(/\s+/).filter(w => w.length > 1);
    const corrected = words.map(w => correctMisspelling(w, correctionMap));

    const expandedTerms = new Set<string>(corrected);
    for (const word of corrected) {
      const wl = word.toLowerCase();
      abbrevMap.get(wl)?.forEach(e => expandedTerms.add(e));
      synonymMapLookup.get(wl)?.forEach(e => expandedTerms.add(e));
      slangMap.get(wl)?.forEach(e => expandedTerms.add(e));
      const vendorCode = reverseVendorMap.get(wl);
      if (vendorCode) expandedTerms.add(vendorCode);
      vendorMapData.get(word.toUpperCase())?.forEach(n => expandedTerms.add(n));
    }

    const catalogTerms = catalogInput ? parseCatalogNumber(catalogInput) : [];
    const keywordCatalogTerms = keywords ? parseCatalogNumber(keywords) : [];
    catalogTerms.forEach(t => expandedTerms.add(t));
    keywordCatalogTerms.forEach(t => expandedTerms.add(t));

    // Inject cross-unit measurement conversions (mm ↔ inch, cm → inch, m ↔ ft)
    // so that e.g. "10mm conduit" surfaces parts described as "3/8 inch conduit"
    for (const mt of expandMeasurements(normalized)) expandedTerms.add(mt);

    const vendorFilter = vendorInput.trim().toUpperCase();
    const allTermsArr = Array.from(expandedTerms).filter(t => t.length >= 2);
    // Build the FTS tsquery: strip non-word/non-space chars, split on whitespace so
    // multi-word terms become separate OR tokens, then filter out tokens that would
    // cause to_tsquery to fail:
    //   • pure numeric strings (e.g. "12", "394") — useless for full-text search
    //   • tokens starting with a digit (e.g. "7mm" from "12.7mm" after dot-strip)
    //   • common English stopwords that to_tsquery rejects when they appear alone
    const FTS_STOPWORDS = new Set(["in", "at", "on", "of", "to", "by", "as", "an", "or", "it"]);
    const tsQuery = allTermsArr
      .flatMap(t => t.replace(/[^\w\s]/g, " ").trim().split(/\s+/).filter(Boolean))
      .filter(t =>
        t.length >= 2 &&
        /^[a-zA-Z]/.test(t) &&
        !FTS_STOPWORDS.has(t.toLowerCase()),
      )
      .join(" | ");

    // ─── PG FTS + trigram ranked search (server-side) ───────────────────────
    type RawRow = {
      id: number; vendor: string; catalog: string; description: string;
      bin_locations: string[]; ai_keywords: string[]; trade_size: string | null;
      enriched_at: Date | null; created_at: Date; updated_at: Date;
      fts_rank: number; trgm_sim: number;
    };

    const rawKeywords = keywords.trim();
    const kwLike = rawKeywords ? `%${rawKeywords}%` : null;

    let pgResults: RawRow[] = [];
    try {
      if (tsQuery.trim() || kwLike) {
        // Pass raw keyword string alongside expanded terms for catalog trigram scoring
        const catalogTrgmTerms = [
          rawKeywords,
          ...allTermsArr.slice(0, 3),
        ].filter(Boolean).join(" ").trim() || allTermsArr.slice(0, 3).join(" ");

        // Wrap in a subquery so ORDER BY can reference the computed column aliases.
        // PostgreSQL only resolves aliases in ORDER BY when used as direct references
        // (not inside arithmetic expressions like fts_rank * 0.6 + trgm_sim * 0.4).
        const pgQueryResult = await db.execute(sql`
          SELECT * FROM (
            SELECT
              i.id, i.vendor, i.catalog, i.description,
              i.bin_locations, i.ai_keywords, i.trade_size, i.enriched_at, i.created_at, i.updated_at,
              ${tsQuery.trim() ? sql`ts_rank_cd(
                to_tsvector('english',
                  coalesce(i.vendor,'') || ' ' || coalesce(i.catalog,'') || ' ' ||
                  coalesce(i.description,'') || ' ' ||
                  coalesce(array_to_string(i.ai_keywords, ' '), '')
                ),
                to_tsquery('english', ${tsQuery})
              )` : sql`0`} AS fts_rank,
              greatest(
                similarity(i.catalog, ${catalogTrgmTerms}),
                similarity(i.description, ${allTermsArr.slice(0,5).join(" ")})
              ) AS trgm_sim
            FROM inventory i
            WHERE
              ${tsQuery.trim() ? sql`to_tsvector('english',
                coalesce(i.vendor,'') || ' ' || coalesce(i.catalog,'') || ' ' ||
                coalesce(i.description,'') || ' ' ||
                coalesce(array_to_string(i.ai_keywords, ' '), '')
              ) @@ to_tsquery('english', ${tsQuery})
              OR` : sql``}
              similarity(i.catalog, ${catalogTrgmTerms}) > 0.1
              OR similarity(i.description, ${allTermsArr.slice(0,5).join(" ")}) > 0.1
              ${kwLike ? sql`OR i.catalog ILIKE ${kwLike}` : sql``}
              ${vendorFilter ? sql`OR upper(i.vendor) = ${vendorFilter}` : sql``}
          ) AS __ranked
          ORDER BY (fts_rank * 0.6 + trgm_sim * 0.4) DESC
          LIMIT 200
        `);
        // Drizzle returns { rows: unknown[] } for raw SQL — validate shape at runtime
        const rawRows = (pgQueryResult as { rows: unknown[] }).rows;
        pgResults = rawRows.filter((r): r is RawRow => {
          if (!r || typeof r !== "object") {
            console.warn("[inventory/search] Unexpected non-object row from raw SQL:", r);
            return false;
          }
          const row = r as Record<string, unknown>;
          const valid = (
            typeof row.id === "number" &&
            typeof row.vendor === "string" &&
            typeof row.catalog === "string" &&
            typeof row.description === "string" &&
            typeof row.fts_rank === "number" &&
            typeof row.trgm_sim === "number"
          );
          if (!valid) {
            console.warn("[inventory/search] Row has unexpected shape (possible schema drift):", JSON.stringify(row));
          }
          return valid;
        });
      }
    } catch (pgErr) {
      console.warn("PG search error, falling back to Fuse:", pgErr);
    }

    // Map PG results into scored items
    type ScoredItem = {
      item: typeof inventoryTable.$inferSelect;
      confidence: number;
      reason: string;
    };

    const scoreMap = new Map<number, ScoredItem>();
    const updateScore = (item: typeof inventoryTable.$inferSelect, confidence: number, reason: string) => {
      const current = scoreMap.get(item.id);
      if (shouldUpdateScore(current?.confidence, confidence)) {
        scoreMap.set(item.id, { item, confidence, reason });
      }
    };

    // Process PG results
    for (const row of pgResults) {
      const ftsRank = Number(row.fts_rank) || 0;
      const trgmSim = Number(row.trgm_sim) || 0;
      const pgScore = blendPgScore(ftsRank, trgmSim);
      const item: typeof inventoryTable.$inferSelect = {
        id: row.id,
        vendor: row.vendor,
        catalog: row.catalog,
        description: row.description,
        // Safe fallbacks for fields not included in the runtime shape-validation filter
        binLocations: Array.isArray(row.bin_locations) ? row.bin_locations as string[] : [],
        aiKeywords: Array.isArray(row.ai_keywords) ? row.ai_keywords as string[] : [],
        tradeSize: typeof row.trade_size === "string" ? row.trade_size : null,
        enrichedAt: row.enriched_at instanceof Date ? row.enriched_at : null,
        createdAt: row.created_at instanceof Date ? row.created_at : new Date(0),
        updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(0),
      };

      const { score, reason } = catalogScore(pgScore, row.catalog, catalogInput, rawKeywords, ftsRank);
      updateScore(item, score, reason);
    }

    // Exact catalog fallback if PG didn't catch it (checks both Catalog # field and raw keywords)
    if (pgResults.length === 0) {
      const lookups = [catalogInput, rawKeywords].filter(Boolean).map(v => v.toUpperCase());
      if (lookups.length > 0) {
        for (const lookupVal of lookups) {
          const exactRows = await db.select().from(inventoryTable)
            .where(sql`upper(${inventoryTable.catalog}) = ${lookupVal}`);
          for (const item of exactRows) updateScore(item, 1.0, "exact catalog fallback");
          // Also try ILIKE prefix fallback
          const prefixRows = await db.select().from(inventoryTable)
            .where(sql`upper(${inventoryTable.catalog}) LIKE ${lookupVal + "%"}`)
            .limit(20);
          for (const item of prefixRows) updateScore(item, 0.93, "catalog prefix fallback");
        }
      }
    }

    // Fuse.js fallback for small datasets or when PG returns nothing.
    // Uses the long-lived shared index built+refreshed by
    // `lib/inventoryIndex`. The whole point of the shared index is to
    // avoid the SELECT * + Fuse rebuild on every request, so if the
    // index isn't ready yet (brief startup window) we just skip fuzzy
    // and return PG-only results rather than reintroducing that cost.
    const fuse = getInventoryFuseIndex();
    if (scoreMap.size < 5 && fuse) {
      const fuseQuery = corrected.join(" ");
      if (fuseQuery.trim()) {
        for (const r of fuse.search(fuseQuery)) {
          const conf = fuseConfidence(r.score, 0.70);
          if (conf > 0.2) updateScore(r.item, conf, "fuzzy fallback");
        }
      }
      for (const term of allTermsArr.slice(0, 8)) {
        if (term.length < 3) continue;
        for (const r of fuse.search(term).slice(0, 15)) {
          const conf = fuseConfidence(r.score, 0.60);
          if (conf > 0.2) updateScore(r.item, conf, "fuzzy expanded fallback");
        }
      }
    }

    // Apply vendor boost/penalty
    const results: ScoredItem[] = [];
    for (const entry of scoreMap.values()) {
      const conf = applyVendorBoost(entry.confidence, vendorFilter, entry.item.vendor);
      results.push({ ...entry, confidence: conf });
    }

    results.sort((a, b) => b.confidence - a.confidence);

    // ── Compute per-dimension counts (AND logic, using other active chip filters) ─
    const dimensionCounts: Record<string, Record<string, number>> = {};
    for (const dim of CHIP_DIMS_SERVER) {
      dimensionCounts[dim.key] = {};
      const otherFilters = activeChipFilters.filter(f => f.key !== dim.key);
      const baseResults = otherFilters.length > 0
        ? results.filter(r => matchesChipFilters(r.item, otherFilters))
        : results;
      for (const opt of dim.options) {
        dimensionCounts[dim.key][opt] = baseResults.filter(r =>
          tokenMatch(itemFullText(r.item), opt)
        ).length;
      }
    }

    // ── Apply structured chip AND-filters to narrow results ─────────────────
    const chipFiltered = activeChipFilters.length > 0
      ? results.filter(r => matchesChipFilters(r.item, activeChipFilters))
      : results;

    // Group into series + find variants
    const seriesGroups = new Map<string, { label: string; items: typeof inventoryTable.$inferSelect[] }>();
    for (const r of chipFiltered) {
      const series = getSeriesBase(r.item.vendor, r.item.catalog, r.item.description);
      if (series) {
        const existing = seriesGroups.get(series.key) ?? { label: series.label, items: [] };
        existing.items.push(r.item);
        seriesGroups.set(series.key, existing);
      }
    }

    const variantMap = new Map<number, typeof inventoryTable.$inferSelect[]>();
    const resultIds = new Set(chipFiltered.map(r => r.item.id));

    if (seriesGroups.size > 0) {
      const allInventory = await db.select().from(inventoryTable);
      for (const item of allInventory) {
        if (resultIds.has(item.id)) continue;
        const series = getSeriesBase(item.vendor, item.catalog, item.description);
        if (!series) continue;
        const group = seriesGroups.get(series.key);
        if (group) {
          const primaryItem = group.items[0];
          if (primaryItem) {
            const variants = variantMap.get(primaryItem.id) ?? [];
            variants.push(item);
            variantMap.set(primaryItem.id, variants);
          }
        }
      }
    }

    // confidenceThreshold is 0–100 from client; confidence scores are 0–1 internally
    const thresholdFraction = Math.max(0, Math.min(100, confidenceThreshold)) / 100;
    const aboveThreshold = chipFiltered.filter(r => r.confidence >= thresholdFraction);
    const belowCount = chipFiltered.length - aboveThreshold.length;

    aboveThreshold.sort((a, b) => {
      const diff = b.confidence - a.confidence;
      if (Math.abs(diff) > 0.05) return diff;
      return extractSizeValue(a.item) - extractSizeValue(b.item);
    });

    const finalResults = aboveThreshold.map(r => ({
      item: withVendorFullName(r.item, vendorFullNameMap),
      confidence: r.confidence,
      matchReason: r.reason,
      seriesBase: getSeriesBase(r.item.vendor, r.item.catalog, r.item.description)?.key ?? null,
      seriesLabel: getSeriesBase(r.item.vendor, r.item.catalog, r.item.description)?.label ?? null,
      variants: (variantMap.get(r.item.id) ?? []).map(v => withVendorFullName(v, vendorFullNameMap)),
    }));

    res.json({
      results: finalResults,
      totalMatches: chipFiltered.length,
      belowThreshold: belowCount,
      dimensionCounts,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Search failed" });
  }
});

// ── Admin token middleware ─────────────────────────────────────────────────────
function requireAdminAuth(
  req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction,
): void {
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    res.status(503).json({
      error: "Admin access is not configured on this server. Set ADMIN_PASSWORD.",
    });
    return;
  }

  const authHeader = req.headers["authorization"] ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!token || !verifyAdminToken(token, adminPassword)) {
    res.status(401).json({ error: "Unauthorized: valid admin token required" });
    return;
  }

  next();
}

// ── Upsert helpers ────────────────────────────────────────────────────────────
//
// Match key is (UPPER(vendor), UPPER(catalog)). On every existing-row update
// the catalog and vendor TEXT is left exactly as stored — only `binLocations`
// and `description` may change. A blank/missing description NEVER overwrites
// a stored description. Bin merge is ADDITIVE.

interface UpsertItemInput {
  vendor: string;
  catalog: string;
  description?: string;
  binLocations?: string[];
}

interface ExistingRow {
  id: number;
  vendor: string;
  catalog: string;
  description: string;
  binLocations: string[];
}

/** Case-insensitive `(vendor, catalog)` key. */
function keyOf(vendor: string, catalog: string): string {
  return `${vendor.trim().toUpperCase()}|${catalog.trim().toUpperCase()}`;
}

/** Consolidate incoming items by case-insensitive (vendor, catalog) key.
 *  Within a single request, duplicate logical keys (including catalog-case
 *  variants the client may not have caught) are collapsed into one item:
 *    - vendor / catalog text from the FIRST occurrence wins
 *    - bins are merged additively (case-insensitive de-dupe)
 *    - description is the LAST non-empty value (so a later row with text can
 *      "fill in" an earlier blank, but a blank never wipes a present value)
 *  This guarantees `/preview-upsert` and `/upsert-batch` operate on a clean,
 *  one-row-per-key list and is the only place duplicates are resolved server-side. */
function dedupeItems(items: readonly UpsertItemInput[]): UpsertItemInput[] {
  const byKey = new Map<string, UpsertItemInput>();
  for (const raw of items) {
    const key = keyOf(raw.vendor, raw.catalog);
    const incomingDesc = typeof raw.description === "string" ? raw.description.trim() : "";
    const incomingBins = Array.isArray(raw.binLocations) ? raw.binLocations : [];
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, {
        vendor: raw.vendor,
        catalog: raw.catalog,
        description: incomingDesc,
        binLocations: dedupeBinsCaseInsensitive(incomingBins),
      });
      continue;
    }
    const prevDesc = typeof prev.description === "string" ? prev.description : "";
    byKey.set(key, {
      vendor: prev.vendor,
      catalog: prev.catalog,
      description: incomingDesc.length > 0 ? incomingDesc : prevDesc,
      binLocations: mergeBins(prev.binLocations ?? [], incomingBins),
    });
  }
  return Array.from(byKey.values());
}

/** Bin lists are equal as case-insensitive sets (after de-duping). */
function binsEqual(a: readonly string[], b: readonly string[]): boolean {
  const aSet = new Set(dedupeBinsCaseInsensitive(a).map((s) => s.toUpperCase()));
  const bSet = new Set(dedupeBinsCaseInsensitive(b).map((s) => s.toUpperCase()));
  if (aSet.size !== bSet.size) return false;
  for (const v of aSet) if (!bSet.has(v)) return false;
  return true;
}

/** Look up every existing row that matches the (vendor, catalog) of any item.
 *  Returns a Map keyed by the case-insensitive composite key. Performs one
 *  per-item SELECT — fine for typical re-upload sizes (≤ a few hundred). */
async function fetchExistingMatches(
  items: readonly UpsertItemInput[],
): Promise<Map<string, ExistingRow>> {
  const result = new Map<string, ExistingRow>();
  // De-dupe so we don't query the same key twice.
  const seenKeys = new Set<string>();
  for (const item of items) {
    const key = keyOf(item.vendor, item.catalog);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const rows = await db
      .select()
      .from(inventoryTable)
      .where(
        and(
          sql`UPPER(${inventoryTable.vendor}) = UPPER(${item.vendor})`,
          sql`UPPER(${inventoryTable.catalog}) = UPPER(${item.catalog})`,
        ),
      )
      .limit(1);
    const row = rows[0];
    if (row) {
      result.set(key, {
        id: row.id,
        vendor: row.vendor,
        catalog: row.catalog,
        description: row.description ?? "",
        binLocations: row.binLocations ?? [],
      });
    }
  }
  return result;
}

// ── POST /inventory/upsert-batch ──────────────────────────────────────────────
router.post("/upsert-batch", requireAdminAuth, async (req, res) => {
  try {
    const { items, mode: rawMode, selectedKeys: rawSelectedKeys } = req.body as {
      items?: UpsertItemInput[];
      mode?: string;
      selectedKeys?: Array<{ vendor: string; catalog: string }>;
    };

    if (!items?.length) {
      return void res.status(400).json({ error: "No items provided" });
    }

    const mode: "add-new-only" | "overwrite-all" | "selected" | "bins-only" | "add-multi-access" =
      rawMode === "add-new-only" || rawMode === "selected" || rawMode === "overwrite-all" || rawMode === "bins-only" || rawMode === "add-multi-access"
        ? rawMode
        : "overwrite-all";

    if (mode === "selected" && !Array.isArray(rawSelectedKeys)) {
      return void res
        .status(400)
        .json({ error: "selectedKeys is required when mode = 'selected'" });
    }

    const selectedSet = new Set<string>(
      (rawSelectedKeys ?? []).map((k) => keyOf(k.vendor, k.catalog)),
    );

    // Collapse duplicate logical keys before any DB work — see dedupeItems().
    const dedupedItems = dedupeItems(items);
    const existingByKey = await fetchExistingMatches(dedupedItems);

    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    for (const item of dedupedItems) {
      const incomingBins = Array.isArray(item.binLocations) ? item.binLocations : [];
      const incomingDescRaw = typeof item.description === "string" ? item.description.trim() : "";
      const key = keyOf(item.vendor, item.catalog);
      const existing = existingByKey.get(key);

      if (existing) {
        // ── Existing match: respect mode ──
        if (mode === "add-new-only") {
          skipped++;
          continue;
        }
        if (mode === "selected" && !selectedSet.has(key)) {
          skipped++;
          continue;
        }

        const mergedBins = mergeBins(existing.binLocations, incomingBins);

        if (mode === "bins-only" || mode === "add-multi-access") {
          // Only update bin locations — never touch description.
          await db
            .update(inventoryTable)
            .set({ binLocations: mergedBins, updatedAt: new Date() })
            .where(eq(inventoryTable.id, existing.id));
        } else {
          // Blank/missing description NEVER wipes the stored description.
          const nextDescription = incomingDescRaw.length > 0 ? incomingDescRaw : existing.description;
          await db
            .update(inventoryTable)
            .set({ description: nextDescription, binLocations: mergedBins, updatedAt: new Date() })
            // NB: vendor/catalog text on existing rows is intentionally NOT updated.
            .where(eq(inventoryTable.id, existing.id));
        }
        updated++;
      } else {
        // ── New row: bins-only skips; add-multi-access and all other modes insert ──
        if (mode === "bins-only") {
          skipped++;
          continue;
        }
        await db.insert(inventoryTable).values({
          vendor: item.vendor.trim().toUpperCase(),
          catalog: item.catalog.trim(),
          description: incomingDescRaw,
          binLocations: mergeBins([], incomingBins),
          aiKeywords: [],
        });
        inserted++;
      }
    }

    res.json({ inserted, updated, skipped, total: dedupedItems.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Upsert failed" });
  }
});

// ── POST /inventory/preview-upsert ────────────────────────────────────────────
//
// Read-only classifier: returns which incoming rows would create new items,
// which match existing items, and for each match the current vs. proposed
// `binLocations` and `description`. No DB writes.
router.post("/preview-upsert", requireAdminAuth, async (req, res) => {
  try {
    const { items, mode: rawMode } = req.body as { items?: UpsertItemInput[]; mode?: string };
    if (!items?.length) {
      return void res.status(400).json({ error: "No items provided" });
    }

    const binsOnly = rawMode === "bins-only";

    // Collapse duplicate logical keys before classification.
    const dedupedItems = dedupeItems(items);
    const existingByKey = await fetchExistingMatches(dedupedItems);

    let newCount = 0;
    let changedCount = 0;
    let unchangedCount = 0;
    // bins-only counters
    let binsOnlyUpdated = 0;
    let binsOnlySkipped = 0;
    const matchedKeys: Array<{ vendor: string; catalog: string }> = [];
    const changes: Array<{
      vendor: string;
      catalog: string;
      existingDescription: string;
      proposedDescription: string;
      existingBinLocations: string[];
      proposedBinLocations: string[];
      binChanged: boolean;
      descChanged: boolean;
    }> = [];

    for (const item of dedupedItems) {
      const key = keyOf(item.vendor, item.catalog);
      const existing = existingByKey.get(key);
      const incomingBins = Array.isArray(item.binLocations) ? item.binLocations : [];
      const incomingDescRaw = typeof item.description === "string" ? item.description.trim() : "";

      if (!existing) {
        newCount++;
        if (binsOnly) binsOnlySkipped++;
        continue;
      }

      if (binsOnly) {
        binsOnlyUpdated++;
        // Preserve DB-cased vendor/catalog for the client filter key.
        matchedKeys.push({ vendor: existing.vendor, catalog: existing.catalog });
        continue;
      }

      const proposedBins = mergeBins(existing.binLocations, incomingBins);
      const proposedDescription =
        incomingDescRaw.length > 0 ? incomingDescRaw : existing.description;

      const binChanged = !binsEqual(existing.binLocations, proposedBins);
      const descChanged =
        incomingDescRaw.length > 0 && incomingDescRaw !== existing.description;

      if (binChanged || descChanged) {
        changedCount++;
        changes.push({
          // Preserve DB casing — we never mutate vendor/catalog text on existing rows.
          vendor: existing.vendor,
          catalog: existing.catalog,
          existingDescription: existing.description,
          proposedDescription,
          existingBinLocations: existing.binLocations,
          proposedBinLocations: proposedBins,
          binChanged,
          descChanged,
        });
      } else {
        unchangedCount++;
      }
    }

    res.json({
      newCount,
      changedCount,
      unchangedCount,
      // Distinct (vendor, catalog) rows after de-duplication, per OpenAPI.
      totalIncoming: dedupedItems.length,
      changes,
      // bins-only mode extras (undefined when not in bins-only mode)
      ...(binsOnly ? { binsOnlyUpdated, binsOnlySkipped, matchedKeys } : {}),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Preview failed" });
  }
});

// ── POST /inventory/enrich ────────────────────────────────────────────────────
router.post("/enrich", requireAdminAuth, async (req, res) => {
  try {
    const { ids } = req.body as { ids?: number[] };

    // Enrichment runs in batches of 50 items max per request to allow
    // progress + ETA reporting without long-running unbounded requests.
    const BATCH_SIZE = 50;
    let itemsToEnrich;
    if (ids?.length) {
      itemsToEnrich = await db
        .select()
        .from(inventoryTable)
        .where(sql`${inventoryTable.id} = ANY(${ids.slice(0, BATCH_SIZE)})`);
    } else {
      itemsToEnrich = await db
        .select()
        .from(inventoryTable)
        .where(sql`${inventoryTable.enrichedAt} IS NULL`)
        .limit(BATCH_SIZE);
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    if (!itemsToEnrich.length) {
      res.write(`data: ${JSON.stringify({ done: true, processed: 0, total: 0 })}\n\n`);
      res.end();
      return;
    }

    let processed = 0;
    const total = itemsToEnrich.length;
    const startTime = Date.now();

    await batchProcessWithSSE(
      itemsToEnrich,
      async (item) => {
        // Derive trade size before AI call so it can be passed as context.
        const tradeSizeInches =
          parseTradeSizeInches(item.catalog) ??
          parseTradeSizeInches(item.description);
        const tradeSize = tradeSizeInches !== null
          ? tradeSizeChipLabel(tradeSizeInches)
          : null;

        const keywords = await generateKeywords(item, undefined, tradeSize ?? undefined);

        // Append trade-size keyword tokens (matching bulk-enrich behaviour).
        const tradeTokens = deriveTradeSizeTokens(item);
        const existing = new Set(keywords.map(k => k.toLowerCase()));
        const merged = [
          ...keywords,
          ...tradeTokens.filter(t => !existing.has(t.toLowerCase())),
        ];

        await db
          .update(inventoryTable)
          .set({
            aiKeywords: merged,
            enrichedAt: new Date(),
            updatedAt: new Date(),
            ...(tradeSize !== null ? { tradeSize } : {}),
          })
          .where(eq(inventoryTable.id, item.id));

        processed++;
        return { id: item.id, keywords: merged };
      },
      (event) => {
        if (event.type === "started") {
          res.write(`data: ${JSON.stringify({ progress: 0, total: event.total, batchSize: BATCH_SIZE })}\n\n`);
        } else if (event.type === "progress") {
          // Compute ETA based on elapsed time and items remaining
          const elapsed = Date.now() - startTime;
          const avgMs = processed > 0 ? elapsed / processed : 0;
          const remaining = total - processed;
          const etaSeconds = avgMs > 0 ? Math.round((avgMs * remaining) / 1000) : null;
          res.write(`data: ${JSON.stringify({
            progress: processed,
            total,
            batchSize: BATCH_SIZE,
            etaSeconds,
            item: event.result,
          })}\n\n`);
        }
      },
      { retries: 3 },
    );

    res.write(`data: ${JSON.stringify({ done: true, processed, total })}\n\n`);
    res.end();
  } catch (err) {
    console.error(err);
    res.write(`data: ${JSON.stringify({ error: String(err) })}\n\n`);
    res.end();
  }
});

// ── Bulk-enrich job state ─────────────────────────────────────────────────────
interface BulkEnrichJob {
  running: boolean;
  stopRequested: boolean;
  startedAt: Date | null;
  processed: number;
  errors: number;
  total: number | null;
  finishedAt: Date | null;
  lastError: string | null;
}

const bulkEnrichJob: BulkEnrichJob = {
  running: false,
  stopRequested: false,
  startedAt: null,
  processed: 0,
  errors: 0,
  total: null,
  finishedAt: null,
  lastError: null,
};

const BULK_ENRICH_MODEL      = process.env["ENRICH_MODEL"] ?? "gpt-4o-mini";
const BULK_ENRICH_BATCH      = 10;
const BULK_ENRICH_CONCUR     = 5;
const BULK_ENRICH_DELAY_MS   = 200;
const BULK_ENRICH_MAX_RETRY  = 3;


async function enrichItemWithRetry(item: {
  id: number;
  vendor: string;
  catalog: string;
  description: string | null;
}): Promise<string[]> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= BULK_ENRICH_MAX_RETRY; attempt++) {
    try {
      return await generateKeywords(item, BULK_ENRICH_MODEL);
    } catch (err) {
      lastErr = err;
      if (attempt < BULK_ENRICH_MAX_RETRY) {
        const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 8000);
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }
  throw lastErr;
}

async function runBulkEnrich() {
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(inventoryTable)
    .where(sql`${inventoryTable.enrichedAt} IS NULL`);

  bulkEnrichJob.total = total;
  console.log(`[bulk-enrich] Starting – ${total} unenriched items (model: ${BULK_ENRICH_MODEL})`);

  while (true) {
    if (bulkEnrichJob.stopRequested) {
      console.log("[bulk-enrich] Stop requested – halting after current batch");
      break;
    }

    const batch = await db
      .select({
        id: inventoryTable.id,
        vendor: inventoryTable.vendor,
        catalog: inventoryTable.catalog,
        description: inventoryTable.description,
      })
      .from(inventoryTable)
      .where(sql`${inventoryTable.enrichedAt} IS NULL`)
      .limit(BULK_ENRICH_BATCH);

    if (batch.length === 0) break;

    for (let i = 0; i < batch.length; i += BULK_ENRICH_CONCUR) {
      const wave = batch.slice(i, i + BULK_ENRICH_CONCUR);
      const results = await Promise.allSettled(wave.map((item) => enrichItemWithRetry(item)));

      for (let j = 0; j < results.length; j++) {
        const r = results[j]!;
        const item = wave[j]!;
        if (r.status === "fulfilled") {
          await db
            .update(inventoryTable)
            .set({ aiKeywords: r.value, enrichedAt: new Date(), updatedAt: new Date() })
            .where(eq(inventoryTable.id, item.id));
          bulkEnrichJob.processed++;
        } else {
          // Leave enrichedAt NULL so the item remains retryable on next run
          bulkEnrichJob.errors++;
          bulkEnrichJob.lastError = String(r.reason);
          console.error(`[bulk-enrich] Error id=${item.id} (${item.vendor}/${item.catalog}):`, r.reason);
        }
      }
    }

    await new Promise((r) => setTimeout(r, BULK_ENRICH_DELAY_MS));
  }

  bulkEnrichJob.running = false;
  bulkEnrichJob.finishedAt = new Date();
  console.log(
    `[bulk-enrich] Done – processed=${bulkEnrichJob.processed} errors=${bulkEnrichJob.errors}`,
  );
}

// ── GET /inventory/enrich-summary ─────────────────────────────────────────────
router.get("/enrich-summary", requireAdminAuth, async (_req, res) => {
  try {
    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(inventoryTable);
    const [{ enriched }] = await db
      .select({ enriched: sql<number>`count(*)::int` })
      .from(inventoryTable)
      .where(sql`${inventoryTable.enrichedAt} IS NOT NULL`);
    res.json({ total, enriched, unenriched: total - enriched });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch enrichment summary" });
  }
});

// ── POST /inventory/bulk-enrich ───────────────────────────────────────────────
router.post("/bulk-enrich", requireAdminAuth, (_req, res) => {
  if (bulkEnrichJob.running) {
    return void res.status(409).json({ error: "Bulk enrichment already running", job: bulkEnrichJob });
  }

  bulkEnrichJob.running = true;
  bulkEnrichJob.stopRequested = false;
  bulkEnrichJob.startedAt = new Date();
  bulkEnrichJob.processed = 0;
  bulkEnrichJob.errors = 0;
  bulkEnrichJob.total = null;
  bulkEnrichJob.finishedAt = null;
  bulkEnrichJob.lastError = null;

  runBulkEnrich().catch((err) => {
    bulkEnrichJob.running = false;
    bulkEnrichJob.finishedAt = new Date();
    bulkEnrichJob.lastError = String(err);
    console.error("[bulk-enrich] Fatal error:", err);
  });

  res.status(202).json({ message: "Bulk enrichment started", job: bulkEnrichJob });
});

// ── GET /inventory/bulk-enrich/status ─────────────────────────────────────────
router.get("/bulk-enrich/status", requireAdminAuth, (_req, res) => {
  res.json(bulkEnrichJob);
});

// ── DELETE /inventory/bulk-enrich ─────────────────────────────────────────────
router.delete("/bulk-enrich", requireAdminAuth, (_req, res) => {
  if (!bulkEnrichJob.running) {
    return void res.status(409).json({ error: "No bulk enrichment job is currently running" });
  }
  bulkEnrichJob.stopRequested = true;
  res.json({ message: "Stop requested – job will halt after the current batch completes", job: bulkEnrichJob });
});

// ── Measurement-enrich job state ──────────────────────────────────────────────
interface MeasureEnrichJob {
  running: boolean;
  startedAt: Date | null;
  processed: number;
  updated: number;
  total: number | null;
  finishedAt: Date | null;
  lastError: string | null;
}

const measureEnrichJob: MeasureEnrichJob = {
  running: false,
  startedAt: null,
  processed: 0,
  updated: 0,
  total: null,
  finishedAt: null,
  lastError: null,
};

const MEASURE_ENRICH_BATCH = 200;
const MEASURE_ENRICH_DELAY_MS = 50;

/**
 * Idempotent batch job: iterate every inventory item, run expandMeasurements
 * against catalog + description, and APPEND any new converted terms to the
 * item's aiKeywords array.  Items that already contain all the generated terms
 * are skipped so the job can be re-run safely without overwriting data.
 */
async function runMeasureEnrich(): Promise<void> {
  const [countRow] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(inventoryTable);

  measureEnrichJob.total = countRow?.total ?? 0;
  console.log(`[measure-enrich] Starting – ${measureEnrichJob.total} items`);

  let lastId = 0;

  while (true) {
    const batch = await db
      .select({
        id:          inventoryTable.id,
        catalog:     inventoryTable.catalog,
        description: inventoryTable.description,
        aiKeywords:  inventoryTable.aiKeywords,
      })
      .from(inventoryTable)
      .where(sql`${inventoryTable.id} > ${lastId}`)
      .orderBy(inventoryTable.id)
      .limit(MEASURE_ENRICH_BATCH);

    if (batch.length === 0) break;

    for (const item of batch) {
      const text = `${item.catalog} ${item.description}`;
      const generated = expandMeasurements(text);

      if (generated.length > 0) {
        const existing = new Set(item.aiKeywords ?? []);
        const toAdd = generated.filter(t => !existing.has(t));

        if (toAdd.length > 0) {
          const merged = [...(item.aiKeywords ?? []), ...toAdd];
          try {
            await db
              .update(inventoryTable)
              .set({ aiKeywords: merged, updatedAt: new Date() })
              .where(eq(inventoryTable.id, item.id));
            measureEnrichJob.updated++;
          } catch (err) {
            measureEnrichJob.lastError = String(err);
            console.error(`[measure-enrich] Error updating id=${item.id}:`, err);
          }
        }
      }

      measureEnrichJob.processed++;
    }

    lastId = batch[batch.length - 1]!.id;
    await new Promise(r => setTimeout(r, MEASURE_ENRICH_DELAY_MS));
  }

  measureEnrichJob.running = false;
  measureEnrichJob.finishedAt = new Date();
  console.log(
    `[measure-enrich] Done – processed=${measureEnrichJob.processed} updated=${measureEnrichJob.updated}`,
  );
}

// ── POST /inventory/enrich-measurements ───────────────────────────────────────
router.post("/enrich-measurements", requireAdminAuth, (_req, res) => {
  if (measureEnrichJob.running) {
    return void res.status(409).json({
      error: "Measurement enrichment already running",
      job: measureEnrichJob,
    });
  }

  measureEnrichJob.running    = true;
  measureEnrichJob.startedAt  = new Date();
  measureEnrichJob.processed  = 0;
  measureEnrichJob.updated    = 0;
  measureEnrichJob.total      = null;
  measureEnrichJob.finishedAt = null;
  measureEnrichJob.lastError  = null;

  runMeasureEnrich().catch(err => {
    measureEnrichJob.running    = false;
    measureEnrichJob.finishedAt = new Date();
    measureEnrichJob.lastError  = String(err);
    console.error("[measure-enrich] Fatal error:", err);
  });

  res.status(202).json({ message: "Measurement enrichment started", job: measureEnrichJob });
});

// ── GET /inventory/enrich-measurements/status ─────────────────────────────────
router.get("/enrich-measurements/status", requireAdminAuth, (_req, res) => {
  res.json(measureEnrichJob);
});

// ── GET /inventory/export ─────────────────────────────────────────────────────
// Returns the full inventory as a UTF-8 CSV with four columns:
//   vendor, catalog, description, binLocations
//
// binLocations are joined with "; " (semicolon + space). The server-side CSV
// parser splits on /[,;/\n\r]+/ so a re-imported file merges the bins back
// correctly. The column name "binLocations" is recognised by BIN_ALIASES in
// the mobile CSV parser.
//
// Requires admin auth so the full warehouse is not publicly downloadable.
router.get("/export", requireAdminAuth, async (_req, res) => {
  try {
    const items = await db
      .select()
      .from(inventoryTable)
      .orderBy(inventoryTable.vendor, inventoryTable.catalog);

    const csvEscape = (val: string): string => {
      if (/[",\n\r]/.test(val)) return `"${val.replace(/"/g, '""')}"`;
      return val;
    };

    const header = "vendor,catalog,description,binLocations";
    const dataRows = items.map((item) =>
      [
        csvEscape(item.vendor ?? ""),
        csvEscape(item.catalog ?? ""),
        csvEscape(item.description ?? ""),
        csvEscape((item.binLocations ?? []).join("; ")),
      ].join(","),
    );

    const csv = [header, ...dataRows].join("\r\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="inventory.csv"',
    );
    res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Export failed" });
  }
});

// ── PATCH /inventory/:id ──────────────────────────────────────────────────────
// Partial update for an inventory item. Only the fields present in the
// request body are touched.
//   • description: string         → set to that string (blank string is a real
//                                   edit — the worker explicitly cleared it)
//   • description: undefined/missing → leave description unchanged
//   • keywords:    string[]       → replace ai_keywords
//   • keywords:    undefined/missing → leave ai_keywords unchanged
// At least one of the two must be supplied.
router.patch("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params["id"] ?? "0");
    if (!Number.isFinite(id) || id <= 0) {
      return void res.status(400).json({ error: "id must be a positive integer" });
    }

    const body = (req.body ?? {}) as { description?: unknown; keywords?: unknown; tradeSize?: unknown; binLocations?: unknown };
    const hasDescription = Object.prototype.hasOwnProperty.call(body, "description");
    const hasKeywords = Object.prototype.hasOwnProperty.call(body, "keywords");
    const hasTradeSize = Object.prototype.hasOwnProperty.call(body, "tradeSize");
    const hasBinLocations = Object.prototype.hasOwnProperty.call(body, "binLocations");

    if (!hasDescription && !hasKeywords && !hasTradeSize && !hasBinLocations) {
      return void res.status(400).json({
        error: "Provide at least one of `description`, `keywords`, `tradeSize`, or `binLocations` to update.",
      });
    }

    const updates: Partial<typeof inventoryTable.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (hasDescription) {
      if (typeof body.description !== "string") {
        return void res.status(400).json({ error: "description must be a string" });
      }
      updates.description = body.description;
    }

    if (hasKeywords) {
      if (!Array.isArray(body.keywords) || !body.keywords.every(k => typeof k === "string")) {
        return void res.status(400).json({ error: "keywords must be an array of strings" });
      }
      updates.aiKeywords = body.keywords as string[];
    }

    if (hasTradeSize) {
      if (body.tradeSize !== null && typeof body.tradeSize !== "string") {
        return void res.status(400).json({ error: "tradeSize must be a string or null" });
      }
      updates.tradeSize = (body.tradeSize as string | null) ?? null;
    }

    if (hasBinLocations) {
      if (!Array.isArray(body.binLocations) || !body.binLocations.every(b => typeof b === "string")) {
        return void res.status(400).json({ error: "binLocations must be an array of strings" });
      }
      updates.binLocations = dedupeBinsCaseInsensitive(body.binLocations as string[]);
    }

    const [updated] = await db
      .update(inventoryTable)
      .set(updates)
      .where(eq(inventoryTable.id, id))
      .returning();

    if (!updated) return void res.status(404).json({ error: "Item not found" });

    const vendorFullName = await lookupVendorFullName(updated.vendor);
    res.json(withVendorFullName(updated, new Map(vendorFullName ? [[updated.vendor.toUpperCase(), vendorFullName]] : [])));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update inventory item" });
  }
});

// ── POST /inventory/:id/suggest-description ───────────────────────────────────
// Generate a single AI-recommended improved description that folds the
// part's AI keywords into natural prose while preserving any specifics
// already in the description. Nothing is saved here — the caller decides
// whether to apply the suggestion (and the existing PATCH endpoint is what
// actually persists it).
router.post("/:id/suggest-description", async (req, res) => {
  try {
    const id = parseInt(req.params["id"] ?? "0");
    if (!Number.isFinite(id) || id <= 0) {
      return void res.status(400).json({ error: "id must be a positive integer" });
    }

    const [item] = await db
      .select({
        vendor: inventoryTable.vendor,
        catalog: inventoryTable.catalog,
        description: inventoryTable.description,
        aiKeywords: inventoryTable.aiKeywords,
      })
      .from(inventoryTable)
      .where(eq(inventoryTable.id, id))
      .limit(1);

    if (!item) return void res.status(404).json({ error: "Item not found" });

    const description = await suggestDescription({
      vendor: item.vendor,
      catalog: item.catalog,
      description: item.description ?? "",
      keywords: item.aiKeywords ?? [],
    });

    res.json({ description });
  } catch (err) {
    console.error("[inventory/suggest-description] failed:", err);
    res.status(502).json({ error: "Failed to generate description suggestion" });
  }
});

// ── POST /inventory/classify ────────────────────────────────────────────
// Spec-compliant alias of POST /categories/classify. Same body shape:
//   { mode?: "all" | "unclassified" | "specific-ids", ids?: number[], useAi?: boolean }
// Streams SSE progress.
function requireAdminForClassify(
  req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction,
): void {
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    res.status(503).json({ error: "Admin access is not configured. Set ADMIN_PASSWORD." });
    return;
  }
  const authHeader = req.headers["authorization"] ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token || !verifyAdminToken(token, adminPassword)) {
    res.status(401).json({ error: "Unauthorized: valid admin token required" });
    return;
  }
  next();
}
router.post("/classify", requireAdminForClassify, classifyHandler);

// ── PATCH /inventory/:id/category ───────────────────────────────────────
// Admin: manually set a part's category node. Always sets classified_by="manual"
// so subsequent classifier runs in mode="unclassified" leave this row alone.
router.patch("/:id/category", requireAdminForClassify, async (req, res) => {
  try {
    const id = parseInt(String(req.params["id"] ?? "0"));
    if (!Number.isFinite(id) || id <= 0) {
      return void res.status(400).json({ error: "id must be a positive integer" });
    }
    const { categoryNodeId } = req.body as { categoryNodeId?: number };
    if (!Number.isFinite(categoryNodeId) || (categoryNodeId ?? 0) <= 0) {
      return void res.status(400).json({ error: "categoryNodeId is required" });
    }

    // Verify both rows exist before mutating.
    const [item] = await db
      .select({ id: inventoryTable.id })
      .from(inventoryTable)
      .where(eq(inventoryTable.id, id))
      .limit(1);
    if (!item) return void res.status(404).json({ error: "Inventory item not found" });

    const [node] = await db
      .select({ id: categoryNodeTable.id, level: categoryNodeTable.level })
      .from(categoryNodeTable)
      .where(eq(categoryNodeTable.id, categoryNodeId!))
      .limit(1);
    if (!node) return void res.status(404).json({ error: "Category node not found" });
    // Enforce: inventory may only be assigned to a leaf "type" node so the
    // browse drill-down always lands on a Category → Subcategory → Type path.
    if (node.level !== "type") {
      return void res.status(400).json({
        error: "Inventory can only be assigned to a leaf type node",
      });
    }

    await db.delete(inventoryCategoryTable).where(eq(inventoryCategoryTable.inventoryId, id));
    await db.insert(inventoryCategoryTable).values({
      inventoryId: id,
      categoryNodeId: categoryNodeId!,
      confidence: "1.0000",
      classifiedBy: "manual",
    });
    res.json({ ok: true, inventoryId: id, nodeId: categoryNodeId });
  } catch (err) {
    console.error("[inventory/:id/category] failed:", err);
    res.status(500).json({ error: "Failed to set category for item" });
  }
});

export default router;
