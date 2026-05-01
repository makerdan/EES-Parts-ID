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
import { openai } from "@workspace/integrations-openai-ai-server";
import { batchProcessWithSSE } from "@workspace/integrations-openai-ai-server/batch";
import Fuse from "fuse.js";

const router = Router();

// ── helpers ──────────────────────────────────────────────────────────────────

function normalizeMeasurement(input: string): string {
  return input
    .toLowerCase()
    .replace(/\bone[-\s]half\b/g, "1/2")
    .replace(/\bthree[-\s]quarter[s]?\b/g, "3/4")
    .replace(/\bone[-\s]quarter\b/g, "1/4")
    .replace(/\btwo[-\s]and[-\s]a[-\s]half\b/g, "2-1/2")
    .replace(/\bone[-\s]and[-\s]a[-\s]half\b/g, "1-1/2")
    .replace(/\bone[-\s]and[-\s]a[-\s]quarter\b/g, "1-1/4")
    .replace(/0\.5\s*["in]/g, "1/2\"")
    .replace(/0\.75\s*["in]/g, "3/4\"")
    .replace(/0\.25\s*["in]/g, "1/4\"")
    .replace(/\binches?\b/g, '"')
    .replace(/\bin\b/g, '"');
}

function parseCatalogNumber(catalog: string): string[] {
  const terms: string[] = [];
  const c = catalog.toUpperCase();

  // Breakers: BR120, QO120, CH120, HOM120, THQL1120
  const breaker = c.match(/^(BR|QO|CH|HOM|THQL|MP|SWD|FH|HH|Q1)(\d{1,2})?(\d{2,3})/i);
  if (breaker) {
    const series = breaker[1];
    const poles = breaker[2] ? parseInt(breaker[2]) : null;
    const amps = breaker[3] ? parseInt(breaker[3]) : null;
    terms.push(series, `${series} series`);
    if (poles) terms.push(`${poles}p`, `${poles} pole`, poles === 1 ? "single pole" : poles === 2 ? "double pole two pole" : "three pole");
    if (amps) terms.push(`${amps}a`, `${amps}amp`, `${amps} ampere`, `${amps}A breaker`);
  }

  // Wire/cable: NM-B, MC, THHN, THWN, with gauge patterns
  const wireGauge = c.match(/(\d+)\s*\/\s*(\d+)/);
  if (wireGauge) {
    terms.push(`${wireGauge[1]}/${wireGauge[2]}`, `${wireGauge[1]} ${wireGauge[2]} wire`, `${wireGauge[1]} awg`);
    if (wireGauge[2] === "2") terms.push("2 conductor");
    if (wireGauge[2] === "3") terms.push("3 conductor");
  }

  // Wire gauge alone (AWG sizes range from 0000=4/0 up to 750 MCM)
  const awg = c.match(/^(\d+)\s*(AWG|GA)?/);
  if (awg && parseInt(awg[1]) <= 750) {
    terms.push(`${awg[1]} awg`, `${awg[1]} gauge`, `#${awg[1]}`);
  }

  // Aught notation (0, 00, 000, 0000 = 1/0, 2/0, 3/0, 4/0)
  const aught = c.match(/^(0{1,4})$/);
  if (aught) {
    const n = aught[1].length;
    terms.push(`${n}/0`, `${n} aught`, `${n}/0 awg`);
  }

  // Receptacle: DR15, CR20, etc.
  const recep = c.match(/^(DR|CR|TR|GF|WR)(\d{2})(\w{2,5})?/i);
  if (recep) {
    const amps = parseInt(recep[2]);
    terms.push(`${amps}a`, `${amps}amp`, "receptacle", "outlet");
    if (recep[3]) {
      const colorMap: Record<string, string> = {
        WHI: "white", BK: "black", GRY: "gray", IVY: "ivory", ALM: "almond",
        BRN: "brown", RED: "red", BLU: "blue",
      };
      const color = colorMap[recep[3].toUpperCase()];
      if (color) terms.push(color);
    }
  }

  // Transformer voltage pattern
  const xfmr = c.match(/^V(\d+)M(\d+)/i);
  if (xfmr) {
    terms.push("transformer", `${xfmr[1]}v`, `${xfmr[2]}va`);
  }

  // Conduit size from catalog  
  const conduitSize = c.match(/^(\d+)\s*(EMT|IMC|RMC|PVC|ENT)/i);
  if (conduitSize) {
    terms.push(`${conduitSize[1]} inch`, conduitSize[2].toLowerCase(), "conduit");
  }

  return terms.filter(Boolean);
}

function correctMisspelling(word: string, corrections: Map<string, string>): string {
  return corrections.get(word.toLowerCase()) ?? word;
}

function extractSizeValue(item: { catalog: string; description: string }): number {
  const text = `${item.catalog} ${item.description}`.toUpperCase();
  // Amperage
  const amp = text.match(/(\d+)\s*A\b/);
  if (amp) return parseInt(amp[1]);
  // Wire gauge (inverted - thicker wire sorts larger: #14=74, #12=76...)
  const awg = text.match(/(\d+)\s*AWG/);
  if (awg) return 88 - parseInt(awg[1]);
  // Mixed fractions
  const mixed = text.match(/(\d+)-(\d+)\/(\d+)/);
  if (mixed) return parseInt(mixed[1]) + parseInt(mixed[2]) / parseInt(mixed[3]);
  // Simple fractions
  const frac = text.match(/(\d+)\/(\d+)/);
  if (frac) return parseInt(frac[1]) / parseInt(frac[2]);
  // Decimal
  const dec = text.match(/(\d+\.\d+)/);
  if (dec) return parseFloat(dec[1]);
  // Length
  const ft = text.match(/(\d+)\s*FT/);
  if (ft) return parseInt(ft[1]);
  // Wattage
  const watt = text.match(/(\d+)\s*W\b/);
  if (watt) return parseInt(watt[1]);
  return 0;
}

function getSeriesBase(
  vendor: string,
  catalog: string,
  description: string,
): { key: string; label: string } | null {
  const c = catalog.toUpperCase();
  const v = vendor.toUpperCase();

  // Breakers by amperage
  if (/^(BR|QO|CH|HOM|THQL|MP|FH|HH|Q1)\d/.test(c)) {
    const base = c.match(/^(BR|QO|CH|HOM|THQL|MP|FH|HH|Q1)(\d{1,2})/)?.[1] ?? c.slice(0, 4);
    return { key: `${v}_${base}`, label: "OTHER AMPERAGES" };
  }
  // Receptacles / devices by color
  if (/^(DR|CR|TR|GF|5\d{3}|6\d{3})/.test(c)) {
    const base = c.match(/^(DR|CR|TR|GF|\d{4})/)?.[1] ?? c.slice(0, 4);
    return { key: `${v}_${base}`, label: "OTHER COLORS" };
  }
  // Wire by length
  if (/^(RX|NM|MC|SE|SER|UF|THHN|THWN)\d/.test(c)) {
    const base = c.replace(/\d{3,}FT.*$/, "").replace(/\d{3,}$/, "");
    return { key: `${v}_${base}`, label: "OTHER LENGTHS" };
  }
  // Transformers by KVA
  if (/^V\d+M\d+/.test(c)) {
    const base = c.match(/^(V\d+M\d+T)/)?.[1] ?? c.slice(0, 8);
    return { key: `${v}_${base}`, label: "OTHER CAPACITIES" };
  }
  // Conduit by size
  if (/EMT|IMC|RMC|PVC|ENT/.test(description.toUpperCase())) {
    const base = catalog.replace(/^\d+/, "");
    return { key: `${v}_${base}`, label: "OTHER SIZES" };
  }
  return null;
}

// ── GET /inventory ────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query["page"] as string) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query["limit"] as string) || 50));
    const offset = (page - 1) * limit;

    const [items, countResult] = await Promise.all([
      db.select().from(inventoryTable).limit(limit).offset(offset).orderBy(inventoryTable.vendor, inventoryTable.catalog),
      db.select({ count: sql<number>`count(*)` }).from(inventoryTable),
    ]);

    res.json({
      items: items.map(item => ({
        ...item,
        binLocation: item.binLocation,
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

function itemFullText(item: { vendor: string; catalog: string; description: string; aiKeywords: string[] | null }): string {
  return `${item.vendor} ${item.catalog} ${item.description} ${(item.aiKeywords ?? []).join(" ")}`.toLowerCase();
}

/** Token-aware match: every word in the filter value must appear as a whole word in `text`. */
function tokenMatch(text: string, filterValue: string): boolean {
  const tokens = filterValue.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  // Allow prefix-token match for short codes (e.g. "1/2" in "1/2 conduit") via
  // word-boundary regex so "20" doesn't spuriously match inside "200A".
  return tokens.every(tok => {
    // Escape regex special chars in the token
    const escaped = tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![\\w])${escaped}(?![\\w])`, "i").test(text);
  });
}

function matchesChipFilters(
  item: { vendor: string; catalog: string; description: string; aiKeywords: string[] | null },
  chipFilters: Array<{ key: string; value: string }>,
): boolean {
  const text = itemFullText(item);
  return chipFilters.every(f => tokenMatch(text, f.value));
}

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
    const synonymMapLookup = new Map(synonyms.map(s => [s.term, s.synonyms]));
    const slangMap = new Map(slang.map(s => [s.slangTerm, s.standardTerms]));

    const reverseVendorMap = new Map<string, string>();
    for (const v of vendors) {
      for (const name of v.names) reverseVendorMap.set(name.toLowerCase(), v.code);
    }

    const allSearchText = [keywords, catalogInput, vendorInput, color, size, material, textNumbers]
      .filter(Boolean).join(" ");

    if (!allSearchText.trim()) {
      return res.json({ results: [], totalMatches: 0, belowThreshold: 0 });
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

    const vendorFilter = vendorInput.trim().toUpperCase();
    const allTermsArr = Array.from(expandedTerms).filter(t => t.length >= 2);
    const tsQuery = allTermsArr.map(t => t.replace(/[^\w\s]/g, " ").trim()).filter(Boolean).join(" | ");

    // ─── PG FTS + trigram ranked search (server-side) ───────────────────────
    type RawRow = {
      id: number; vendor: string; catalog: string; description: string;
      bin_location: string; ai_keywords: string[]; enriched_at: Date | null;
      created_at: Date; updated_at: Date;
      fts_rank: number; trgm_sim: number;
    };

    let pgResults: RawRow[] = [];
    try {
      if (tsQuery.trim()) {
        const pgQueryResult = await db.execute(sql`
          SELECT
            i.id, i.vendor, i.catalog, i.description,
            i.bin_location, i.ai_keywords, i.enriched_at, i.created_at, i.updated_at,
            ts_rank_cd(
              to_tsvector('english', coalesce(i.vendor,'') || ' ' || coalesce(i.catalog,'') || ' ' || coalesce(i.description,'')),
              to_tsquery('english', ${tsQuery})
            ) AS fts_rank,
            greatest(
              similarity(i.catalog, ${allTermsArr.slice(0,3).join(" ")}),
              similarity(i.description, ${allTermsArr.slice(0,5).join(" ")})
            ) AS trgm_sim
          FROM inventory i
          WHERE
            to_tsvector('english', coalesce(i.vendor,'') || ' ' || coalesce(i.catalog,'') || ' ' || coalesce(i.description,''))
              @@ to_tsquery('english', ${tsQuery})
            OR similarity(i.catalog, ${allTermsArr.slice(0,3).join(" ")}) > 0.1
            OR similarity(i.description, ${allTermsArr.slice(0,5).join(" ")}) > 0.1
            ${vendorFilter ? sql`OR upper(i.vendor) = ${vendorFilter}` : sql``}
          ORDER BY (fts_rank * 0.6 + trgm_sim * 0.4) DESC
          LIMIT 200
        `);
        // Drizzle returns { rows: unknown[] } for raw SQL — validate shape at runtime
        const rawRows = (pgQueryResult as { rows: unknown[] }).rows;
        pgResults = rawRows.filter((r): r is RawRow => {
          if (!r || typeof r !== "object") return false;
          const row = r as Record<string, unknown>;
          return (
            typeof row.id === "number" &&
            typeof row.vendor === "string" &&
            typeof row.catalog === "string" &&
            typeof row.description === "string" &&
            typeof row.fts_rank === "number" &&
            typeof row.trgm_sim === "number"
          );
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
      if (!current || confidence > current.confidence) {
        scoreMap.set(item.id, { item, confidence, reason });
      }
    };

    // Process PG results
    for (const row of pgResults) {
      const ftsRank = Number(row.fts_rank) || 0;
      const trgmSim = Number(row.trgm_sim) || 0;
      const pgScore = Math.min(0.95, ftsRank * 0.6 + trgmSim * 0.4 + 0.4);
      const item: typeof inventoryTable.$inferSelect = {
        id: row.id,
        vendor: row.vendor,
        catalog: row.catalog,
        description: row.description,
        binLocation: row.bin_location,
        aiKeywords: row.ai_keywords ?? [],
        enrichedAt: row.enriched_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };

      // Boost for exact catalog
      if (catalogInput && row.catalog.toUpperCase() === catalogInput.toUpperCase()) {
        updateScore(item, 1.0, "exact catalog");
        continue;
      }
      if (catalogInput && row.catalog.toUpperCase().includes(catalogInput.toUpperCase())) {
        updateScore(item, Math.max(pgScore, 0.9), "catalog prefix");
        continue;
      }
      updateScore(item, pgScore, ftsRank > 0 ? "fts match" : "trigram match");
    }

    // Exact catalog fallback if PG didn't catch it
    if (catalogInput && pgResults.length === 0) {
      const exactRows = await db.select().from(inventoryTable)
        .where(sql`upper(${inventoryTable.catalog}) = upper(${catalogInput})`);
      for (const item of exactRows) updateScore(item, 1.0, "exact catalog fallback");
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
          const conf = (1 - (r.score ?? 0.5)) * 0.70;
          if (conf > 0.2) updateScore(r.item, conf, "fuzzy fallback");
        }
      }
      for (const term of allTermsArr.slice(0, 8)) {
        if (term.length < 3) continue;
        for (const r of fuse.search(term).slice(0, 15)) {
          const conf = (1 - (r.score ?? 0.5)) * 0.60;
          if (conf > 0.2) updateScore(r.item, conf, "fuzzy expanded fallback");
        }
      }
    }

    // Apply vendor boost/penalty
    const results: ScoredItem[] = [];
    for (const entry of scoreMap.values()) {
      let conf = entry.confidence;
      if (vendorFilter) {
        if (entry.item.vendor.toUpperCase() === vendorFilter) conf = Math.min(1.0, conf + 0.15);
        else conf *= 0.5;
      }
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

// ── POST /inventory/upsert-batch ──────────────────────────────────────────────
router.post("/upsert-batch", async (req, res) => {
  try {
    const { items } = req.body as {
      items: Array<{ vendor: string; catalog: string; description?: string; binLocation?: string }>;
    };

    if (!items?.length) {
      return res.status(400).json({ error: "No items provided" });
    }

    let inserted = 0;
    let updated = 0;

    for (const item of items) {
      const existing = await db
        .select()
        .from(inventoryTable)
        .where(
          and(
            sql`UPPER(${inventoryTable.vendor}) = UPPER(${item.vendor})`,
            sql`UPPER(${inventoryTable.catalog}) = UPPER(${item.catalog})`,
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        await db
          .update(inventoryTable)
          .set({
            description: item.description ?? existing[0]?.description,
            binLocation: item.binLocation ?? existing[0]?.binLocation,
            updatedAt: new Date(),
          })
          .where(eq(inventoryTable.id, existing[0]!.id));
        updated++;
      } else {
        await db.insert(inventoryTable).values({
          vendor: item.vendor.toUpperCase(),
          catalog: item.catalog,
          description: item.description ?? "",
          binLocation: item.binLocation ?? "",
          aiKeywords: [],
        });
        inserted++;
      }
    }

    res.json({ inserted, updated, total: items.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Upsert failed" });
  }
});

// ── POST /inventory/enrich ────────────────────────────────────────────────────
router.post("/enrich", async (req, res) => {
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
        const response = await openai.chat.completions.create({
          model: "gpt-5-mini",
          max_completion_tokens: 256,
          messages: [
            {
              role: "system",
              content:
                "You are an expert electrical supply warehouse cataloger. Generate searchable keywords for electrical parts. Return ONLY a JSON array of 6-10 keyword strings. Include: full product name, category, common synonyms, abbreviation expansions, material, ratings, NEMA type if applicable. No explanations.",
            },
            {
              role: "user",
              content: `Vendor: ${item.vendor}\nCatalog: ${item.catalog}\nDescription: ${item.description}\n\nReturn JSON array of keywords only.`,
            },
          ],
        });

        const text = response.choices[0]?.message?.content ?? "[]";
        let keywords: string[] = [];
        try {
          const parsed = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] ?? "[]");
          if (Array.isArray(parsed)) keywords = parsed.map(String).slice(0, 10);
        } catch {
          keywords = text.split(/[,\n]/).map(k => k.trim().replace(/["\[\]]/g, "")).filter(k => k.length > 1).slice(0, 10);
        }

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

// ── PATCH /inventory/:id/keywords ─────────────────────────────────────────────
router.patch("/:id/keywords", async (req, res) => {
  try {
    const id = parseInt(req.params["id"] ?? "0");
    const { keywords } = req.body as { keywords: string[] };

    if (!Array.isArray(keywords)) {
      return res.status(400).json({ error: "keywords must be an array" });
    }

    const [updated] = await db
      .update(inventoryTable)
      .set({ aiKeywords: keywords, updatedAt: new Date() })
      .where(eq(inventoryTable.id, id))
      .returning();

    if (!updated) return res.status(404).json({ error: "Item not found" });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update keywords" });
  }
});

export default router;
