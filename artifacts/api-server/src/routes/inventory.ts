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
import Fuse from "fuse.js";
import { verifyAdminToken } from "./admin";
import { expandMeasurements } from "../utils/measurementConversion";
import {
  normalizeMeasurement,
  parseCatalogNumber,
  correctMisspelling,
  compareBySize,
  getSeriesBase,
  itemFullText,
  tokenMatch,
  matchesChipFilters,
  buildChipFilterRegexes,
} from "../utils/searchHelpers";
import { TAXONOMY, findNodeBySlug, collectKeywords, getAllTaxonomyKeywords } from "@workspace/db";
import { generateKeywords } from "../utils/generateKeywords";
import {
  blendPgScore,
  catalogScore,
  applyVendorBoost,
  shouldUpdateScore,
  fuseConfidence,
} from "../utils/scoreHelpers";

const router = Router();

// ── GET /inventory ────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query["page"] as string) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query["limit"] as string) || 50));
    const offset = (page - 1) * limit;

    const [items, countResult] = await Promise.all([
      db.select().from(inventoryTable).limit(limit).offset(offset).orderBy(inventoryTable.vendor, inventoryTable.catalog),
      db.select({ count: sql<number>`count(*)` }).from(inventoryTable),
    ]);

    res.json({
      items: items.map(item => ({
        ...item,
        binLocations: item.binLocations,
        aiKeywords: item.aiKeywords,
      })),
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
  { key: "sizeChip",      options: ['1/2"','3/4"','1"','1-1/4"','1-1/2"','2"','2-1/2"','3"','4"','6"'] },
  { key: "rating",        options: ["NEMA 1","NEMA 3R","NEMA 4","NEMA 4X","NEMA 12","NEMA 7","IP65","IP67","UL Listed","CSA"] },
  { key: "wireType",      options: ["THHN","THWN","NM-B","MC","UF","SER","Armored","Plenum","URD","USE"] },
  { key: "wireGauge",     options: ["#14","#12","#10","#8","#6","#4","#2","1/0","2/0","3/0","4/0","350","500"] },
  { key: "conduitType",   options: ["EMT","PVC","RMC","IMC","FMC","LFMC","ENT","HDPE","RTRC","GRC"] },
  { key: "conduitSize",   options: ['1/2"','3/4"','1"','1-1/4"','1-1/2"','2"','2-1/2"','3"','4"'] },
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
      categorySlug = "",
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
      categorySlug?: string;
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
    const synonymMapLookup = new Map(synonyms.map(s => [s.term, s.synonyms]));
    const slangMap = new Map(slang.map(s => [s.slangTerm, s.standardTerms]));

    const reverseVendorMap = new Map<string, string>();
    for (const v of vendors) {
      for (const name of v.names) reverseVendorMap.set(name.toLowerCase(), v.code);
    }

    // Resolve taxonomy category if categorySlug is provided
    // All three slugs in the uncategorized branch trigger inverse-match logic
    const isCategoryUncategorized =
      categorySlug === "uncategorized" ||
      categorySlug === "needs-review" ||
      categorySlug === "unclassified-items";
    const categoryNode = (categorySlug && !isCategoryUncategorized)
      ? findNodeBySlug(TAXONOMY, categorySlug)
      : null;
    const categoryKeywords = categoryNode ? collectKeywords(categoryNode) : [];

    // allSearchText uses the raw keywords — no sampling heuristic for category browse
    const allSearchText = [keywords, catalogInput, vendorInput, color, size, material, textNumbers]
      .filter(Boolean).join(" ");

    // Build category regex for SQL pre-filter (non-uncategorized categories)
    const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapeSql  = (s: string) => s.replace(/'/g, "''");
    const catSqlRegex = (!isCategoryUncategorized && categoryKeywords.length > 0)
      ? categoryKeywords.map(escapeRegex).join("|")
      : null;

    if (!allSearchText.trim() && !categorySlug) {
      return void res.json({ results: [], totalMatches: 0, belowThreshold: 0 });
    }

    // Dedicated path: non-uncategorized category browse with no text query.
    // Returns every item whose chip text matches the node's keyword union via
    // a SQL-literal regex so the GIN trigram index can be used.
    if (categorySlug && !isCategoryUncategorized && catSqlRegex && !allSearchText.trim()) {
      const catItems = await db
        .select()
        .from(inventoryTable)
        .where(sql.raw(`inventory_chip_text(vendor, catalog, description, ai_keywords) ~* '${escapeSql(catSqlRegex)}'`))
        .orderBy(inventoryTable.vendor, inventoryTable.catalog)
        .limit(200);
      return void res.json({
        results: catItems.map(item => ({
          item,
          confidence: 1.0,
          matchReason: "category browse",
          seriesBase: getSeriesBase(item.vendor, item.catalog, item.description)?.key ?? null,
          seriesLabel: getSeriesBase(item.vendor, item.catalog, item.description)?.label ?? null,
          variants: [],
        })),
        totalMatches: catItems.length,
        belowThreshold: 0,
      });
    }

    // Special path: uncategorized browse with no search text — return all items that
    // don't match any taxonomy keyword (same inverse-regex logic as the post-filter).
    if (isCategoryUncategorized && !allSearchText.trim()) {
      const allItems = await db.select().from(inventoryTable);
      const allTaxKws = getAllTaxonomyKeywords(TAXONOMY);
      const uncatItems = allItems.filter(item => {
        const text = itemFullText(item);
        return !allTaxKws.some(kw => text.includes(kw));
      });
      return void res.json({
        results: uncatItems.map(item => ({
          item,
          confidence: 1.0,
          matchReason: "uncategorized browse",
          seriesBase: getSeriesBase(item.vendor, item.catalog, item.description)?.key ?? null,
          seriesLabel: getSeriesBase(item.vendor, item.catalog, item.description)?.label ?? null,
          variants: [],
        })),
        totalMatches: uncatItems.length,
        belowThreshold: 0,
      });
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
    // Build a websearch_to_tsquery input string. websearch_to_tsquery is the
    // hardened parser that never raises on stray operator characters and
    // accepts an explicit "OR" connector, so we no longer need to hand-build
    // a tsquery string with `|` (which was only safe by virtue of the strip
    // regex below). We still pre-strip non-word characters and drop tokens
    // that would degrade ranking (pure numbers, lone stopwords) but the
    // resulting query is parsed safely by Postgres regardless.
    const FTS_STOPWORDS = new Set(["in", "at", "on", "of", "to", "by", "as", "an", "or", "it"]);
    const ftsTokens = allTermsArr
      .flatMap(t => t.replace(/[^\w\s]/g, " ").trim().split(/\s+/).filter(Boolean))
      .filter(t =>
        t.length >= 2 &&
        /^[a-zA-Z]/.test(t) &&
        !FTS_STOPWORDS.has(t.toLowerCase()),
      );
    // websearch_to_tsquery: "term1 OR term2 OR term3" → (term1 | term2 | term3)
    const tsQuery = ftsTokens.join(" OR ");

    // ─── PG FTS + trigram ranked search (server-side) ───────────────────────
    type RawRow = {
      id: number; vendor: string; catalog: string; description: string;
      bin_locations: string[]; ai_keywords: string[]; barcodes: string[];
      enriched_at: Date | null; image_url: string | null; created_at: Date; updated_at: Date;
      fts_rank: number; trgm_sim: number;
    };

    const rawKeywords = keywords.trim();
    const kwLike = rawKeywords ? `%${rawKeywords}%` : null;

    // Push chip-filter predicates into SQL so the LIMIT 200 cap applies
    // AFTER chip filtering, not before. Without this, a less-common
    // attribute filter (e.g. colorChip="Red") could silently drop matching
    // items that ranked outside the top 200 candidates.
    const chipRegexes = buildChipFilterRegexes(activeChipFilters);

    let pgResults: RawRow[] = [];
    try {
      if (tsQuery.trim() || kwLike) {
        // Pass raw keyword string alongside expanded terms for catalog trigram scoring
        const catalogTrgmTerms = [
          rawKeywords,
          ...allTermsArr.slice(0, 3),
        ].filter(Boolean).join(" ").trim() || allTermsArr.slice(0, 3).join(" ");

        const chipText = sql`lower(
          coalesce(i.vendor,'') || ' ' || coalesce(i.catalog,'') || ' ' ||
          coalesce(i.description,'') || ' ' ||
          coalesce(array_to_string(i.ai_keywords, ' '), '')
        )`;
        const chipClauses = chipRegexes.length
          ? sql`AND ${sql.join(
              chipRegexes.map(rx => sql`${chipText} ~* ${rx}`),
              sql` AND `,
            )}`
          : sql``;

        const catClause = catSqlRegex
          ? sql`AND (${chipText} ~* ${catSqlRegex})`
          : sql``;

        // Wrap in a subquery so ORDER BY can reference the computed column aliases.
        // PostgreSQL only resolves aliases in ORDER BY when used as direct references
        // (not inside arithmetic expressions like fts_rank * 0.6 + trgm_sim * 0.4).
        const pgQueryResult = await db.execute(sql`
          SELECT * FROM (
            SELECT
              i.id, i.vendor, i.catalog, i.description,
              i.bin_locations, i.ai_keywords, i.barcodes, i.enriched_at, i.image_url, i.created_at, i.updated_at,
              ${tsQuery.trim() ? sql`ts_rank_cd(
                to_tsvector('english',
                  coalesce(i.vendor,'') || ' ' || coalesce(i.catalog,'') || ' ' ||
                  coalesce(i.description,'') || ' ' ||
                  coalesce(array_to_string(i.ai_keywords, ' '), '')
                ),
                websearch_to_tsquery('english', ${tsQuery})
              )` : sql`0`} AS fts_rank,
              greatest(
                similarity(i.catalog, ${catalogTrgmTerms}),
                similarity(i.description, ${allTermsArr.slice(0,5).join(" ")})
              ) AS trgm_sim
            FROM inventory i
            WHERE (
              ${tsQuery.trim() ? sql`to_tsvector('english',
                coalesce(i.vendor,'') || ' ' || coalesce(i.catalog,'') || ' ' ||
                coalesce(i.description,'') || ' ' ||
                coalesce(array_to_string(i.ai_keywords, ' '), '')
              ) @@ websearch_to_tsquery('english', ${tsQuery})
              OR` : sql``}
              similarity(i.catalog, ${catalogTrgmTerms}) > 0.1
              OR similarity(i.description, ${allTermsArr.slice(0,5).join(" ")}) > 0.1
              ${kwLike ? sql`OR i.catalog ILIKE ${kwLike}` : sql``}
              ${vendorFilter ? sql`OR upper(i.vendor) = ${vendorFilter}` : sql``}
            )
            ${chipClauses}
            ${catClause}
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
        barcodes: Array.isArray(row.barcodes) ? row.barcodes as string[] : [],
        enrichedAt: row.enriched_at instanceof Date ? row.enriched_at : null,
        // PDF catalog enrichment columns — image_url is now included in the SELECT
        imageUrl: typeof row.image_url === "string" ? row.image_url : null,
        imageSource: null,
        imageConfidence: null,
        previousDescription: null,
        catalogPdfJobId: null,
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

    // Fuse.js fallback for small datasets or when PG returns nothing
    if (scoreMap.size < 5) {
      const inventory = await db.select().from(inventoryTable);
      const fuse = new Fuse(inventory, {
        keys: [
          { name: "catalog", weight: 0.35 },
          { name: "description", weight: 0.30 },
          { name: "vendor", weight: 0.10 },
          { name: "aiKeywords", weight: 0.25 },
        ],
        threshold: 0.45,
        ignoreLocation: true,
        minMatchCharLength: 2,
        findAllMatches: true,
        includeScore: true,
      });

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

    // ── Apply taxonomy category pre-filter ───────────────────────────────────
    const catPreFiltered = (() => {
      if (!categorySlug) return results;
      if (isCategoryUncategorized) {
        const allTaxKws = getAllTaxonomyKeywords(TAXONOMY);
        return results.filter(r => !allTaxKws.some(kw => itemFullText(r.item).includes(kw)));
      }
      if (categoryKeywords.length > 0) {
        return results.filter(r => categoryKeywords.some(kw => itemFullText(r.item).includes(kw)));
      }
      return results;
    })();

    // ── Apply structured chip AND-filters to narrow results ─────────────────
    const chipFiltered = activeChipFilters.length > 0
      ? catPreFiltered.filter(r => matchesChipFilters(r.item, activeChipFilters))
      : catPreFiltered;

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
      // Untyped items (no detectable size) sort to the end via compareBySize.
      return compareBySize(a.item, b.item);
    });

    const finalResults = aboveThreshold.map(r => ({
      item: r.item,
      confidence: r.confidence,
      matchReason: r.reason,
      seriesBase: getSeriesBase(r.item.vendor, r.item.catalog, r.item.description)?.key ?? null,
      seriesLabel: getSeriesBase(r.item.vendor, r.item.catalog, r.item.description)?.label ?? null,
      variants: (variantMap.get(r.item.id) ?? []),
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

// ── POST /inventory/add-part ──────────────────────────────────────────────────
// Quick single-part entry. Admin-protected. Returns 409 if the vendor+catalog
// combination already exists in the database.
router.post("/add-part", requireAdminAuth, async (req, res) => {
  try {
    const { vendor, catalog, binLocation } = req.body as {
      vendor?: string;
      catalog?: string;
      binLocation?: string;
    };

    if (!vendor?.trim() || !catalog?.trim()) {
      return void res.status(400).json({ error: "vendor and catalog are required" });
    }

    const upperVendor = vendor.trim().toUpperCase();
    const trimmedCatalog = catalog.trim();
    const binLocations = binLocation?.trim() ? [binLocation.trim()] : [];

    // Check for duplicate before inserting so we can return a clear 409.
    const existing = await db
      .select({ id: inventoryTable.id })
      .from(inventoryTable)
      .where(and(eq(inventoryTable.vendor, upperVendor), eq(inventoryTable.catalog, trimmedCatalog)));

    if (existing.length > 0) {
      return void res.status(409).json({
        error: `Part already exists: ${upperVendor} / ${trimmedCatalog}`,
      });
    }

    const [created] = await db
      .insert(inventoryTable)
      .values({
        vendor: upperVendor,
        catalog: trimmedCatalog,
        description: "",
        binLocations,
        aiKeywords: [],
      })
      .returning();

    res.status(201).json({ item: created });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to add part" });
  }
});

// ── POST /inventory/upsert-batch/preview ──────────────────────────────────────
// Dry-run: accepts the same body as upsert-batch but only returns a diff
// summary (willReplaceBins, willAddBins, willPreserveBins, noChange) plus
// per-row details so the UI can warn admins before committing destructive bin
// replacements. Nothing is written to the database.
router.post("/upsert-batch/preview", requireAdminAuth, async (req, res) => {
  try {
    const contentLength = Number(req.headers["content-length"] ?? 0);
    if (contentLength > UPSERT_BATCH_MAX_BYTES) {
      return void res.status(413).json({
        error: `Request body too large (limit ${UPSERT_BATCH_MAX_BYTES} bytes)`,
      });
    }

    const { items } = req.body as {
      items: Array<{ vendor: string; catalog: string; description?: string; binLocations?: string[] }>;
    };

    if (!items?.length) {
      return void res.status(400).json({ error: "No items provided" });
    }

    if (items.length > UPSERT_BATCH_MAX_ITEMS) {
      return void res.status(413).json({
        error: `Too many items in batch (max ${UPSERT_BATCH_MAX_ITEMS})`,
      });
    }

    // Build lookup keys for the incoming rows that have bin data — those are
    // the only ones that can trigger a replacement.
    const pairs = items.map(item => ({
      vendor: item.vendor.toUpperCase(),
      catalog: item.catalog,
    }));

    // Fetch all existing rows that match any incoming (vendor, catalog) pair.
    // OR over the pairs so we get everything in one round-trip.
    const existingRows = pairs.length > 0
      ? await db
          .select({
            vendor: inventoryTable.vendor,
            catalog: inventoryTable.catalog,
            binLocations: inventoryTable.binLocations,
          })
          .from(inventoryTable)
          .where(
            or(
              ...pairs.map(p =>
                and(eq(inventoryTable.vendor, p.vendor), eq(inventoryTable.catalog, p.catalog)),
              ),
            ),
          )
      : [];

    const existingMap = new Map<string, string[]>();
    for (const row of existingRows) {
      existingMap.set(`${row.vendor}\0${row.catalog}`, row.binLocations);
    }

    type RowStatus = "replace" | "add" | "preserve" | "none";

    interface BinDiffRow {
      vendor: string;
      catalog: string;
      status: RowStatus;
      existingBins: string[];
      incomingBins: string[];
    }

    const rows: BinDiffRow[] = [];
    let willReplaceBins = 0;
    let willAddBins = 0;
    let willPreserveBins = 0;
    let noChange = 0;

    for (const item of items) {
      const key = `${item.vendor.toUpperCase()}\0${item.catalog}`;
      const existingBins = existingMap.get(key) ?? [];
      const incomingBins = item.binLocations ?? [];
      const hasIncoming = incomingBins.length > 0;
      const hasExisting = existingBins.length > 0;

      // Two bin arrays are "identical" when they contain the same values
      // regardless of order (sorted string comparison). Identical incoming bins
      // don't constitute a destructive replacement — skip the warning.
      const binsIdentical =
        hasIncoming &&
        hasExisting &&
        incomingBins.length === existingBins.length &&
        [...incomingBins].sort().join("\0") === [...existingBins].sort().join("\0");

      let status: RowStatus;
      if (hasIncoming && hasExisting && !binsIdentical) {
        status = "replace";
        willReplaceBins++;
      } else if (hasIncoming && !hasExisting) {
        status = "add";
        willAddBins++;
      } else if (!hasIncoming && hasExisting) {
        status = "preserve";
        willPreserveBins++;
      } else {
        status = "none";
        noChange++;
      }

      rows.push({ vendor: item.vendor, catalog: item.catalog, status, existingBins, incomingBins });
    }

    res.json({ willReplaceBins, willAddBins, willPreserveBins, noChange, rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Preview failed" });
  }
});

// ── POST /inventory/upsert-batch ──────────────────────────────────────────────
// Cap the number of rows accepted in a single upsert-batch call. Higher than
// any legitimate UI flow (per-item bin edits send 1; bulk uploads use the
// /admin/upload route). Prevents a single oversized request from OOMing the
// server during DB processing.
const UPSERT_BATCH_MAX_ITEMS = 5000;
// Reject the request before doing any DB work if the body is unreasonably
// large. The global JSON parser is set to 25mb (for AI image payloads); these
// upsert routes have no business sending anything close to that.
const UPSERT_BATCH_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

router.post("/upsert-batch", requireAdminAuth, async (req, res) => {
  try {
    const contentLength = Number(req.headers["content-length"] ?? 0);
    if (contentLength > UPSERT_BATCH_MAX_BYTES) {
      return void res.status(413).json({
        error: `Request body too large (limit ${UPSERT_BATCH_MAX_BYTES} bytes)`,
      });
    }

    const { items } = req.body as {
      items: Array<{ vendor: string; catalog: string; description?: string; binLocations?: string[]; barcodes?: string[] }>;
    };

    if (!items?.length) {
      return void res.status(400).json({ error: "No items provided" });
    }

    if (items.length > UPSERT_BATCH_MAX_ITEMS) {
      return void res.status(413).json({
        error: `Too many items in batch (max ${UPSERT_BATCH_MAX_ITEMS})`,
      });
    }

    let inserted = 0;
    let updated = 0;

    for (const item of items) {
      // Atomic upsert via the (vendor, catalog) unique index. Mirrors the seed
      // importer pattern so that two concurrent writers for the same key can't
      // both miss-then-insert and race on the unique constraint.
      const result = await db
        .insert(inventoryTable)
        .values({
          vendor: item.vendor.toUpperCase(),
          catalog: item.catalog,
          description: item.description ?? "",
          binLocations: item.binLocations ?? [],
          barcodes: item.barcodes ?? [],
          aiKeywords: [],
        })
        .onConflictDoUpdate({
          target: [inventoryTable.vendor, inventoryTable.catalog],
          set: {
            // Preserve existing description when the incoming value is empty
            // (matches /admin/upload semantics — re-uploads lacking a
            // description column shouldn't blank out enriched descriptions).
            description: sql`CASE WHEN length(EXCLUDED.description) > 0 THEN EXCLUDED.description ELSE ${inventoryTable.description} END`,
            // Preserve existing bins when no bin data is supplied — guards
            // multi-bin assignments during bulk re-uploads (Task #455).
            binLocations: sql`CASE WHEN coalesce(array_length(EXCLUDED.bin_locations, 1), 0) > 0 THEN EXCLUDED.bin_locations ELSE ${inventoryTable.binLocations} END`,
            // Preserve existing barcodes when no barcode data is supplied —
            // same semantics as binLocations so manual scan assignments survive
            // re-uploads that omit the barcodes column.
            barcodes: sql`CASE WHEN coalesce(array_length(EXCLUDED.barcodes, 1), 0) > 0 THEN EXCLUDED.barcodes ELSE ${inventoryTable.barcodes} END`,
            updatedAt: sql`now()`,
          },
        })
        .returning({ isNew: sql<boolean>`(xmax = 0)` });

      if (result[0]?.isNew) inserted++;
      else updated++;
    }

    res.json({ inserted, updated, total: items.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Upsert failed" });
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
        const keywords = await generateKeywords(item);

        await db
          .update(inventoryTable)
          .set({
            aiKeywords: keywords,
            enrichedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(inventoryTable.id, item.id));

        processed++;
        return { id: item.id, keywords };
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

// ── GET /inventory/barcode/{code} ────────────────────────────────────────────
// OpenAPI spec declares this as /inventory/barcode/{code}. A regex route is
// used instead of a path-to-regexp string pattern so that barcodes containing
// forward slashes (encoded as %2F by the client) are captured in a single
// group without triggering path-to-regexp v8's named-parameter restrictions.
// Capture group 1 holds the raw encoded segment; decodeURIComponent decodes it.
// Returns the first item whose barcodes array contains the code (case-sensitive).
router.get(/^\/barcode\/(.+)$/, async (req, res) => {
  try {
    const raw = (req.params as unknown as Record<string, string>)["0"] ?? "";
    const code = decodeURIComponent(raw).trim();
    if (!code) return void res.status(400).json({ error: "code is required" });

    const [item] = await db
      .select()
      .from(inventoryTable)
      .where(sql`${inventoryTable.barcodes} @> ARRAY[${code}]::text[]`)
      .limit(1);

    if (!item) return void res.status(404).json({ error: "No item found for that barcode" });
    res.json(item);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Barcode lookup failed" });
  }
});

// ── PATCH /inventory/:id/barcodes ─────────────────────────────────────────────
// Admin-only: replace the barcodes array on a single part.
router.patch("/:id/barcodes", requireAdminAuth, async (req, res) => {
  try {
    const id = parseInt(String(req.params["id"] ?? "0"));
    const { barcodes } = req.body as { barcodes: unknown };

    if (!Array.isArray(barcodes) || !barcodes.every((b) => typeof b === "string")) {
      return void res.status(400).json({ error: "barcodes must be an array of strings" });
    }

    const seen = new Set<string>();
    const normalised: string[] = [];
    for (const raw of barcodes as string[]) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      normalised.push(trimmed);
    }

    const [updated] = await db
      .update(inventoryTable)
      .set({ barcodes: normalised, updatedAt: new Date() })
      .where(eq(inventoryTable.id, id))
      .returning();

    if (!updated) return void res.status(404).json({ error: "Item not found" });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update barcodes" });
  }
});

// ── PATCH /inventory/:id/bins ─────────────────────────────────────────────────
// Admin-only: replace the bin-locations array on a single part. Lets warehouse
// staff fix bins in place without re-uploading the whole spreadsheet (Task #454).
router.patch("/:id/bins", requireAdminAuth, async (req, res) => {
  try {
    const id = parseInt(String(req.params["id"] ?? "0"));
    const { binLocations } = req.body as { binLocations: unknown };

    if (!Array.isArray(binLocations) || !binLocations.every((b) => typeof b === "string")) {
      return void res.status(400).json({ error: "binLocations must be an array of strings" });
    }

    // Normalise: trim, drop empties, de-duplicate (case-insensitive). Preserves
    // the user-typed casing of the first occurrence so display stays predictable.
    const seen = new Set<string>();
    const normalised: string[] = [];
    for (const raw of binLocations as string[]) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      normalised.push(trimmed);
    }

    const [updated] = await db
      .update(inventoryTable)
      .set({ binLocations: normalised, updatedAt: new Date() })
      .where(eq(inventoryTable.id, id))
      .returning();

    if (!updated) return void res.status(404).json({ error: "Item not found" });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update bins" });
  }
});

// ── PATCH /inventory/:id/description ─────────────────────────────────────────
// Admin-only: update the free-text description on a single part. Lets admins
// enrich a part's description after quick-add without re-uploading the sheet.
router.patch("/:id/description", requireAdminAuth, async (req, res) => {
  try {
    const id = parseInt(String(req.params["id"] ?? "0"));
    const { description } = req.body as { description?: unknown };

    if (typeof description !== "string") {
      return void res.status(400).json({ error: "description must be a string" });
    }

    const [updated] = await db
      .update(inventoryTable)
      .set({ description: description.trim(), updatedAt: new Date() })
      .where(eq(inventoryTable.id, id))
      .returning();

    if (!updated) return void res.status(404).json({ error: "Item not found" });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update description" });
  }
});

// ── PATCH /inventory/:id/keywords ─────────────────────────────────────────────
router.patch("/:id/keywords", async (req, res) => {
  try {
    const id = parseInt(req.params["id"] ?? "0");
    const { keywords } = req.body as { keywords: string[] };

    if (!Array.isArray(keywords)) {
      return void res.status(400).json({ error: "keywords must be an array" });
    }

    const [updated] = await db
      .update(inventoryTable)
      .set({ aiKeywords: keywords, updatedAt: new Date() })
      .where(eq(inventoryTable.id, id))
      .returning();

    if (!updated) return void res.status(404).json({ error: "Item not found" });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update keywords" });
  }
});

export default router;
