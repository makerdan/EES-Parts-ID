import { Router } from "express";
import { eq, sql, ilike, or, and, desc } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  inventoryTable,
  inventoryFtsVector,
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
import { logger } from "../lib/logger";
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
import { getAiClient, getEnrichModel, getDimensionsModel } from "../lib/aiProvider";
import { invalidateReferenceAnswerCache } from "../lib/answerCache";
import { uploadCatalogImage } from "../lib/objectStorage";
import { resizeImages } from "../utils/imageResize";
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

    const minLength   = req.query["minLength"]   != null ? parseFloat(req.query["minLength"]   as string) : null;
    const maxLength   = req.query["maxLength"]   != null ? parseFloat(req.query["maxLength"]   as string) : null;
    const minWidth    = req.query["minWidth"]    != null ? parseFloat(req.query["minWidth"]    as string) : null;
    const maxWidth    = req.query["maxWidth"]    != null ? parseFloat(req.query["maxWidth"]    as string) : null;
    const minHeight   = req.query["minHeight"]   != null ? parseFloat(req.query["minHeight"]   as string) : null;
    const maxHeight   = req.query["maxHeight"]   != null ? parseFloat(req.query["maxHeight"]   as string) : null;
    const minDiameter = req.query["minDiameter"] != null ? parseFloat(req.query["minDiameter"] as string) : null;
    const maxDiameter = req.query["maxDiameter"] != null ? parseFloat(req.query["maxDiameter"] as string) : null;

    const binPrefix = typeof req.query["binPrefix"] === "string" && req.query["binPrefix"].trim()
      ? req.query["binPrefix"].trim()
      : null;

    // Build optional dimension WHERE conditions using the same expression pattern
    // as the indexed columns so Postgres can use the expression indexes.
    const dimConditions = and(
      ...[
        minLength   != null && !isNaN(minLength)   ? sql`(dimensions->>'length')::numeric   >= ${minLength}`   : undefined,
        maxLength   != null && !isNaN(maxLength)   ? sql`(dimensions->>'length')::numeric   <= ${maxLength}`   : undefined,
        minWidth    != null && !isNaN(minWidth)    ? sql`(dimensions->>'width')::numeric    >= ${minWidth}`    : undefined,
        maxWidth    != null && !isNaN(maxWidth)    ? sql`(dimensions->>'width')::numeric    <= ${maxWidth}`    : undefined,
        minHeight   != null && !isNaN(minHeight)   ? sql`(dimensions->>'height')::numeric   >= ${minHeight}`   : undefined,
        maxHeight   != null && !isNaN(maxHeight)   ? sql`(dimensions->>'height')::numeric   <= ${maxHeight}`   : undefined,
        minDiameter != null && !isNaN(minDiameter) ? sql`(dimensions->>'diameter')::numeric >= ${minDiameter}` : undefined,
        maxDiameter != null && !isNaN(maxDiameter) ? sql`(dimensions->>'diameter')::numeric <= ${maxDiameter}` : undefined,
        // Bin-prefix filter: match any row whose bin_locations array contains at
        // least one entry starting with the given prefix (case-insensitive).
        //
        // immutable_array_to_string() is an IMMUTABLE wrapper around
        // array_to_string(arr, sep) — required because PostgreSQL only allows
        // IMMUTABLE functions in index expressions. The trigram GIN index
        // idx_inventory_bin_locs_prefix_trgm is defined on this same expression,
        // so queries must use the wrapper function to get the index scan.
        // Two ILIKE branches cover all positions in the array:
        //   - First element:  string starts with prefix (no leading wildcard)
        //   - Later elements: string contains '\n' + prefix (leading wildcard, but
        //     pg_trgm can still use trigrams when the prefix is ≥3 chars)
        binPrefix != null
          ? sql`(
              immutable_array_to_string(${inventoryTable.binLocations}, E'\n') ILIKE ${binPrefix + '%'}
              OR immutable_array_to_string(${inventoryTable.binLocations}, E'\n') ILIKE ${'%\n' + binPrefix + '%'}
            )`
          : undefined,
      ].filter((c): c is NonNullable<typeof c> => c !== undefined),
    );

    const [items, countResult] = await Promise.all([
      db.select().from(inventoryTable)
        .where(dimConditions)
        .limit(limit).offset(offset)
        .orderBy(inventoryTable.vendor, inventoryTable.catalog),
      db.select({ count: sql<number>`count(*)` }).from(inventoryTable).where(dimConditions),
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
      minLength,
      maxLength,
      minWidth,
      maxWidth,
      minHeight,
      maxHeight,
      minDiameter,
      maxDiameter,
      includeNullDimensions = true,
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
      minLength?: number | null;
      maxLength?: number | null;
      minWidth?: number | null;
      maxWidth?: number | null;
      minHeight?: number | null;
      maxHeight?: number | null;
      minDiameter?: number | null;
      maxDiameter?: number | null;
      includeNullDimensions?: boolean;
    };

    // Normalize length bounds — body takes precedence; fall back to query string so
    // callers can pass ?minLength=30&maxLength=60 on the URL as well.
    const _minRaw = minLength ?? (req.query["minLength"] != null ? parseFloat(req.query["minLength"] as string) : null);
    const _maxRaw = maxLength ?? (req.query["maxLength"] != null ? parseFloat(req.query["maxLength"] as string) : null);
    const lenMin: number | null = (_minRaw != null && !isNaN(Number(_minRaw))) ? Number(_minRaw) : null;
    const lenMax: number | null = (_maxRaw != null && !isNaN(Number(_maxRaw))) ? Number(_maxRaw) : null;

    // Normalize width bounds the same way.
    const _widMinRaw = minWidth ?? (req.query["minWidth"] != null ? parseFloat(req.query["minWidth"] as string) : null);
    const _widMaxRaw = maxWidth ?? (req.query["maxWidth"] != null ? parseFloat(req.query["maxWidth"] as string) : null);
    const widMin: number | null = (_widMinRaw != null && !isNaN(Number(_widMinRaw))) ? Number(_widMinRaw) : null;
    const widMax: number | null = (_widMaxRaw != null && !isNaN(Number(_widMaxRaw))) ? Number(_widMaxRaw) : null;

    // Normalize height bounds the same way.
    const _hgtMinRaw = minHeight ?? (req.query["minHeight"] != null ? parseFloat(req.query["minHeight"] as string) : null);
    const _hgtMaxRaw = maxHeight ?? (req.query["maxHeight"] != null ? parseFloat(req.query["maxHeight"] as string) : null);
    const hgtMin: number | null = (_hgtMinRaw != null && !isNaN(Number(_hgtMinRaw))) ? Number(_hgtMinRaw) : null;
    const hgtMax: number | null = (_hgtMaxRaw != null && !isNaN(Number(_hgtMaxRaw))) ? Number(_hgtMaxRaw) : null;

    // Normalize diameter bounds the same way.
    const _diaMinRaw = minDiameter ?? (req.query["minDiameter"] != null ? parseFloat(req.query["minDiameter"] as string) : null);
    const _diaMaxRaw = maxDiameter ?? (req.query["maxDiameter"] != null ? parseFloat(req.query["maxDiameter"] as string) : null);
    const diaMin: number | null = (_diaMinRaw != null && !isNaN(Number(_diaMinRaw))) ? Number(_diaMinRaw) : null;
    const diaMax: number | null = (_diaMaxRaw != null && !isNaN(Number(_diaMaxRaw))) ? Number(_diaMaxRaw) : null;

    // Reusable helper: builds the SQL fragment that uses the expression index on
    // ((dimensions->>'length')::numeric). Returns sql`` (no-op) when no bound is set.
    const buildLengthClause = (alias: "i" | "" = "i") => {
      const col = alias ? sql`(${sql.raw(alias)}.dimensions->>'length')::numeric` : sql`(dimensions->>'length')::numeric`;
      if (lenMin !== null && lenMax !== null) return sql`AND ${col} BETWEEN ${lenMin} AND ${lenMax}`;
      if (lenMin !== null) return sql`AND ${col} >= ${lenMin}`;
      if (lenMax !== null) return sql`AND ${col} <= ${lenMax}`;
      return sql``;
    };

    // Reusable helper: builds the SQL fragment for width bounds.
    const buildWidthClause = (alias: "i" | "" = "i") => {
      const col = alias ? sql`(${sql.raw(alias)}.dimensions->>'width')::numeric` : sql`(dimensions->>'width')::numeric`;
      if (widMin !== null && widMax !== null) return sql`AND ${col} BETWEEN ${widMin} AND ${widMax}`;
      if (widMin !== null) return sql`AND ${col} >= ${widMin}`;
      if (widMax !== null) return sql`AND ${col} <= ${widMax}`;
      return sql``;
    };

    // Reusable helper: builds the SQL fragment for height bounds.
    const buildHeightClause = (alias: "i" | "" = "i") => {
      const col = alias ? sql`(${sql.raw(alias)}.dimensions->>'height')::numeric` : sql`(dimensions->>'height')::numeric`;
      if (hgtMin !== null && hgtMax !== null) return sql`AND ${col} BETWEEN ${hgtMin} AND ${hgtMax}`;
      if (hgtMin !== null) return sql`AND ${col} >= ${hgtMin}`;
      if (hgtMax !== null) return sql`AND ${col} <= ${hgtMax}`;
      return sql``;
    };

    // Reusable helper: builds the SQL fragment for diameter bounds.
    const buildDiameterClause = (alias: "i" | "" = "i") => {
      const col = alias ? sql`(${sql.raw(alias)}.dimensions->>'diameter')::numeric` : sql`(dimensions->>'diameter')::numeric`;
      if (diaMin !== null && diaMax !== null) return sql`AND ${col} BETWEEN ${diaMin} AND ${diaMax}`;
      if (diaMin !== null) return sql`AND ${col} >= ${diaMin}`;
      if (diaMax !== null) return sql`AND ${col} <= ${diaMax}`;
      return sql``;
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

    // Build reverse map with primary vendors last so they overwrite extended
    // entries on name conflicts — authoritative 68 always win.
    const reverseVendorMap = new Map<string, string>();
    const extendedVendors = vendors.filter(v => !v.isPrimary);
    const primaryVendors = vendors.filter(v => v.isPrimary);
    for (const v of extendedVendors) {
      for (const name of v.names) reverseVendorMap.set(name.toLowerCase(), v.code);
    }
    for (const v of primaryVendors) {
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
    const catSqlRegex = (!isCategoryUncategorized && categoryKeywords.length > 0)
      ? categoryKeywords.map(escapeRegex).join("|")
      : null;

    const hasSizeFilter = lenMin !== null || lenMax !== null || widMin !== null || widMax !== null || hgtMin !== null || hgtMax !== null || diaMin !== null || diaMax !== null;

    if (!allSearchText.trim() && !categorySlug && !hasSizeFilter) {
      return void res.json({ results: [], totalMatches: 0, belowThreshold: 0 });
    }

    // Dedicated path: non-uncategorized category browse with no text query.
    // Returns every item whose chip text matches the node's keyword union via
    // a SQL-literal regex so the GIN trigram index can be used.
    // Length-range and diameter-range filters (if any) are pushed into SQL.
    if (categorySlug && !isCategoryUncategorized && catSqlRegex && !allSearchText.trim()) {
      const catLengthClause = buildLengthClause("");
      const catWidthClause = buildWidthClause("");
      const catHeightClause = buildHeightClause("");
      const catDiameterClause = buildDiameterClause("");
      const catHasLenFilter = lenMin !== null || lenMax !== null;
      const catHasDiaFilter = diaMin !== null || diaMax !== null;
      const catItems = await db
        .select()
        .from(inventoryTable)
        .where(sql`inventory_chip_text(vendor, catalog, description, ai_keywords) ~* ${catSqlRegex} ${catLengthClause} ${catWidthClause} ${catHeightClause} ${catDiameterClause}`)
        .orderBy(inventoryTable.vendor, inventoryTable.catalog)
        .limit(200);

      // When a size filter is active and the caller opted in, also collect category items with no relevant dimension data.
      let catSizeUnknownItems: typeof inventoryTable.$inferSelect[] = [];
      if (hasSizeFilter && includeNullDimensions) {
        const catNullDimWhere = catHasLenFilter && catHasDiaFilter
          ? sql`inventory_chip_text(vendor, catalog, description, ai_keywords) ~* ${catSqlRegex} AND (dimensions->>'length') IS NULL AND (dimensions->>'diameter') IS NULL`
          : catHasLenFilter
            ? sql`inventory_chip_text(vendor, catalog, description, ai_keywords) ~* ${catSqlRegex} AND (dimensions->>'length') IS NULL`
            : sql`inventory_chip_text(vendor, catalog, description, ai_keywords) ~* ${catSqlRegex} AND (dimensions->>'diameter') IS NULL`;
        catSizeUnknownItems = await db
          .select()
          .from(inventoryTable)
          .where(catNullDimWhere)
          .orderBy(inventoryTable.vendor, inventoryTable.catalog)
          .limit(200);
      }

      const toResult = (item: typeof inventoryTable.$inferSelect, matchReason: string) => ({
        item,
        confidence: 1.0,
        matchReason,
        seriesBase: getSeriesBase(item.vendor, item.catalog, item.description)?.key ?? null,
        seriesLabel: getSeriesBase(item.vendor, item.catalog, item.description)?.label ?? null,
        variants: [],
      });
      return void res.json({
        results: catItems.map(item => toResult(item, "category browse")),
        totalMatches: catItems.length + catSizeUnknownItems.length,
        belowThreshold: 0,
        sizeUnknownResults: catSizeUnknownItems.map(item => toResult(item, "category browse")),
        sizeUnknownCount: catSizeUnknownItems.length,
      });
    }

    // Special path: uncategorized browse with no search text — return all items that
    // don't match any taxonomy keyword (same inverse-regex logic as the post-filter).
    if (isCategoryUncategorized && !allSearchText.trim()) {
      // Push size bounds into SQL so only matching rows are fetched before
      // the JS-side inverse-taxonomy exclusion runs.
      const uncatHasLenFilter = lenMin !== null || lenMax !== null;
      const uncatHasDiaFilter = diaMin !== null || diaMax !== null;
      const uncatSizeConditions = [
        lenMin !== null ? sql`(dimensions->>'length')::numeric >= ${lenMin}` : undefined,
        lenMax !== null ? sql`(dimensions->>'length')::numeric <= ${lenMax}` : undefined,
        widMin !== null ? sql`(dimensions->>'width')::numeric >= ${widMin}` : undefined,
        widMax !== null ? sql`(dimensions->>'width')::numeric <= ${widMax}` : undefined,
        hgtMin !== null ? sql`(dimensions->>'height')::numeric >= ${hgtMin}` : undefined,
        hgtMax !== null ? sql`(dimensions->>'height')::numeric <= ${hgtMax}` : undefined,
        diaMin !== null ? sql`(dimensions->>'diameter')::numeric >= ${diaMin}` : undefined,
        diaMax !== null ? sql`(dimensions->>'diameter')::numeric <= ${diaMax}` : undefined,
      ].filter((c): c is NonNullable<typeof c> => c !== undefined);
      const uncatSizeWhere = uncatSizeConditions.length > 0 ? and(...uncatSizeConditions) : undefined;
      const allItems = await db.select().from(inventoryTable).where(uncatSizeWhere);
      const allTaxKws = getAllTaxonomyKeywords(TAXONOMY);
      const uncatItems = allItems.filter(item => {
        const text = itemFullText(item);
        if (allTaxKws.some(kw => text.includes(kw))) return false;
        return true;
      });

      // When a size filter is active and the caller opted in, also fetch uncategorized items with no relevant dimension.
      let uncatSizeUnknownItems: typeof inventoryTable.$inferSelect[] = [];
      if (hasSizeFilter && includeNullDimensions) {
        const nullDimConditions = [
          uncatHasLenFilter ? sql`(dimensions->>'length') IS NULL` : undefined,
          uncatHasDiaFilter ? sql`(dimensions->>'diameter') IS NULL` : undefined,
        ].filter((c): c is NonNullable<typeof c> => c !== undefined);
        // Items must be missing ALL of the filtered dimensions (not just one)
        const nullDimWhere = nullDimConditions.length > 1
          ? and(...nullDimConditions)
          : nullDimConditions[0];
        const allNullDimItems = nullDimWhere
          ? await db.select().from(inventoryTable).where(nullDimWhere)
          : [];
        uncatSizeUnknownItems = allNullDimItems.filter(item => {
          const text = itemFullText(item);
          return !allTaxKws.some(kw => text.includes(kw));
        });
      }

      const toUncatResult = (item: typeof inventoryTable.$inferSelect) => ({
        item,
        confidence: 1.0,
        matchReason: "uncategorized browse",
        seriesBase: getSeriesBase(item.vendor, item.catalog, item.description)?.key ?? null,
        seriesLabel: getSeriesBase(item.vendor, item.catalog, item.description)?.label ?? null,
        variants: [],
      });
      return void res.json({
        results: uncatItems.map(toUncatResult),
        totalMatches: uncatItems.length + uncatSizeUnknownItems.length,
        belowThreshold: 0,
        sizeUnknownResults: uncatSizeUnknownItems.map(toUncatResult),
        sizeUnknownCount: uncatSizeUnknownItems.length,
      });
    }

    // Dedicated path: size-range filter with no text query and no category.
    // Scans the table using the expression indexes on length and/or diameter.
    if (hasSizeFilter && !allSearchText.trim() && !categorySlug) {
      const sizeOnlyLengthClause = buildLengthClause("");
      const sizeOnlyWidthClause = buildWidthClause("");
      const sizeOnlyHeightClause = buildHeightClause("");
      const sizeOnlyDiameterClause = buildDiameterClause("");
      const hasLenFilter = lenMin !== null || lenMax !== null;
      const hasWidFilter = widMin !== null || widMax !== null;
      const hasHgtFilter = hgtMin !== null || hgtMax !== null;
      const hasDiaFilter = diaMin !== null || diaMax !== null;
      // Require the relevant dimension to be non-null so the expression index fires.
      const presenceParts: ReturnType<typeof sql>[] = [];
      if (hasLenFilter) presenceParts.push(sql`(dimensions->>'length')::numeric IS NOT NULL`);
      if (hasWidFilter) presenceParts.push(sql`(dimensions->>'width')::numeric IS NOT NULL`);
      if (hasHgtFilter) presenceParts.push(sql`(dimensions->>'height')::numeric IS NOT NULL`);
      if (hasDiaFilter) presenceParts.push(sql`(dimensions->>'diameter')::numeric IS NOT NULL`);
      const dimPresenceClause = presenceParts.length > 1
        ? sql`(${sql.join(presenceParts, sql` OR `)})`
        : presenceParts[0];
      const orderClause = hasLenFilter
        ? sql`ORDER BY (dimensions->>'length')::numeric ASC`
        : hasWidFilter
          ? sql`ORDER BY (dimensions->>'width')::numeric ASC`
          : hasHgtFilter
            ? sql`ORDER BY (dimensions->>'height')::numeric ASC`
            : sql`ORDER BY (dimensions->>'diameter')::numeric ASC`;

      // Null-dimension clause: items missing ALL of the filtered dimension(s)
      const nullDimParts: ReturnType<typeof sql>[] = [];
      if (hasLenFilter) nullDimParts.push(sql`(dimensions->>'length') IS NULL`);
      if (hasWidFilter) nullDimParts.push(sql`(dimensions->>'width') IS NULL`);
      if (hasHgtFilter) nullDimParts.push(sql`(dimensions->>'height') IS NULL`);
      if (hasDiaFilter) nullDimParts.push(sql`(dimensions->>'diameter') IS NULL`);
      const nullDimPresenceClause = nullDimParts.length > 1
        ? sql`(${sql.join(nullDimParts, sql` AND `)})`
        : nullDimParts[0];

      const [sizeItems, nullDimItems] = await Promise.all([
        db.execute(sql`
          SELECT * FROM inventory
          WHERE ${dimPresenceClause}
          ${sizeOnlyLengthClause}
          ${sizeOnlyWidthClause}
          ${sizeOnlyHeightClause}
          ${sizeOnlyDiameterClause}
          ${orderClause}
          LIMIT 200
        `),
        includeNullDimensions
          ? db.select().from(inventoryTable)
              .where(nullDimPresenceClause)
              .orderBy(inventoryTable.vendor, inventoryTable.catalog)
              .limit(200)
          : Promise.resolve([] as typeof inventoryTable.$inferSelect[]),
      ]);


      const sizeRows = (sizeItems as { rows: unknown[] }).rows as typeof inventoryTable.$inferSelect[];
      const toSizeResult = (item: typeof inventoryTable.$inferSelect, matchReason: string) => ({
        item,
        confidence: 1.0,
        matchReason,
        seriesBase: getSeriesBase((item as { vendor: string }).vendor, (item as { catalog: string }).catalog, (item as { description: string }).description)?.key ?? null,
        seriesLabel: getSeriesBase((item as { vendor: string }).vendor, (item as { catalog: string }).catalog, (item as { description: string }).description)?.label ?? null,
        variants: [],
      });
      return void res.json({
        results: sizeRows.map(item => toSizeResult(item, "size-range scan")),
        totalMatches: sizeRows.length + nullDimItems.length,
        belowThreshold: 0,
        // Dimension facet counts are not computed in the size-only path (no
        // FTS pipeline runs), so return an empty object to keep the response
        // shape consistent with the full-text search path.
        dimensionCounts: {},
        sizeUnknownResults: nullDimItems.map(item => toSizeResult(item, "size-range scan")),
        sizeUnknownCount: nullDimItems.length,
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
      enriched_at: Date | null; image_url: string | null; thumbnail_url: string | null; image_url_2: string | null; thumbnail_url_2: string | null;
      expanded_description: string | null;
      dimensions: { length?: number | null; width?: number | null; height?: number | null; diameter?: number | null } | null;
      created_at: Date; updated_at: Date;
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
          coalesce(i.expanded_description,'') || ' ' ||
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

        // Push length-range filter into SQL so the LIMIT 200 cap applies after
        // filtering, not before — mirrors the chip-filter pattern above.
        // When includeNullDimensions is true we also pass through rows with no
        // length value so they can be collected as sizeUnknown by the JS layer.
        const lengthSqlClause = (() => {
          const minVal = minLength != null && !isNaN(Number(minLength)) ? Number(minLength) : null;
          const maxVal = maxLength != null && !isNaN(Number(maxLength)) ? Number(maxLength) : null;
          if (minVal == null && maxVal == null) return sql``;
          const parts = [];
          if (minVal != null) parts.push(sql`(i.dimensions->>'length')::numeric >= ${minVal}`);
          if (maxVal != null) parts.push(sql`(i.dimensions->>'length')::numeric <= ${maxVal}`);
          if (includeNullDimensions) {
            return sql`AND ((i.dimensions->>'length') IS NULL OR ((i.dimensions->>'length') IS NOT NULL AND ${sql.join(parts, sql` AND `)}))`;
          }
          return sql`AND (i.dimensions->>'length') IS NOT NULL AND ${sql.join(parts, sql` AND `)}`;
        })();

        // Push width-range filter into SQL so it hits the expression index
        // added in migration 0011: (dimensions->>'width')::numeric
        const widthSqlClause = (() => {
          if (widMin == null && widMax == null) return sql``;
          const parts = [];
          if (widMin != null) parts.push(sql`(i.dimensions->>'width')::numeric >= ${widMin}`);
          if (widMax != null) parts.push(sql`(i.dimensions->>'width')::numeric <= ${widMax}`);
          if (includeNullDimensions) {
            return sql`AND ((i.dimensions->>'width') IS NULL OR ((i.dimensions->>'width') IS NOT NULL AND ${sql.join(parts, sql` AND `)}))`;
          }
          return sql`AND (i.dimensions->>'width') IS NOT NULL AND ${sql.join(parts, sql` AND `)}`;
        })();

        // Push height-range filter into SQL so it hits the expression index
        // added in migration 0011: (dimensions->>'height')::numeric
        const heightSqlClause = (() => {
          if (hgtMin == null && hgtMax == null) return sql``;
          const parts = [];
          if (hgtMin != null) parts.push(sql`(i.dimensions->>'height')::numeric >= ${hgtMin}`);
          if (hgtMax != null) parts.push(sql`(i.dimensions->>'height')::numeric <= ${hgtMax}`);
          if (includeNullDimensions) {
            return sql`AND ((i.dimensions->>'height') IS NULL OR ((i.dimensions->>'height') IS NOT NULL AND ${sql.join(parts, sql` AND `)}))`;
          }
          return sql`AND (i.dimensions->>'height') IS NOT NULL AND ${sql.join(parts, sql` AND `)}`;
        })();

        // Push diameter-range filter into SQL so it hits the expression index
        // added in migration 0010: (dimensions->>'diameter')::numeric
        const diameterSqlClause = (() => {
          const minVal = minDiameter != null && !isNaN(Number(minDiameter)) ? Number(minDiameter) : null;
          const maxVal = maxDiameter != null && !isNaN(Number(maxDiameter)) ? Number(maxDiameter) : null;
          if (minVal == null && maxVal == null) return sql``;
          const parts = [];
          if (minVal != null) parts.push(sql`(i.dimensions->>'diameter')::numeric >= ${minVal}`);
          if (maxVal != null) parts.push(sql`(i.dimensions->>'diameter')::numeric <= ${maxVal}`);
          if (includeNullDimensions) {
            return sql`AND ((i.dimensions->>'diameter') IS NULL OR ((i.dimensions->>'diameter') IS NOT NULL AND ${sql.join(parts, sql` AND `)}))`;
          }
          return sql`AND (i.dimensions->>'diameter') IS NOT NULL AND ${sql.join(parts, sql` AND `)}`;
        })();

        // Wrap in a subquery so ORDER BY can reference the computed column aliases.
        // PostgreSQL only resolves aliases in ORDER BY when used as direct references
        // (not inside arithmetic expressions like fts_rank * 0.6 + trgm_sim * 0.4).
        const pgQueryResult = await db.execute(sql`
          SELECT * FROM (
            SELECT
              i.id, i.vendor, i.catalog, i.description,
              i.bin_locations, i.ai_keywords, i.barcodes, i.enriched_at, i.image_url, i.thumbnail_url, i.image_url_2, i.thumbnail_url_2, i.expanded_description, i.dimensions, i.created_at, i.updated_at,
              ${tsQuery.trim() ? sql`ts_rank_cd(
                ${inventoryFtsVector('i')},
                websearch_to_tsquery('english', ${tsQuery})
              )` : sql`0`} AS fts_rank,
              greatest(
                similarity(i.catalog, ${catalogTrgmTerms}),
                similarity(i.description, ${allTermsArr.slice(0,5).join(" ")})
              ) AS trgm_sim
            FROM inventory i
            WHERE (
              ${tsQuery.trim() ? sql`${inventoryFtsVector('i')} @@ websearch_to_tsquery('english', ${tsQuery})
              OR` : sql``}
              similarity(i.catalog, ${catalogTrgmTerms}) > 0.1
              OR similarity(i.description, ${allTermsArr.slice(0,5).join(" ")}) > 0.1
              ${kwLike ? sql`OR i.catalog ILIKE ${kwLike}` : sql``}
              ${vendorFilter ? sql`OR upper(i.vendor) = ${vendorFilter}` : sql``}
            )
            ${chipClauses}
            ${catClause}
            ${lengthSqlClause}
            ${widthSqlClause}
            ${heightSqlClause}
            ${diameterSqlClause}
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
        // PDF catalog enrichment columns — image_url and thumbnail_url are included in the SELECT
        imageUrl: typeof row.image_url === "string" ? row.image_url : null,
        thumbnailUrl: typeof row.thumbnail_url === "string" ? row.thumbnail_url : null,
        imageUrl2: typeof row.image_url_2 === "string" ? row.image_url_2 : null,
        thumbnailUrl2: typeof row.thumbnail_url_2 === "string" ? row.thumbnail_url_2 : null,
        expandedDescription: typeof row.expanded_description === "string" ? row.expanded_description : null,
        imageSource: null,
        imageConfidence: null,
        previousDescription: null,
        catalogPdfJobId: null,
        dimensions: row.dimensions ?? null,
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

    // ── Apply dimensions size-range filter ───────────────────────────────────
    // Items that HAVE the relevant dimension and fall in range pass.
    // Items that are missing the relevant dimension are collected as "size unknown"
    // (they were never measured, not out-of-range) and included as a trailing group.
    // Items that have data but fall outside the range are silently excluded.
    // If neither bound is provided the filter is a no-op.
    const hasLengthFilter = (minLength != null && !isNaN(Number(minLength))) ||
                            (maxLength != null && !isNaN(Number(maxLength)));
    const sizeUnknownSet = new Map<number, (typeof chipFiltered)[0]>();
    const lengthFiltered = hasLengthFilter
      ? chipFiltered.filter(r => {
          const dimLen = r.item.dimensions?.length ?? null;
          if (dimLen == null) {
            if (includeNullDimensions) sizeUnknownSet.set(r.item.id, r);
            return false;
          }
          if (lenMin !== null && dimLen < lenMin) return false;
          if (lenMax !== null && dimLen > lenMax) return false;
          return true;
        })
      : chipFiltered;

    // ── Apply diameter-range filter ───────────────────────────────────────────
    // Mirrors the length filter above; uses the (dimensions->>'diameter')::numeric
    // expression index added in migration 0010 at the DB level.
    // If neither bound is provided the filter is a no-op.
    const hasDiameterFilter = (minDiameter != null && !isNaN(Number(minDiameter))) ||
                              (maxDiameter != null && !isNaN(Number(maxDiameter)));
    const dimFiltered = hasDiameterFilter
      ? lengthFiltered.filter(r => {
          const dims = (r.item as unknown as { dimensions?: { diameter?: number | null } | null }).dimensions;
          if (!dims || dims.diameter == null) {
            if (includeNullDimensions && !sizeUnknownSet.has(r.item.id)) sizeUnknownSet.set(r.item.id, r);
            return false;
          }
          const dia = dims.diameter;
          if (minDiameter != null && !isNaN(Number(minDiameter)) && dia < Number(minDiameter)) return false;
          if (maxDiameter != null && !isNaN(Number(maxDiameter)) && dia > Number(maxDiameter)) return false;
          return true;
        })
      : lengthFiltered;

    const sizeUnknownItems = Array.from(sizeUnknownSet.values());

    // Group into series + find variants
    const seriesGroups = new Map<string, { label: string; items: typeof inventoryTable.$inferSelect[] }>();
    for (const r of dimFiltered) {
      const series = getSeriesBase(r.item.vendor, r.item.catalog, r.item.description);
      if (series) {
        const existing = seriesGroups.get(series.key) ?? { label: series.label, items: [] };
        existing.items.push(r.item);
        seriesGroups.set(series.key, existing);
      }
    }

    const variantMap = new Map<number, typeof inventoryTable.$inferSelect[]>();
    const resultIds = new Set(dimFiltered.map(r => r.item.id));

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
    const aboveThreshold = dimFiltered.filter(r => r.confidence >= thresholdFraction);
    const belowCount = dimFiltered.length - aboveThreshold.length;

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

    const sizeUnknownResults = sizeUnknownItems.map(r => ({
      item: r.item,
      confidence: r.confidence,
      matchReason: r.reason,
      seriesBase: getSeriesBase(r.item.vendor, r.item.catalog, r.item.description)?.key ?? null,
      seriesLabel: getSeriesBase(r.item.vendor, r.item.catalog, r.item.description)?.label ?? null,
      variants: [],
    }));

    res.json({
      results: finalResults,
      totalMatches: dimFiltered.length + sizeUnknownItems.length,
      belowThreshold: belowCount,
      dimensionCounts,
      sizeUnknownResults,
      sizeUnknownCount: sizeUnknownItems.length,
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
    // Return the full existing item so callers can offer to update instead of
    // creating a duplicate (e.g. ShelfCatalogEntry duplicate-detection flow).
    const existing = await db
      .select()
      .from(inventoryTable)
      .where(and(eq(inventoryTable.vendor, upperVendor), eq(inventoryTable.catalog, trimmedCatalog)));

    if (existing.length > 0) {
      return void res.status(409).json({
        error: `Part already exists: ${upperVendor} / ${trimmedCatalog}`,
        existingItem: existing[0],
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

    invalidateReferenceAnswerCache().catch(() => {});
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

    invalidateReferenceAnswerCache().catch(() => {});

    // Refresh planner statistics after a bulk upsert so inventory_fts_idx
    // remains the chosen scan plan even when reltuples was stale before import.
    // Fire-and-forget: ANALYZE can take a few seconds on large tables and must
    // not block the HTTP response.
    db.execute(sql`ANALYZE inventory`).catch((err) => {
      logger.warn({ err }, "ANALYZE inventory failed after upsert-batch");
    });

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
    invalidateReferenceAnswerCache().catch(() => {});
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
  if (bulkEnrichJob.processed > 0) {
    invalidateReferenceAnswerCache().catch(() => {});
  }
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

// ── POST /inventory/expand-descriptions ──────────────────────────────────────
// SSE stream: calls OpenAI once per part and streams results.
// Does NOT write to the DB — the client saves each result individually via
// PATCH /:id/expanded-description once the admin approves the expansion.
router.post("/expand-descriptions", requireAdminAuth, async (_req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (obj: Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  try {
    const BATCH_SIZE = 50;

    const itemsToExpand = await db
      .select({
        id: inventoryTable.id,
        vendor: inventoryTable.vendor,
        catalog: inventoryTable.catalog,
        description: inventoryTable.description,
      })
      .from(inventoryTable)
      .where(sql`${inventoryTable.expandedDescription} IS NULL`)
      .limit(BATCH_SIZE);

    if (!itemsToExpand.length) {
      send({ model: getEnrichModel(), done: true, processed: 0, total: 0, remaining: 0 });
      res.end();
      return;
    }

    const total = itemsToExpand.length;
    let processed = 0;

    send({ model: getEnrichModel(), total });

    for (const item of itemsToExpand) {
      try {
        const response = await getAiClient().chat.completions.create({
          model: getEnrichModel(),
          max_completion_tokens: 300,
          messages: [
            {
              role: "system",
              content:
                "You are an electrical supplies identifier with a degree in English language specializing in keyword and abbreviation expansion. Convert a single catalog description line into one clear, inventory\u2011friendly sentence. Requirements:\n\n" +
                "Use imperial units where applicable (in., ft, lb, \u00b0F). Use the abbreviated unit forms shown (in., ft, lb, \u00b0F) and include numeric conversions only when specifically required (e.g., temperature rise show both \u00b0C and \u00b0F).\n" +
                "Fix spacing errors (ensure spaces after commas and between numbers and unit abbreviations where specified below).\n" +
                "Expand all abbreviations and jargon into plain language (examples: kVA \u2192 kilovolt\u2011ampere; XFMR \u2192 transformer; 3PH \u2192 three\u2011phase; V \u2192 volts; Y \u2192 wye; FPT/MPT \u2192 female/male pipe thread; AWG \u2192 American Wire Gauge; PHIL \u2192 Phillips; SLOT \u2192 slotted).\n" +
                "Preserve and mirror compact original shorthand variations where helpful: when an original uses compact shorthand like \u201827K\u2019, include that exact token followed immediately by the full numeric form without a space (e.g., \u201827K (2700K)\u2019). For color temperatures use both forms: short token (27K, 30K, 35K, 40K, 50K, etc.) and full form with no space (2700K, 3000K, 3500K, 4000K, 5000K).\n" +
                "Use these unit formats in the sentence: number + space + unit for general units (e.g., \u201812 W\u2019, \u20184 in.\u2019), but use compact no\u2011space format for color temperature numeric form (e.g., \u20182700K\u2019). When showing both short token and full form, write like: \u201827K (2700K)\u2019.\n" +
                "Include essential keywords present in the input where applicable: capacity/rating, phase, primary voltage, secondary voltage, connection (delta/wye), efficiency standard, temperature rise (report both \u00b0C and \u00b0F when temperature rise is provided), enclosure/venting, head type, thread size, length, material, mounting type, sensor or control features, and amperage/voltage ratings.\n" +
                "Do not invent unsupported technical specifications. If a required spec is missing and you must infer it to make the sentence meaningful, place the inference explicitly in parentheses and label it as an assumption (e.g., \u2018(assumed 150 \u00b0C temperature rise)\u2019).\n" +
                "Do not include meta commentary or phrases like \u2018inventory item\u2019 in the output.\n" +
                "Output exactly one concise sentence per single input line. Keep the sentence inventory\u2011friendly (short, keyword dense, and unambiguous).\n" +
                "If the input contains multiple items on one line, expand only the first item and request the user to separate lines for multiple expansions.\n\n" +
                "Examples\n\n" +
                "Input: 225KVA VENTD XFMR DOE2016 EFF 3PH 480-208Y/120 150\n" +
                "Output: 225 kVA ventilated three\u2011phase transformer, DOE 2016 efficiency compliant, primary 480 V, secondary 208Y/120 V, 302 \u00b0F (150 \u00b0C) temperature rise.\n" +
                "Input: 4\" 12W LED DISK LIGHT 27K/3K/35K/4K/5K W/MOT SENSR\n" +
                "Output: 4 in. diameter, 12 W LED disk light with selectable color temperatures 27K (2700K), 30K (3000K), 35K (3500K), 40K (4000K), or 50K (5000K) and a built\u2011in motion sensor.\n" +
                "Input: #8-32 X 1\" PHIL/SLOT RH MACHINE SCREW\n" +
                "Output: #8-32 \u00d7 1 in. combination Phillips/slotted head machine screw, right\u2011hand threads, 32 threads per inch (UNC coarse).",
            },
            {
              role: "user",
              content: `Vendor: ${item.vendor}\nCatalog: ${item.catalog}\nOriginal description: ${item.description}\n\nExpand this description:`,
            },
          ],
        });
        const expandedDescription =
          response.choices[0]?.message?.content?.trim() ?? item.description;
        processed++;
        send({
          id: item.id,
          partNumber: item.catalog,
          originalDescription: item.description,
          expandedDescription,
          progress: processed,
          total,
        });
      } catch (aiErr) {
        processed++;
        send({
          id: item.id,
          partNumber: item.catalog,
          originalDescription: item.description,
          expandedDescription: null,
          error: String(aiErr),
          progress: processed,
          total,
        });
      }
    }

    const [{ remaining }] = await db
      .select({ remaining: sql<number>`count(*)::int` })
      .from(inventoryTable)
      .where(sql`${inventoryTable.expandedDescription} IS NULL`);

    send({ done: true, processed, total, remaining });
    res.end();
  } catch (err) {
    console.error("[expand-descriptions]", err);
    send({ error: String(err) });
    res.end();
  }
});

// ── PATCH /inventory/:id/expanded-description ─────────────────────────────────
router.patch("/:id/expanded-description", requireAdminAuth, async (req, res) => {
  try {
    const id = parseInt(String(req.params["id"] ?? "0"), 10);
    if (!id || isNaN(id)) {
      return void res.status(400).json({ error: "Invalid item id" });
    }

    const { expandedDescription } = req.body as { expandedDescription: string | null };

    const [updated] = await db
      .update(inventoryTable)
      .set({ expandedDescription: expandedDescription ?? null, updatedAt: new Date() })
      .where(eq(inventoryTable.id, id))
      .returning({ id: inventoryTable.id });

    if (!updated) {
      return void res.status(404).json({ error: "Item not found" });
    }

    invalidateReferenceAnswerCache().catch(() => {});
    res.json({ success: true });
  } catch (err) {
    console.error("[expanded-description PATCH]", err);
    res.status(500).json({ error: "Failed to update expanded description" });
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
  if (measureEnrichJob.updated > 0) {
    invalidateReferenceAnswerCache().catch(() => {});
  }
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
    invalidateReferenceAnswerCache().catch(() => {});
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
    invalidateReferenceAnswerCache().catch(() => {});
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update keywords" });
  }
});

// ── PATCH /inventory/:id/photo ────────────────────────────────────────────────
// Accept a base64-encoded image from the mobile client, upload it to GCS via
// the existing object storage helper, and persist the resulting URL on the item.
// Used by the ShelfCatalogEntry rapid-entry flow.
router.patch("/:id/photo", requireAdminAuth, async (req, res) => {
  try {
    const id = parseInt(String(req.params["id"] ?? "0"));
    if (!id) return void res.status(400).json({ error: "Invalid item id" });

    const { imageBase64, mimeType, remove, slot = 1 } = req.body as {
      imageBase64?: string;
      mimeType?: string;
      remove?: boolean;
      slot?: 1 | 2;
    };

    const isSlot2 = slot === 2;

    if (remove === true) {
      const patch = isSlot2
        ? { imageUrl2: null, thumbnailUrl2: null, updatedAt: new Date() }
        : { imageUrl: null, thumbnailUrl: null, updatedAt: new Date() };
      const [updated] = await db
        .update(inventoryTable)
        .set(patch)
        .where(eq(inventoryTable.id, id))
        .returning();
      if (!updated) return void res.status(404).json({ error: "Item not found" });
      invalidateReferenceAnswerCache().catch(() => {});
      return void res.json({
        imageUrl: updated.imageUrl ?? null,
        thumbnailUrl: updated.thumbnailUrl ?? null,
        imageUrl2: updated.imageUrl2 ?? null,
        thumbnailUrl2: updated.thumbnailUrl2 ?? null,
      });
    }

    if (!imageBase64?.trim()) {
      return void res.status(400).json({ error: "imageBase64 is required" });
    }

    const rawBuffer = Buffer.from(imageBase64, "base64");
    const { fullBuffer, thumbnailBuffer } = await resizeImages(rawBuffer);

    const [uploadedUrl, uploadedThumbUrl] = await Promise.all([
      uploadCatalogImage(fullBuffer, "image/jpeg"),
      uploadCatalogImage(thumbnailBuffer, "image/jpeg"),
    ]);

    const patch = isSlot2
      ? { imageUrl2: uploadedUrl, thumbnailUrl2: uploadedThumbUrl, updatedAt: new Date() }
      : { imageUrl: uploadedUrl, thumbnailUrl: uploadedThumbUrl, updatedAt: new Date() };

    const [updated] = await db
      .update(inventoryTable)
      .set(patch)
      .where(eq(inventoryTable.id, id))
      .returning();

    if (!updated) return void res.status(404).json({ error: "Item not found" });
    invalidateReferenceAnswerCache().catch(() => {});
    res.json({
      imageUrl: updated.imageUrl ?? null,
      thumbnailUrl: updated.thumbnailUrl ?? null,
      imageUrl2: updated.imageUrl2 ?? null,
      thumbnailUrl2: updated.thumbnailUrl2 ?? null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to upload photo" });
  }
});

// ── PATCH /inventory/:id/dimensions ──────────────────────────────────────────
// Admin-only: save physical dimensions (length, width, height, diameter) in mm.
// Only fields present in the body are updated (partial merge); omitted fields
// are preserved from the existing value.  Pass null to clear a specific field.
router.patch("/:id/dimensions", requireAdminAuth, async (req, res) => {
  try {
    const id = parseInt(String(req.params["id"] ?? "0"));
    if (!id) return void res.status(400).json({ error: "Invalid item id" });

    const { length, width, height, diameter } = req.body as {
      length?: number | null;
      width?: number | null;
      height?: number | null;
      diameter?: number | null;
    };

    const isValidMm = (v: unknown) =>
      v == null || (typeof v === "number" && isFinite(v) && v >= 0 && v <= 100_000);

    if (!isValidMm(length) || !isValidMm(width) || !isValidMm(height) || !isValidMm(diameter)) {
      return void res.status(400).json({ error: "All dimension values must be non-negative numbers in mm (or null)" });
    }

    // Build only the fields that were explicitly provided so we can merge
    // them into the existing jsonb without dropping unrelated fields.
    const patch: Record<string, number | null> = {};
    if (length !== undefined) patch.length = length;
    if (width !== undefined) patch.width = width;
    if (height !== undefined) patch.height = height;
    if (diameter !== undefined) patch.diameter = diameter;

    // Use PostgreSQL jsonb || merge operator: existing fields not in patch are preserved.
    const [updated] = await db
      .update(inventoryTable)
      .set({
        dimensions: sql`COALESCE(${inventoryTable.dimensions}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(inventoryTable.id, id))
      .returning();

    if (!updated) return void res.status(404).json({ error: "Item not found" });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update dimensions" });
  }
});

// ── Rate limiter for the open estimate-dimensions/search endpoint ──────────────
// Dual-bucket strategy:
//
//   • Per-device bucket  (key = "device:<X-Device-ID>"):
//       Applied when the client supplies a valid X-Device-ID header.
//       Gives each install its own independent ESTIMATE_SEARCH_RATE_LIMIT
//       quota so that multiple devices behind the same NAT / corporate Wi-Fi
//       do not share a single pool.
//
//   • Per-IP bucket (key = "ip:<remoteIP>"):
//       Always applied.  Acts as an anti-abuse ceiling so that a bad actor
//       who rotates fake X-Device-ID values on every request cannot bypass
//       the limiter — their IP bucket fills up regardless.
//       When X-Device-ID is supplied, a higher ceiling
//       (ESTIMATE_SEARCH_IP_CEILING) is used so that a handful of legitimate
//       devices behind NAT can coexist comfortably.
//       When the header is absent the standard limit applies (original behaviour).
//
// Both buckets must pass for the request to proceed; either one over its
// limit yields a 429 with the same response shape as before.
//
// All three values are configurable via environment variables so operators can
// tune them without a code change or redeploy:
//   ESTIMATE_SEARCH_RATE_LIMIT  — max requests per window per device (default 10)
//   ESTIMATE_SEARCH_IP_CEILING  — max requests per window per IP when device IDs
//                                  are in use (default 50)
//   ESTIMATE_SEARCH_WINDOW_MS   — sliding window length in ms (default 60000)
function parsePositiveInt(raw: string | undefined, defaultValue: number, name: string): number {
  if (raw == null) return defaultValue;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn(
      { envVar: name, rawValue: raw, default: defaultValue },
      `Invalid value for ${name} — must be a positive integer; using default`,
    );
    return defaultValue;
  }
  return parsed;
}

const ESTIMATE_SEARCH_RATE_LIMIT: number = parsePositiveInt(
  process.env["ESTIMATE_SEARCH_RATE_LIMIT"],
  10,
  "ESTIMATE_SEARCH_RATE_LIMIT",
);
const ESTIMATE_SEARCH_IP_CEILING: number = parsePositiveInt(
  process.env["ESTIMATE_SEARCH_IP_CEILING"],
  50,
  "ESTIMATE_SEARCH_IP_CEILING",
);
const ESTIMATE_SEARCH_WINDOW_MS: number = parsePositiveInt(
  process.env["ESTIMATE_SEARCH_WINDOW_MS"],
  60_000,
  "ESTIMATE_SEARCH_WINDOW_MS",
);

logger.info(
  {
    ESTIMATE_SEARCH_RATE_LIMIT,
    ESTIMATE_SEARCH_IP_CEILING,
    ESTIMATE_SEARCH_WINDOW_MS,
  },
  "estimate-dimensions/search rate limit config",
);

const estimateSearchHits = new Map<string, number[]>();

// Evict map entries whose most-recent hit is older than the window, preventing
// unbounded growth when callers are not seen again (runs every 5 minutes).
setInterval(() => {
  const cutoff = Date.now() - ESTIMATE_SEARCH_WINDOW_MS;
  for (const [key, hits] of estimateSearchHits) {
    if (hits.length === 0 || hits[hits.length - 1] < cutoff) {
      estimateSearchHits.delete(key);
    }
  }
}, 5 * 60_000).unref();

function estimateSearchRateLimiter(
  req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction,
): void {
  // req.ip is resolved by Express using the trust-proxy setting configured in
  // app.ts (trust proxy = 1).  This correctly peels exactly one proxy hop from
  // X-Forwarded-For, so clients cannot spoof an arbitrary IP by injecting their
  // own X-Forwarded-For header.
  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
  const ipKey = `ip:${ip}`;

  // Defensively parse the header — Express may expose it as string[] when the
  // same header is sent multiple times.  Ignore the value in that case.
  const rawDeviceId = req.headers["x-device-id"];
  const deviceId =
    typeof rawDeviceId === "string" ? rawDeviceId.trim() || undefined : undefined;

  const now = Date.now();
  const windowStart = now - ESTIMATE_SEARCH_WINDOW_MS;

  // ── Per-device check (only when header is present) ──────────────────────────
  if (deviceId !== undefined) {
    const deviceKey  = `device:${deviceId}`;
    const deviceHits = (estimateSearchHits.get(deviceKey) ?? []).filter(
      (t) => t > windowStart,
    );
    if (deviceHits.length >= ESTIMATE_SEARCH_RATE_LIMIT) {
      res.status(429).json({
        error: `Rate limit exceeded — maximum ${ESTIMATE_SEARCH_RATE_LIMIT} requests per minute for dimension estimation.`,
      });
      return;
    }
    // Commit the device hit now; IP hit is committed below only if IP passes.
    deviceHits.push(now);
    estimateSearchHits.set(deviceKey, deviceHits);
  }

  // ── Per-IP check (always enforced) ──────────────────────────────────────────
  // Use the higher ceiling when device IDs are in play so legitimate devices
  // on a shared IP aren't collectively squeezed by the standard per-device limit.
  const ipLimit = deviceId !== undefined
    ? ESTIMATE_SEARCH_IP_CEILING
    : ESTIMATE_SEARCH_RATE_LIMIT;

  const ipHits = (estimateSearchHits.get(ipKey) ?? []).filter(
    (t) => t > windowStart,
  );
  if (ipHits.length >= ipLimit) {
    res.status(429).json({
      error: `Rate limit exceeded — maximum ${ESTIMATE_SEARCH_RATE_LIMIT} requests per minute for dimension estimation.`,
    });
    return;
  }

  ipHits.push(now);
  estimateSearchHits.set(ipKey, ipHits);
  next();
}

// ── POST /inventory/estimate-dimensions/search ────────────────────────────────
// Open to all users (no admin token required): accepts a photo and uses OpenAI
// Vision to estimate dimensions for search-mode use only (Measure-to-Search).
// Results are NOT persisted — the estimates are returned so the client can run
// a dimension-filter search.  Identical AI prompt to the admin endpoint.
router.post("/estimate-dimensions/search", estimateSearchRateLimiter, async (req, res) => {
  try {
    const { imageBase64, mimeType = "image/jpeg" } = req.body as {
      imageBase64: string;
      mimeType?: string;
    };

    if (!imageBase64 || typeof imageBase64 !== "string") {
      return void res.status(400).json({ error: "imageBase64 is required" });
    }

    if (imageBase64.length > 5_000_000) {
      return void res.status(413).json({ error: "Image too large — please use quality ≤ 0.5" });
    }

    const response = await getAiClient().chat.completions.create({
      model: getDimensionsModel(),
      max_completion_tokens: 256,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:${mimeType};base64,${imageBase64}`, detail: "low" },
            },
            {
              type: "text",
              text: `Look at this image of an electrical or mechanical part.
Estimate the part's physical dimensions in millimetres.
If you can see a common scale reference object in the frame, use its known dimensions to anchor your estimate. Reference sizes: US quarter ≈ 24.26 mm diameter; US dollar bill 156 × 66 mm; credit card 85.6 × 54 mm; standard 12-inch ruler 305 mm long.
Reply with ONLY a JSON object — no prose — in exactly this shape:
{"length":null,"width":null,"height":null,"diameter":null}
Use null for any value you cannot estimate with reasonable confidence.
"length" is the longest dimension; "width" and "height" are the other two;
"diameter" applies only to round/cylindrical parts.
All values must be positive numbers (mm) or null.`,
            },
          ],
        },
      ],
    });

    const raw = response.choices[0]?.message?.content?.trim() ?? "{}";

    let parsed: Record<string, unknown> = {};
    const start = raw.indexOf("{");
    if (start !== -1) {
      let depth = 0;
      let end = -1;
      for (let i = start; i < raw.length; i++) {
        if (raw[i] === "{") depth++;
        else if (raw[i] === "}") {
          depth--;
          if (depth === 0) { end = i; break; }
        }
      }
      if (end !== -1) {
        try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch { /* keep {} */ }
      }
    }

    const sanitize = (v: unknown): number | null => {
      const n = Number(v);
      return isFinite(n) && n > 0 && n <= 100_000 ? Math.round(n * 10) / 10 : null;
    };

    res.json({
      length: sanitize(parsed.length),
      width: sanitize(parsed.width),
      height: sanitize(parsed.height),
      diameter: sanitize(parsed.diameter),
    });
  } catch (err) {
    console.error("[estimate-dimensions/search]", err);
    res.status(500).json({ error: "Dimension estimation failed" });
  }
});

// ── POST /inventory/estimate-dimensions ───────────────────────────────────────
// Admin-only: accepts a base64-encoded JPEG/PNG photo of a part and uses
// OpenAI Vision to estimate its physical dimensions (length, width, height,
// diameter) in millimetres.  The admin confirms / adjusts values before saving.
router.post("/estimate-dimensions", requireAdminAuth, async (req, res) => {
  try {
    const { imageBase64, mimeType = "image/jpeg" } = req.body as {
      imageBase64: string;
      mimeType?: string;
    };

    if (!imageBase64 || typeof imageBase64 !== "string") {
      return void res.status(400).json({ error: "imageBase64 is required" });
    }

    // Sanity-check size (≈4 MB base64 ≈ 3 MB binary)
    if (imageBase64.length > 5_000_000) {
      return void res.status(413).json({ error: "Image too large — please use quality ≤ 0.5" });
    }

    const response = await getAiClient().chat.completions.create({
      model: getDimensionsModel(),
      max_completion_tokens: 256,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:${mimeType};base64,${imageBase64}`, detail: "low" },
            },
            {
              type: "text",
              text: `Look at this image of an electrical or mechanical part.
Estimate the part's physical dimensions in millimetres.
If you can see a common scale reference object in the frame, use its known dimensions to anchor your estimate. Reference sizes: US quarter ≈ 24.26 mm diameter; US dollar bill 156 × 66 mm; credit card 85.6 × 54 mm; standard 12-inch ruler 305 mm long.
Reply with ONLY a JSON object — no prose — in exactly this shape:
{"length":null,"width":null,"height":null,"diameter":null}
Use null for any value you cannot estimate with reasonable confidence.
"length" is the longest dimension; "width" and "height" are the other two;
"diameter" applies only to round/cylindrical parts.
All values must be positive numbers (mm) or null.`,
            },
          ],
        },
      ],
    });

    const raw = response.choices[0]?.message?.content?.trim() ?? "{}";

    // Extract the first balanced JSON object from the response.
    // The flat regex /\{[^}]*\}/ fails on nested braces, so we scan manually.
    let parsed: Record<string, unknown> = {};
    const start = raw.indexOf("{");
    if (start !== -1) {
      let depth = 0;
      let end = -1;
      for (let i = start; i < raw.length; i++) {
        if (raw[i] === "{") depth++;
        else if (raw[i] === "}") {
          depth--;
          if (depth === 0) { end = i; break; }
        }
      }
      if (end !== -1) {
        try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch { /* keep {} */ }
      }
    }

    const sanitize = (v: unknown): number | null => {
      const n = Number(v);
      return isFinite(n) && n > 0 && n <= 100_000 ? Math.round(n * 10) / 10 : null;
    };

    res.json({
      length: sanitize(parsed.length),
      width: sanitize(parsed.width),
      height: sanitize(parsed.height),
      diameter: sanitize(parsed.diameter),
    });
  } catch (err) {
    console.error("[estimate-dimensions]", err);
    res.status(500).json({ error: "Dimension estimation failed" });
  }
});

// ── DELETE /inventory/:id ─────────────────────────────────────────────────────
// Hard-deletes a single inventory item by id. Admin-protected.
// Used by the client as an atomic rollback when a multi-step add (create then
// PATCH dimensions) fails partway through, preventing dimension-less orphans.
router.delete("/:id", requireAdminAuth, async (req, res) => {
  try {
    const id = parseInt(String(req.params["id"] ?? "0"));
    if (!id) return void res.status(400).json({ error: "Invalid item id" });

    const [deleted] = await db
      .delete(inventoryTable)
      .where(eq(inventoryTable.id, id))
      .returning({ id: inventoryTable.id });

    if (!deleted) return void res.status(404).json({ error: "Item not found" });

    invalidateReferenceAnswerCache().catch(() => {});
    res.status(200).json({ deleted: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete item" });
  }
});

export default router;
