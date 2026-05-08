/**
 * Inventory routes — search, list, batch upsert, AI enrichment, per-item
 * keyword edits. The search endpoint runs a hybrid pg_trgm + ilike query
 * and returns dimension counts so the mobile app can render filter chips
 * without a second round-trip.
 */
import { Router } from "express";
import { eq, sql, ilike, or, and, desc, not, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  inventoryTable,
  abbreviationMapTable,
  vendorMapTable,
  misspellingMapTable,
  electricalSlangMapTable,
  synonymGroupTable,
  productSeriesTable,
  dictionaryVersionTable,
} from "@workspace/db";
import { batchProcessWithSSE } from "@workspace/integrations-openai-ai-server/batch";
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
import type { AbbreviationMapRow, SlangMapRow, MisspellingMapRow } from "../enrichment/buildSearchTokens";
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
} from "../utils/scoreHelpers";
import { normalizeQuery } from "../search/normalize";
import { logSearchEvent, type QuerySource } from "../search/telemetry";
import { mergeBins, dedupeBinsCaseInsensitive } from "../utils/binLocations";
import { deriveTradeSizeTokens, parseTradeSizeInches, tradeSizeChipLabel, isConduitOrPipe } from "../utils/tradeSize";
import { parseCatalog, deriveAttrs, parseTradeSize } from "../enrichment/parseAttributes";
import { buildSearchTokens } from "../enrichment/buildSearchTokens";
import { CURRENT_PROMPT_VERSION, CURRENT_PARSER_VERSION } from "../enrichment/invalidation";
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
    const q = (req.query["q"] as string | undefined)?.trim() ?? "";

    // Build where clause: combine unenrichedOnly filter with optional text search.
    // Text search does ILIKE on vendor, catalog, and description.
    let whereClause;
    if (q) {
      const like = `%${q}%`;
      const searchFilter = or(
        ilike(inventoryTable.vendor, like),
        ilike(inventoryTable.catalog, like),
        ilike(inventoryTable.description, like),
      );
      whereClause = unenrichedOnly
        ? and(sql`${inventoryTable.enrichedAt} IS NULL`, searchFilter)
        : searchFilter;
    } else {
      whereClause = unenrichedOnly
        ? sql`${inventoryTable.enrichedAt} IS NULL`
        : undefined;
    }

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
  const startTime = performance.now();
  const layersHit: string[] = [];
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
      querySource = "typed",
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
      querySource?: QuerySource;
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

    // Load dictionaries in parallel.
    // Synonyms, slang, and vendor aliases are now handled at enrichment time
    // via buildSearchTokens() / search_tokens column — no per-request lookup.
    const [misspellings, abbreviations, vendors] = await Promise.all([
      db.select().from(misspellingMapTable),
      db.select().from(abbreviationMapTable),
      db.select().from(vendorMapTable),
    ]);

    const correctionMap = new Map(misspellings.map(m => [m.misspelling, m.correction]));
    const abbrevMap = new Map(abbreviations.map(a => [a.abbreviation, a.expansions]));
    const vendorFullNameMap = buildVendorFullNameMap(vendors);

    const allSearchText = [keywords, catalogInput, vendorInput, color, size, material, textNumbers]
      .filter(Boolean).join(" ");

    // ── Step 1: Unicode normalization (telemetry + pre-processing) ───────────
    // normalizeQuery runs first — before any expansion — so query_normalized
    // in search_event captures the input exactly as the pipeline first saw it.
    const queryNormalizedForTelemetry = normalizeQuery(allSearchText);

    if (!allSearchText.trim()) {
      // Log a telemetry event even for empty queries so coverage is complete.
      // Awaited (non-throwing) so we can return the real searchEventId.
      const emptyEventId = await logSearchEvent({
        queryRaw: allSearchText,
        queryNormalized: queryNormalizedForTelemetry,
        querySource,
        filtersJson: {},
        resultsCount: 0,
        topResultId: null,
        latencyMs: Math.round(performance.now() - startTime),
        layersHit: [],
      });
      return void res.json({
        results: [],
        totalMatches: 0,
        belowThreshold: 0,
        _telemetry: { searchEventId: emptyEventId > 0n ? Number(emptyEventId) : null },
      });
    }

    // ── Step 2: Domain normalization (measurement units, abbreviations) ──────
    // normalizeQuery output feeds into normalizeMeasurement, making Unicode
    // normalization the literal first step in the processing pipeline.
    const normalized = normalizeMeasurement(queryNormalizedForTelemetry);
    const words = normalized.split(/\s+/).filter(w => w.length > 1);
    const corrected = words.map(w => correctMisspelling(w, correctionMap));

    // Abbreviation expansion stays at query time (per task spec).
    // Synonym/slang/vendor alias expansion is now index-time (search_tokens column).
    const expandedTerms = new Set<string>(corrected);
    for (const word of corrected) {
      const wl = word.toLowerCase();
      abbrevMap.get(wl)?.forEach(e => expandedTerms.add(e));
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
      series_id: number | null;
      fts_rank: number; trgm_sim: number;
    };

    const rawKeywords = keywords.trim();
    const kwLike = rawKeywords ? `%${rawKeywords}%` : null;
    // Separate ILIKE fallback for the catalog field — needed because catalog
    // numbers like "477LT2" start with a digit and are stripped from tsQuery
    // by the /^[a-zA-Z]/ filter, yet trigram similarity against the long
    // search_tokens string is too low (< 0.3) to fire the % operator.
    const rawCatalog = catalogInput.trim();
    const catalogLike = rawCatalog ? `%${rawCatalog}%` : null;

    let pgResults: RawRow[] = [];
    try {
      if (tsQuery.trim() || kwLike || catalogLike || vendorFilter) {
        // Token string used for trigram similarity against the pre-expanded
        // search_tokens column. Concatenating abbreviation-expanded terms with
        // the raw keyword gives the best coverage.
        const trgmQuery = allTermsArr.slice(0, 5).join(" ");

        // Dual tsquery: 'simple' matches catalog/vendor lexemes exactly (no stemming),
        // 'english' matches description/ai_keywords lexemes via stemming. OR-ing them
        // ensures "breaker" finds both catalog "BREAKER" entries and descriptions
        // containing "breakers". The generated search_tsv column avoids rebuilding
        // the tsvector on every query — the GIN index (idx_inventory_search_tsv) is
        // used directly by EXPLAIN ANALYZE on typical queries.
        //
        // ts_rank_cd weight array '{0.1, 0.3, 0.6, 1.0}' = {D, C, B, A}:
        //   A (catalog)     = 1.0  — catalog number hits score highest
        //   B (vendor)      = 0.6  — vendor code hits score second
        //   C (description) = 0.3  — description hits score third
        //   D (ai_keywords) = 0.1  — ai keyword hits score lowest
        //
        // Trigram similarity now runs against search_tokens (pre-expanded at
        // enrichment time) instead of description+catalog. Rows where
        // search_tokens is NULL (not yet backfilled) fall back to the old
        // catalog/description similarity so they are still searchable.
        //
        // Wrap in a subquery so ORDER BY can reference the computed column aliases.
        // PostgreSQL only resolves aliases in ORDER BY when used as direct references
        // (not inside arithmetic expressions like fts_rank * 0.65 + trgm_sim * 0.35).
        //
        // The query runs inside a transaction so SET LOCAL scopes the similarity
        // threshold to this single operation. pg_trgm defaults to 0.3 which is too
        // strict for short electrical catalog codes (e.g. "BR120") — those produce
        // only 2-3 shared trigrams with natural-language queries. 0.15 is the chosen
        // floor: it activates the GIN bitmap scan on idx_inventory_search_tokens_trgm
        // for typical warehouse queries while keeping false-positive volume manageable.
        //
        // The NULL fallback arm (rows not yet enriched with search_tokens) is isolated
        // in a separate UNION ALL member with LIMIT 50 so that un-enriched rows cannot
        // force a full sequential scan that dominates query time. Any row that appears
        // in both arms is deduplicated downstream by the scoreMap keyed on item ID.
        const pgQueryResult = await db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL pg_trgm.similarity_threshold = 0.15`);
          return tx.execute(sql`
            SELECT * FROM (
              -- Primary arm: FTS (idx_inventory_search_tsv GIN) and trigram on the
              -- pre-expanded search_tokens column (idx_inventory_search_tokens_trgm GIN).
              -- Catalog ILIKE, catalog %, and vendor exact-match are OR'd into this arm.
              -- Rows matched here but lacking search_tokens (e.g. via ILIKE) get their
              -- trgm_sim scored via catalog/description fallback in the COALESCE.
              SELECT
                i.id, i.vendor, i.catalog, i.description,
                i.bin_locations, i.ai_keywords, i.trade_size, i.enriched_at, i.created_at, i.updated_at,
                i.series_id,
                ${tsQuery.trim() ? sql`ts_rank_cd(
                  '{0.1, 0.3, 0.6, 1.0}', i.search_tsv,
                  to_tsquery('simple', ${tsQuery}) || to_tsquery('english', ${tsQuery})
                )` : sql`0`} AS fts_rank,
                COALESCE(
                  CASE WHEN i.search_tokens IS NOT NULL
                    THEN similarity(i.search_tokens, ${trgmQuery})
                    ELSE greatest(
                      similarity(i.catalog, ${trgmQuery}),
                      similarity(i.description, ${trgmQuery})
                    )
                  END,
                  0.0
                ) AS trgm_sim
              FROM inventory i
              WHERE
                ${tsQuery.trim() ? sql`i.search_tsv @@ (
                  to_tsquery('simple', ${tsQuery}) || to_tsquery('english', ${tsQuery})
                ) OR` : sql``}
                (i.search_tokens IS NOT NULL AND i.search_tokens % ${trgmQuery})
                ${kwLike ? sql`OR i.catalog ILIKE ${kwLike}` : sql``}
                ${catalogLike ? sql`OR i.catalog ILIKE ${catalogLike}` : sql``}
                ${trgmQuery ? sql`OR (i.catalog % ${trgmQuery})` : sql``}
                ${vendorFilter ? sql`OR upper(i.vendor) = ${vendorFilter}` : sql``}

              ${trgmQuery ? sql`
              UNION ALL

              -- Fallback arm: un-enriched rows (search_tokens IS NULL) matched only by
              -- fuzzy catalog/description similarity. Parenthesized so LIMIT 50 scopes
              -- exclusively to this arm and not to the combined union result — without
              -- parens PostgreSQL applies the LIMIT to the entire set-operation output.
              -- This caps the unindexed sequential scan so un-enriched rows cannot
              -- dominate query time even if a large fraction of the table is un-backfilled.
              (
                SELECT
                  i.id, i.vendor, i.catalog, i.description,
                  i.bin_locations, i.ai_keywords, i.trade_size, i.enriched_at, i.created_at, i.updated_at,
                  i.series_id,
                  0::float AS fts_rank,
                  greatest(
                    similarity(i.catalog, ${trgmQuery}),
                    similarity(i.description, ${trgmQuery})
                  ) AS trgm_sim
                FROM inventory i
                WHERE i.search_tokens IS NULL
                  AND (
                    similarity(i.catalog, ${trgmQuery}) > 0.1
                    OR similarity(i.description, ${trgmQuery}) > 0.1
                  )
                LIMIT 50
              )
              ` : sql``}
            ) AS __ranked
            ORDER BY (fts_rank * 0.65 + trgm_sim * 0.35) DESC
            LIMIT 200
          `);
        });
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
      console.warn("PG search error:", pgErr);
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
    // 0.05 noise floor: drop items whose blended base score is below the floor
    // before any catalog/vendor boosts are applied. This prevents very weak
    // trigram-only matches (e.g., short common substrings) from appearing in
    // results at all. The confidenceThreshold from the client applies on top.
    const PG_SCORE_FLOOR = 0.05;
    let pgHasFts = false;
    let pgHasTrgm = false;
    for (const row of pgResults) {
      const ftsRank = Number(row.fts_rank) || 0;
      const trgmSim = Number(row.trgm_sim) || 0;
      if (ftsRank > 0) pgHasFts = true;
      if (trgmSim > 0) pgHasTrgm = true;
      const pgScore = blendPgScore(ftsRank, trgmSim);
      // Catalog-ILIKE hits (e.g. digit-leading part numbers like "477LT2") have a
      // low trgm_sim against the long search_tokens string but would receive a
      // large boost from catalogScore() below. Skip the noise floor for those rows
      // so they aren't silently dropped before the boost is applied.
      const catalogHit =
        (rawCatalog && row.catalog.toUpperCase().includes(rawCatalog.toUpperCase())) ||
        (rawKeywords && row.catalog.toUpperCase().includes(rawKeywords.toUpperCase()));
      if (pgScore < PG_SCORE_FLOOR && !catalogHit) continue;
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
        catalogParse: null,
        amperage: null,
        poleCount: null,
        voltage: null,
        tradeSizeIn: null,
        mountType: null,
        attrsParsedAt: null,
        promptVersion: null,
        searchTokens: null,
        seriesId: typeof row.series_id === "number" ? row.series_id : null,
        tokensDictVersion: 0,
      };

      const { score, reason } = catalogScore(pgScore, row.catalog, catalogInput, rawKeywords, ftsRank);
      updateScore(item, score, reason);
    }
    if (pgHasFts) layersHit.push("fts");
    if (pgHasTrgm) layersHit.push("trigram");

    // Catalog ILIKE lookup — always runs when a catalog number or keyword was entered.
    // The main PG query caps at LIMIT 200 ordered by FTS/trigram score, which
    // can push an exact catalog match (e.g. "477LT2") off the list when
    // unrelated FTS hits fill the cap. This secondary lookup injects matching
    // catalog rows directly into scoreMap so they always appear in results.
    // Both the dedicated catalog field AND raw keywords are checked — a worker
    // may type a catalog number into either field.
    const catalogIlikeLookups = [rawCatalog, rawKeywords].filter(Boolean);
    if (catalogIlikeLookups.length > 0) {
      let catalogIlikeHit = false;
      for (const lookupVal of catalogIlikeLookups) {
        const catalogIlikeRows = await db
          .select()
          .from(inventoryTable)
          .where(sql`${inventoryTable.catalog} ILIKE ${`%${lookupVal}%`}`)
          .limit(30);
        for (const item of catalogIlikeRows) {
          const { score, reason } = catalogScore(0, item.catalog, lookupVal, rawKeywords, 0);
          updateScore(item, score, reason);
          catalogIlikeHit = true;
        }
      }
      if (catalogIlikeHit) layersHit.push("catalog_ilike");
    }

    // Exact catalog fallback if PG didn't catch it (checks both Catalog # field and raw keywords)
    if (pgResults.length === 0) {
      const lookups = [catalogInput, rawKeywords].filter(Boolean).map(v => v.toUpperCase());
      if (lookups.length > 0) {
        let exactCatalogHit = false;
        for (const lookupVal of lookups) {
          const exactRows = await db.select().from(inventoryTable)
            .where(sql`upper(${inventoryTable.catalog}) = ${lookupVal}`);
          for (const item of exactRows) { updateScore(item, 1.0, "exact catalog fallback"); exactCatalogHit = true; }
          // Also try ILIKE prefix fallback
          const prefixRows = await db.select().from(inventoryTable)
            .where(sql`upper(${inventoryTable.catalog}) LIKE ${lookupVal + "%"}`)
            .limit(20);
          for (const item of prefixRows) { updateScore(item, 0.93, "catalog prefix fallback"); exactCatalogHit = true; }
        }
        if (exactCatalogHit) layersHit.push("exact_catalog");
      }
    }

    // Apply vendor boost/penalty
    const results: ScoredItem[] = [];
    let vendorBoosted = false;
    for (const entry of scoreMap.values()) {
      const conf = applyVendorBoost(entry.confidence, vendorFilter, entry.item.vendor);
      if (vendorFilter && entry.item.vendor.toUpperCase() === vendorFilter.toUpperCase()) vendorBoosted = true;
      results.push({ ...entry, confidence: conf });
    }
    if (vendorBoosted) layersHit.push("vendor_boost");

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

    // Group into series + find variants.
    // Items with an explicit series_id are grouped by that ID (preferred path).
    // Items without series_id fall back to the heuristic getSeriesBase() grouping.
    const seriesGroups = new Map<string, { label: string; items: typeof inventoryTable.$inferSelect[] }>();
    for (const r of chipFiltered) {
      if (r.item.seriesId != null) {
        // Explicit series: use a stable key that won't collide with heuristic keys
        const key = `__series_id_${r.item.seriesId}`;
        const existing = seriesGroups.get(key) ?? { label: "OTHER SIZES", items: [] };
        existing.items.push(r.item);
        seriesGroups.set(key, existing);
      } else {
        const series = getSeriesBase(r.item.vendor, r.item.catalog, r.item.description);
        if (series) {
          const existing = seriesGroups.get(series.key) ?? { label: series.label, items: [] };
          existing.items.push(r.item);
          seriesGroups.set(series.key, existing);
        }
      }
    }

    const variantMap = new Map<number, typeof inventoryTable.$inferSelect[]>();
    const resultIds = new Set(chipFiltered.map(r => r.item.id));
    const excludeArr = Array.from(resultIds);

    if (seriesGroups.size > 0) {
      // Targeted per-series query replaces the former full-table scan.
      // For each series group found in results, we query only rows that share
      // the same series_id (preferred) or catalog-prefix heuristic (fallback).
      for (const [groupKey, group] of seriesGroups) {
        const primaryItem = group.items[0];
        if (!primaryItem) continue;

        let siblings: typeof inventoryTable.$inferSelect[];

        if (groupKey.startsWith("__series_id_") && primaryItem.seriesId != null) {
          // Preferred: explicit series_id — uses the idx_inventory_series_id index
          siblings = await db
            .select()
            .from(inventoryTable)
            .where(
              and(
                eq(inventoryTable.seriesId, primaryItem.seriesId),
                excludeArr.length > 0
                  ? not(inArray(inventoryTable.id, excludeArr))
                  : undefined,
              ),
            )
            .orderBy(sql`COALESCE(amperage, 9999) ASC, catalog ASC`)
            .limit(12);
        } else {
          // Heuristic fallback for items without an explicit series_id.
          // Parse the primary item's catalog in-memory to get the series prefix
          // and pole count (both O(1) regex ops — no extra DB round-trip).
          const parsed = parseCatalog(primaryItem.catalog);

          if (parsed?.series) {
            // Fast path: uses the idx_inventory_catalog_parse_series expression btree index on
            // (catalog_parse->>'series', pole_count) for items already backfilled.
            // Fallback: catalog ILIKE 'PREFIX%' for items not yet backfilled.
            siblings = await db
              .select()
              .from(inventoryTable)
              .where(
                and(
                  eq(inventoryTable.vendor, primaryItem.vendor),
                  sql`(
                    (catalog_parse IS NOT NULL AND (catalog_parse->>'series') = ${parsed.series})
                    OR
                    (catalog_parse IS NULL AND catalog ILIKE ${parsed.series + "%"})
                  )`,
                  parsed.poles !== null
                    ? sql`(pole_count = ${parsed.poles} OR pole_count IS NULL)`
                    : undefined,
                  sql`(series_id IS NULL)`,
                  excludeArr.length > 0
                    ? not(inArray(inventoryTable.id, excludeArr))
                    : undefined,
                ),
              )
              .orderBy(sql`COALESCE(amperage, 9999) ASC, catalog ASC`)
              .limit(12);
          } else {
            // Fallback for conduit/cable and other catalog patterns that parseCatalog
            // doesn't recognise yet. Strip leading digits from the catalog to find
            // the bare type prefix (e.g. "EMT212" → "EMT").
            // For all-numeric catalogs (e.g. "5262") stripping digits yields an
            // empty string — use the first 4 characters as the prefix instead.
            const stripped = primaryItem.catalog.replace(/^\d+/, "").slice(0, 8);
            const catalogPrefix = stripped.length >= 2
              ? stripped
              : primaryItem.catalog.slice(0, 4);
            if (!catalogPrefix || catalogPrefix.length < 2) continue;
            siblings = await db
              .select()
              .from(inventoryTable)
              .where(
                and(
                  eq(inventoryTable.vendor, primaryItem.vendor),
                  sql`catalog ILIKE ${catalogPrefix + "%"}`,
                  sql`(series_id IS NULL)`,
                  excludeArr.length > 0
                    ? not(inArray(inventoryTable.id, excludeArr))
                    : undefined,
                ),
              )
              .orderBy(sql`catalog ASC`)
              .limit(12);
          }
        }

        for (const sibling of siblings) {
          const variants = variantMap.get(primaryItem.id) ?? [];
          variants.push(sibling);
          variantMap.set(primaryItem.id, variants);
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

    // Resolve series names for any items (or their variants) that have a series_id.
    // A single batch query avoids N+1 lookups.
    const allSeriesIds = new Set<number>();
    for (const r of aboveThreshold) {
      if (r.item.seriesId != null) allSeriesIds.add(r.item.seriesId);
      for (const v of variantMap.get(r.item.id) ?? []) {
        if (v.seriesId != null) allSeriesIds.add(v.seriesId);
      }
    }
    const seriesNameMap = new Map<number, string>();
    if (allSeriesIds.size > 0) {
      const seriesRows = await db
        .select({ id: productSeriesTable.id, name: productSeriesTable.name })
        .from(productSeriesTable)
        .where(inArray(productSeriesTable.id, Array.from(allSeriesIds)));
      for (const row of seriesRows) seriesNameMap.set(row.id, row.name);
    }

    const attachSeriesName = <T extends { seriesId: number | null }>(item: T): T & { seriesName: string | null } => ({
      ...item,
      seriesName: item.seriesId != null ? (seriesNameMap.get(item.seriesId) ?? null) : null,
    });

    const finalResults = aboveThreshold.map(r => ({
      item: attachSeriesName(withVendorFullName(r.item, vendorFullNameMap)),
      confidence: r.confidence,
      matchReason: r.reason,
      seriesBase: getSeriesBase(r.item.vendor, r.item.catalog, r.item.description)?.key ?? null,
      seriesLabel: getSeriesBase(r.item.vendor, r.item.catalog, r.item.description)?.label ?? null,
      variants: (variantMap.get(r.item.id) ?? []).map(v => attachSeriesName(withVendorFullName(v, vendorFullNameMap))),
    }));

    const latencyMs = Math.round(performance.now() - startTime);
    const rawQuery = [keywords, catalogInput].filter(Boolean).join(" ");
    const topResultId = finalResults[0]?.item?.id ?? null;
    const allFilters = {
      vendor: vendorInput, color, size, material, textNumbers,
      category, amperage, colorChip, manufacturer, sizeChip, rating,
      wireType, wireGauge, conduitType, conduitSize, boxType, boxGangCount,
      mountingType, environment, voltage, poleCount,
    };

    // logSearchEvent is non-blocking by design (catches internally and returns
    // -1n on error) — awaiting it directly is safe and avoids the unreliability
    // of a Promise.race timeout (local Postgres inserts are < 5 ms).
    const searchEventId = await logSearchEvent({
      queryRaw: rawQuery,
      queryNormalized: queryNormalizedForTelemetry,
      querySource,
      filtersJson: allFilters,
      resultsCount: finalResults.length,
      topResultId,
      latencyMs,
      layersHit,
    });

    res.json({
      results: finalResults,
      totalMatches: chipFiltered.length,
      belowThreshold: belowCount,
      dimensionCounts,
      _telemetry: {
        searchEventId: searchEventId > 0n ? Number(searchEventId) : null,
      },
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
      // Mirrors shouldReenrich() in SQL so stale-prompt / stale-parser
      // items are also picked up by the SSE batch.
      itemsToEnrich = await db
        .select()
        .from(inventoryTable)
        .where(sql`(
          ${inventoryTable.enrichedAt} IS NULL
          OR ${inventoryTable.updatedAt} > ${inventoryTable.enrichedAt}
          OR COALESCE(${inventoryTable.promptVersion}, 0) < ${CURRENT_PROMPT_VERSION}
          OR COALESCE((${inventoryTable.catalogParse}->>'parser_version')::int, 0) < ${CURRENT_PARSER_VERSION}
        )`)
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

        const attrs = deriveAttrs(item);
        const tsInFull = isConduitOrPipe(item.catalog, item.vendor, item.description)
          ? (parseTradeSizeInches(item.catalog)
             ?? parseTradeSize(item.description)
             ?? parseTradeSize(item.catalog))
          : null;

        // Build index-time synonym tokens (load synonym_group once per enrichment batch
        // is not practical here; load per-item is acceptable for the small /enrich endpoint
        // which handles at most BATCH_SIZE=50 items at a time).
        const synonymGroups = await db
          .select({ canonical: synonymGroupTable.canonical, synonyms: synonymGroupTable.synonyms })
          .from(synonymGroupTable);
        const searchTokens = buildSearchTokens(
          { catalog: item.catalog, description: item.description, vendor: item.vendor, aiKeywords: merged },
          synonymGroups,
        );

        await db
          .update(inventoryTable)
          .set({
            aiKeywords: merged,
            tradeSize,
            enrichedAt: new Date(),
            updatedAt: new Date(),
            promptVersion: CURRENT_PROMPT_VERSION,
            // Materialized parse attrs (idempotent — same result each call)
            catalogParse: attrs.catalogParse as Record<string, unknown> | null,
            amperage: attrs.amperage,
            poleCount: attrs.poleCount,
            voltage: attrs.voltage,
            mountType: attrs.mountType,
            tradeSizeIn: tsInFull !== null && tsInFull <= 12 ? tsInFull.toFixed(3) : null,
            attrsParsedAt: attrs.attrsParsedAt,
            searchTokens,
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


async function enrichItemWithRetry(
  item: { id: number; vendor: string; catalog: string; description: string | null },
  tradeSize?: string,
): Promise<string[]> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= BULK_ENRICH_MAX_RETRY; attempt++) {
    try {
      return await generateKeywords(item, BULK_ENRICH_MODEL, tradeSize);
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
  // Load synonym groups once for the whole run — avoids a per-item DB hit.
  const bulkEnrichSynonymGroups = await db
    .select({ canonical: synonymGroupTable.canonical, synonyms: synonymGroupTable.synonyms })
    .from(synonymGroupTable);

  // Mirrors shouldReenrich() in SQL: picks up never-enriched items AND
  // items stale due to content drift, prompt version, or parser version.
  const NEEDS_ENRICH = sql`(
    ${inventoryTable.enrichedAt} IS NULL
    OR ${inventoryTable.updatedAt} > ${inventoryTable.enrichedAt}
    OR COALESCE(${inventoryTable.promptVersion}, 0) < ${CURRENT_PROMPT_VERSION}
    OR COALESCE((${inventoryTable.catalogParse}->>'parser_version')::int, 0) < ${CURRENT_PARSER_VERSION}
  )`;

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(inventoryTable)
    .where(NEEDS_ENRICH);

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
      .where(NEEDS_ENRICH)
      .limit(BULK_ENRICH_BATCH);

    if (batch.length === 0) break;

    for (let i = 0; i < batch.length; i += BULK_ENRICH_CONCUR) {
      const wave = batch.slice(i, i + BULK_ENRICH_CONCUR);
      const results = await Promise.allSettled(wave.map((item) => {
        const tradeSizeInches =
          parseTradeSizeInches(item.catalog) ??
          parseTradeSizeInches(item.description);
        const tradeSize = tradeSizeInches !== null
          ? tradeSizeChipLabel(tradeSizeInches) ?? undefined
          : undefined;
        return enrichItemWithRetry(item, tradeSize);
      }));

      for (let j = 0; j < results.length; j++) {
        const r = results[j]!;
        const item = wave[j]!;
        if (r.status === "fulfilled") {
          const tradeSizeInches =
            parseTradeSizeInches(item.catalog) ??
            parseTradeSizeInches(item.description);
          const tradeSize = tradeSizeInches !== null
            ? tradeSizeChipLabel(tradeSizeInches)
            : null;
          const tradeTokens = deriveTradeSizeTokens(item);
          const existing = new Set(r.value.map((k: string) => k.toLowerCase()));
          const merged = [
            ...r.value,
            ...tradeTokens.filter(t => !existing.has(t.toLowerCase())),
          ];
          const attrs = deriveAttrs(item);
          const tsInFull = isConduitOrPipe(item.catalog, item.vendor, item.description)
            ? (parseTradeSizeInches(item.catalog)
               ?? parseTradeSize(item.description)
               ?? parseTradeSize(item.catalog))
            : null;
          const searchTokens = buildSearchTokens(
            { catalog: item.catalog, description: item.description, vendor: item.vendor, aiKeywords: merged },
            bulkEnrichSynonymGroups,
          );
          await db
            .update(inventoryTable)
            .set({
              aiKeywords: merged,
              tradeSize,
              enrichedAt: new Date(),
              updatedAt: new Date(),
              promptVersion: CURRENT_PROMPT_VERSION,
              // Materialized parse attrs (idempotent — same result each call)
              catalogParse: attrs.catalogParse as Record<string, unknown> | null,
              amperage: attrs.amperage,
              poleCount: attrs.poleCount,
              voltage: attrs.voltage,
              mountType: attrs.mountType,
              tradeSizeIn: tsInFull !== null && tsInFull <= 12 ? tsInFull.toFixed(3) : null,
              attrsParsedAt: attrs.attrsParsedAt,
              searchTokens,
            })
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

// ── POST /inventory/rebuild-search-tokens ─────────────────────────────────────
// Legacy full-table rebuild — re-computes search_tokens for ALL inventory rows
// using all dictionary tables. Also stamps tokens_dict_version on each row so
// they are not considered stale by the smarter rebuild-tokens endpoint.
// Protected by admin auth; runs synchronously (returns when done).
router.post("/rebuild-search-tokens", requireAdminAuth, async (_req, res) => {
  const startTime = Date.now();
  try {
    // Read current dict version so we can stamp rows as current after rebuild
    const [versionRow] = await db
      .select({ version: dictionaryVersionTable.version })
      .from(dictionaryVersionTable)
      .where(eq(dictionaryVersionTable.id, 1));
    const currentVersion = versionRow?.version ?? 0;

    const [synonymGroups, abbreviationMaps, slangMaps, misspellingMaps] = await Promise.all([
      db.select({ canonical: synonymGroupTable.canonical, synonyms: synonymGroupTable.synonyms }).from(synonymGroupTable),
      db.select({ abbreviation: abbreviationMapTable.abbreviation, expansions: abbreviationMapTable.expansions }).from(abbreviationMapTable),
      db.select({ slangTerm: electricalSlangMapTable.slangTerm, standardTerms: electricalSlangMapTable.standardTerms }).from(electricalSlangMapTable),
      db.select({ misspelling: misspellingMapTable.misspelling, correction: misspellingMapTable.correction }).from(misspellingMapTable),
    ]);

    const BATCH_SIZE = 500;
    let processed = 0;
    let errors = 0;
    let lastId = 0;

    while (true) {
      const batch = await db
        .select({
          id: inventoryTable.id,
          catalog: inventoryTable.catalog,
          description: inventoryTable.description,
          vendor: inventoryTable.vendor,
          aiKeywords: inventoryTable.aiKeywords,
        })
        .from(inventoryTable)
        .where(sql`${inventoryTable.id} > ${lastId}`)
        .orderBy(inventoryTable.id)
        .limit(BATCH_SIZE);

      if (batch.length === 0) break;

      for (const item of batch) {
        try {
          const tokens = buildSearchTokens(item, synonymGroups, { abbreviationMaps: abbreviationMaps as AbbreviationMapRow[], slangMaps: slangMaps as SlangMapRow[], misspellingMaps: misspellingMaps as MisspellingMapRow[] });
          await db
            .update(inventoryTable)
            .set({ searchTokens: tokens, tokensDictVersion: currentVersion })
            .where(eq(inventoryTable.id, item.id));
          processed++;
        } catch (err) {
          errors++;
          console.error(`[rebuild-search-tokens] id=${item.id}:`, err);
        }
      }

      lastId = batch[batch.length - 1]!.id;
      if (batch.length < BATCH_SIZE) break;
    }

    res.json({
      ok: true,
      processed,
      errors,
      durationMs: Date.now() - startTime,
      synonymGroupCount: synonymGroups.length,
      dictVersion: currentVersion,
    });
  } catch (err) {
    console.error("[rebuild-search-tokens] Fatal error:", err);
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /inventory/rebuild-tokens ────────────────────────────────────────────
// Versioned lightweight rebuild — streams SSE progress events while re-building
// search_tokens only for rows where tokens_dict_version < current dict_version.
// Uses all four dictionary tables (synonym_group, abbreviation_map,
// electrical_slang_map, misspelling_map) so the expansion is complete.
// Each SSE event is JSON: { processed, updated, total, dictVersion, done?, error? }
router.post("/rebuild-tokens", requireAdminAuth, async (_req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (data: object) => {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* client disconnected */ }
  };

  try {
    // 1. Read the current dictionary version
    const [versionRow] = await db
      .select({ version: dictionaryVersionTable.version })
      .from(dictionaryVersionTable)
      .where(eq(dictionaryVersionTable.id, 1));

    const currentVersion = versionRow?.version ?? 0;

    if (currentVersion === 0) {
      console.log("[rebuild-tokens] dict_version=0 — nothing to rebuild");
      send({ done: true, processed: 0, updated: 0, total: 0, dictVersion: 0 });
      res.end();
      return;
    }

    // 2. Count stale rows so the client can show a progress bar
    const [countRow] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(inventoryTable)
      .where(sql`${inventoryTable.tokensDictVersion} < ${currentVersion}`);

    const total = countRow?.total ?? 0;
    console.log(`[rebuild-tokens] Starting – ${total} stale rows (dict v${currentVersion})`);
    send({ processed: 0, updated: 0, total, dictVersion: currentVersion });

    if (total === 0) {
      send({ done: true, processed: 0, updated: 0, total: 0, dictVersion: currentVersion });
      res.end();
      return;
    }

    // 3. Load all dictionary tables once — they fit in RAM
    const [synonymGroups, abbreviationMaps, slangMaps, misspellingMaps] = await Promise.all([
      db.select({ canonical: synonymGroupTable.canonical, synonyms: synonymGroupTable.synonyms }).from(synonymGroupTable),
      db.select({ abbreviation: abbreviationMapTable.abbreviation, expansions: abbreviationMapTable.expansions }).from(abbreviationMapTable),
      db.select({ slangTerm: electricalSlangMapTable.slangTerm, standardTerms: electricalSlangMapTable.standardTerms }).from(electricalSlangMapTable),
      db.select({ misspelling: misspellingMapTable.misspelling, correction: misspellingMapTable.correction }).from(misspellingMapTable),
    ]);

    // 4. Cursor-paginated batch loop — only stale rows
    let processed = 0;
    let updated = 0;
    let lastId = 0;
    const REBUILD_TOKENS_BATCH = 500;

    while (true) {
      const batch = await db
        .select({
          id:          inventoryTable.id,
          catalog:     inventoryTable.catalog,
          description: inventoryTable.description,
          vendor:      inventoryTable.vendor,
          aiKeywords:  inventoryTable.aiKeywords,
        })
        .from(inventoryTable)
        .where(
          and(
            sql`${inventoryTable.id} > ${lastId}`,
            sql`${inventoryTable.tokensDictVersion} < ${currentVersion}`,
          ),
        )
        .orderBy(inventoryTable.id)
        .limit(REBUILD_TOKENS_BATCH);

      if (batch.length === 0) break;

      for (const item of batch) {
        try {
          const tokens = buildSearchTokens(item, synonymGroups, {
            abbreviationMaps: abbreviationMaps as AbbreviationMapRow[],
            slangMaps: slangMaps as SlangMapRow[],
            misspellingMaps: misspellingMaps as MisspellingMapRow[],
          });
          await db
            .update(inventoryTable)
            .set({ searchTokens: tokens, tokensDictVersion: currentVersion })
            .where(eq(inventoryTable.id, item.id));
          updated++;
        } catch (err) {
          console.error(`[rebuild-tokens] Error id=${item.id}:`, err);
        }
        processed++;
      }

      send({ processed, updated, total, dictVersion: currentVersion });
      lastId = batch[batch.length - 1]!.id;
      // Small yield between batches to avoid starving the event loop
      await new Promise((r) => setTimeout(r, 50));
    }

    console.log(`[rebuild-tokens] Done – processed=${processed} updated=${updated} dictV=${currentVersion}`);
    send({ done: true, processed, updated, total, dictVersion: currentVersion });
    res.end();
  } catch (err) {
    console.error("[rebuild-tokens] Fatal error:", err);
    try { res.write(`data: ${JSON.stringify({ error: String(err) })}\n\n`); res.end(); } catch { /* already closed */ }
  }
});

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

// ── GET /inventory/:id ────────────────────────────────────────────────────────
// Fetch a single inventory item by ID, including series_name when the item
// belongs to a named product series.
router.get("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params["id"] ?? "0");
    if (!Number.isFinite(id) || id <= 0) {
      return void res.status(400).json({ error: "id must be a positive integer" });
    }

    const [item] = await db
      .select()
      .from(inventoryTable)
      .where(eq(inventoryTable.id, id))
      .limit(1);

    if (!item) return void res.status(404).json({ error: "Item not found" });

    // Resolve vendor full name and series name in parallel
    const [vendorFullName, seriesRow] = await Promise.all([
      lookupVendorFullName(item.vendor),
      item.seriesId != null
        ? db
            .select({ name: productSeriesTable.name })
            .from(productSeriesTable)
            .where(eq(productSeriesTable.id, item.seriesId))
            .limit(1)
            .then(rows => rows[0] ?? null)
        : Promise.resolve(null),
    ]);

    const vendorMap = new Map(vendorFullName ? [[item.vendor.toUpperCase(), vendorFullName]] : []);
    res.json({
      ...withVendorFullName(item, vendorMap),
      binLocations: item.binLocations ?? [],
      aiKeywords: item.aiKeywords ?? [],
      seriesName: seriesRow?.name ?? null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch inventory item" });
  }
});

// ── PATCH /inventory/:id/series ───────────────────────────────────────────────
// Admin-only. Assigns or clears the series_id for one inventory item.
// Body: { seriesId: number | null }
// Returns: { ok: true, seriesName: string | null }
router.patch("/:id/series", requireAdminAuth, async (req, res) => {
  try {
    const id = parseInt(String(req.params["id"] ?? "0"));
    if (!Number.isFinite(id) || id <= 0) {
      return void res.status(400).json({ error: "id must be a positive integer" });
    }
    const body = req.body as { seriesId?: unknown };
    if (!Object.prototype.hasOwnProperty.call(body, "seriesId")) {
      return void res.status(400).json({ error: "seriesId is required" });
    }
    const raw = body.seriesId;
    if (raw !== null && (typeof raw !== "number" || !Number.isFinite(raw))) {
      return void res.status(400).json({ error: "seriesId must be a finite number or null" });
    }
    const seriesId = raw as number | null;

    let seriesName: string | null = null;
    if (seriesId !== null) {
      const [series] = await db
        .select({ name: productSeriesTable.name })
        .from(productSeriesTable)
        .where(eq(productSeriesTable.id, seriesId))
        .limit(1);
      if (!series) return void res.status(404).json({ error: "Series not found" });
      seriesName = series.name;
    }

    const [updated] = await db
      .update(inventoryTable)
      .set({ seriesId, updatedAt: new Date() })
      .where(eq(inventoryTable.id, id))
      .returning({ id: inventoryTable.id });
    if (!updated) return void res.status(404).json({ error: "Item not found" });

    res.json({ ok: true, seriesName });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update series assignment" });
  }
});

// ── PATCH /inventory/:id ──────────────────────────────────────────────────────
// Partial update for an inventory item. Only the fields present in the
// request body are touched.
//   • vendor:       string        → update vendor code (trimmed, uppercased)
//   • catalog:      string        → update catalog number (trimmed)
//   • description:  string        → set to that string (blank string is a real
//                                   edit — the worker explicitly cleared it)
//   • description: undefined/missing → leave description unchanged
//   • keywords:    string[]       → replace ai_keywords
//   • keywords:    undefined/missing → leave ai_keywords unchanged
// At least one field must be supplied.
router.patch("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params["id"] ?? "0");
    if (!Number.isFinite(id) || id <= 0) {
      return void res.status(400).json({ error: "id must be a positive integer" });
    }

    const body = (req.body ?? {}) as {
      vendor?: unknown;
      catalog?: unknown;
      description?: unknown;
      keywords?: unknown;
      tradeSize?: unknown;
      binLocations?: unknown;
    };
    const hasVendor = Object.prototype.hasOwnProperty.call(body, "vendor");
    const hasCatalog = Object.prototype.hasOwnProperty.call(body, "catalog");
    const hasDescription = Object.prototype.hasOwnProperty.call(body, "description");
    const hasKeywords = Object.prototype.hasOwnProperty.call(body, "keywords");
    const hasTradeSize = Object.prototype.hasOwnProperty.call(body, "tradeSize");
    const hasBinLocations = Object.prototype.hasOwnProperty.call(body, "binLocations");

    if (!hasVendor && !hasCatalog && !hasDescription && !hasKeywords && !hasTradeSize && !hasBinLocations) {
      return void res.status(400).json({
        error: "Provide at least one of `vendor`, `catalog`, `description`, `keywords`, `tradeSize`, or `binLocations` to update.",
      });
    }

    const updates: Partial<typeof inventoryTable.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (hasVendor) {
      if (typeof body.vendor !== "string" || !body.vendor.trim()) {
        return void res.status(400).json({ error: "vendor must be a non-empty string" });
      }
      updates.vendor = body.vendor.trim().toUpperCase();
    }

    if (hasCatalog) {
      if (typeof body.catalog !== "string" || !body.catalog.trim()) {
        return void res.status(400).json({ error: "catalog must be a non-empty string" });
      }
      updates.catalog = body.catalog.trim();
    }

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
