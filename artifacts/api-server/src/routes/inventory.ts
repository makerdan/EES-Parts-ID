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

  // Wire gauge alone
  const awg = c.match(/^(\d+)\s*(AWG|GA)?/);
  if (awg && parseInt(awg[1]) <= 4/0) {
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
      confidenceThreshold = 0.5,
    } = req.body as {
      keywords?: string;
      catalog?: string;
      vendor?: string;
      color?: string;
      size?: string;
      material?: string;
      textNumbers?: string;
      confidenceThreshold?: number;
    };

    // Load dictionaries
    const [misspellings, abbreviations, vendors, synonyms, slang] = await Promise.all([
      db.select().from(misspellingMapTable),
      db.select().from(abbreviationMapTable),
      db.select().from(vendorMapTable),
      db.select().from(synonymMapTable),
      db.select().from(electricalSlangMapTable),
    ]);

    const correctionMap = new Map(misspellings.map(m => [m.misspelling, m.correction]));
    const abbrevMap = new Map(abbreviations.map(a => [a.abbreviation, a.expansions]));
    const vendorMap = new Map(vendors.map(v => [v.code, v.names]));
    const synonymMapLookup = new Map(synonyms.map(s => [s.term, s.synonyms]));
    const slangMap = new Map(slang.map(s => [s.slangTerm, s.standardTerms]));

    // Build reverse vendor map (name -> code)
    const reverseVendorMap = new Map<string, string>();
    for (const v of vendors) {
      for (const name of v.names) {
        reverseVendorMap.set(name.toLowerCase(), v.code);
      }
    }

    // Combine all search text
    const allSearchText = [keywords, catalogInput, vendorInput, color, size, material, textNumbers]
      .filter(Boolean).join(" ");

    if (!allSearchText.trim()) {
      return res.json({ results: [], totalMatches: 0, belowThreshold: 0 });
    }

    // Normalize and correct misspellings
    const normalized = normalizeMeasurement(allSearchText);
    const words = normalized.split(/\s+/).filter(w => w.length > 1);
    const corrected = words.map(w => correctMisspelling(w, correctionMap));

    // Expand with abbreviations, synonyms, slang
    const expandedTerms = new Set<string>(corrected);
    for (const word of corrected) {
      const abbrevExpansions = abbrevMap.get(word.toLowerCase());
      if (abbrevExpansions) abbrevExpansions.forEach(e => expandedTerms.add(e));
      const synonymExpansions = synonymMapLookup.get(word.toLowerCase());
      if (synonymExpansions) synonymExpansions.forEach(e => expandedTerms.add(e));
      const slangExpansions = slangMap.get(word.toLowerCase());
      if (slangExpansions) slangExpansions.forEach(e => expandedTerms.add(e));
      // Reverse vendor lookup
      const vendorCode = reverseVendorMap.get(word.toLowerCase());
      if (vendorCode) expandedTerms.add(vendorCode);
      // Forward vendor expansion
      const vendorNames = vendorMap.get(word.toUpperCase());
      if (vendorNames) vendorNames.forEach(n => expandedTerms.add(n));
    }

    // Catalog parsing
    const catalogTerms = catalogInput ? parseCatalogNumber(catalogInput) : [];
    const keywordCatalogTerms = keywords ? parseCatalogNumber(keywords) : [];
    catalogTerms.forEach(t => expandedTerms.add(t));
    keywordCatalogTerms.forEach(t => expandedTerms.add(t));

    // Get all inventory for scoring
    const inventory = await db.select().from(inventoryTable);

    if (inventory.length === 0) {
      return res.json({ results: [], totalMatches: 0, belowThreshold: 0 });
    }

    // Fuse.js fuzzy search
    const fuse = new Fuse(inventory, {
      keys: [
        { name: "catalog", weight: 0.30 },
        { name: "description", weight: 0.25 },
        { name: "vendor", weight: 0.10 },
        { name: "aiKeywords", weight: 0.35 },
      ],
      threshold: 0.4,
      ignoreLocation: true,
      minMatchCharLength: 2,
      findAllMatches: true,
      includeScore: true,
    });

    // Score all items
    const scoreMap = new Map<number, { item: typeof inventory[0]; confidence: number; reason: string }>();

    const updateScore = (id: number, confidence: number, reason: string) => {
      const current = scoreMap.get(id);
      if (!current || confidence > current.confidence) {
        const item = inventory.find(i => i.id === id)!;
        scoreMap.set(id, { item, confidence, reason });
      }
    };

    const vendorFilter = vendorInput.trim().toUpperCase();

    // Strategy cascade
    for (const item of inventory) {
      const catLower = item.catalog.toLowerCase();
      const descLower = item.description.toLowerCase();
      const vendorUpper = item.vendor.toUpperCase();
      const kwJoined = item.aiKeywords.join(" ").toLowerCase();

      // 1. Exact catalog match
      if (catalogInput && item.catalog.toUpperCase() === catalogInput.toUpperCase()) {
        updateScore(item.id, 1.0, "exact catalog");
        continue;
      }
      // 2. Partial catalog match
      if (catalogInput) {
        const ci = catalogInput.toLowerCase();
        if (catLower.includes(ci)) updateScore(item.id, 0.95, "catalog contains input");
        else if (ci.includes(catLower)) updateScore(item.id, 0.90, "input contains catalog");
      }
      // 3. Exact vendor code match
      if (vendorFilter && vendorFilter === vendorUpper) {
        updateScore(item.id, 0.92, "exact vendor match");
      }

      for (const word of corrected) {
        const wl = word.toLowerCase();
        if (wl.length < 2) continue;
        // 4. Exact catalog from keywords
        if (item.catalog.toLowerCase() === wl) {
          updateScore(item.id, 0.98, "keyword=catalog");
          continue;
        }
        // 5. Partial catalog from keywords
        if (catLower.includes(wl) && wl.length >= 3) updateScore(item.id, 0.88, "keyword in catalog");
        // 6. Description contains keyword  
        if (descLower.includes(wl)) updateScore(item.id, 0.80, "keyword in description");
        // 7. Vendor code per keyword
        if (vendorUpper === wl.toUpperCase()) updateScore(item.id, 0.90, "keyword=vendor code");
        // 8. Keyword in enriched keywords
        if (kwJoined.includes(wl)) updateScore(item.id, 0.72, "keyword in ai_keywords");
      }

      // 9. Expanded terms
      for (const expanded of expandedTerms) {
        const el = expanded.toLowerCase();
        if (el.length < 2) continue;
        if (catLower.includes(el)) updateScore(item.id, 0.75, "expanded term in catalog");
        if (descLower.includes(el)) updateScore(item.id, 0.68, "expanded term in description");
        if (kwJoined.includes(el)) updateScore(item.id, 0.68, "expanded term in ai_keywords");
      }
    }

    // Fuse.js fuzzy search
    const fuseQuery = corrected.join(" ");
    if (fuseQuery.trim()) {
      const fuseResults = fuse.search(fuseQuery);
      for (const r of fuseResults) {
        const confidence = (1 - (r.score ?? 0.5)) * 0.65;
        updateScore(r.item.id, confidence, "fuzzy search");
      }
    }

    // Expanded fuse search
    for (const term of Array.from(expandedTerms).slice(0, 10)) {
      if (term.length < 3) continue;
      const fuseExp = fuse.search(term);
      for (const r of fuseExp.slice(0, 20)) {
        const confidence = (1 - (r.score ?? 0.5)) * 0.60;
        updateScore(r.item.id, confidence, "fuzzy expanded");
      }
    }

    // Apply vendor boost/penalty
    const results: Array<{ item: typeof inventory[0]; confidence: number; reason: string }> = [];
    for (const entry of scoreMap.values()) {
      let conf = entry.confidence;
      if (vendorFilter) {
        if (entry.item.vendor.toUpperCase() === vendorFilter) {
          conf = Math.min(1.0, conf + 0.15);
        } else {
          conf *= 0.5;
        }
      }
      results.push({ ...entry, confidence: conf });
    }

    // Sort by confidence
    results.sort((a, b) => b.confidence - a.confidence);

    // Group into series and find variants
    const seriesGroups = new Map<string, { label: string; items: typeof inventory }>();
    for (const r of results) {
      const series = getSeriesBase(r.item.vendor, r.item.catalog, r.item.description);
      if (series) {
        const existing = seriesGroups.get(series.key) ?? { label: series.label, items: [] };
        existing.items.push(r.item);
        seriesGroups.set(series.key, existing);
      }
    }

    // Find variants from full inventory
    const variantMap = new Map<number, typeof inventory>();
    const resultIds = new Set(results.map(r => r.item.id));
    for (const item of inventory) {
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

    const aboveThreshold = results.filter(r => r.confidence >= confidenceThreshold);
    const belowCount = results.length - aboveThreshold.length;

    // Sort above-threshold results by size
    aboveThreshold.sort((a, b) => {
      const diff = b.confidence - a.confidence;
      if (Math.abs(diff) > 0.05) return diff;
      return extractSizeValue(a.item) - extractSizeValue(b.item);
    });

    const finalResults = aboveThreshold.map(r => ({
      item: {
        ...r.item,
        binLocation: r.item.binLocation,
        aiKeywords: r.item.aiKeywords,
      },
      confidence: r.confidence,
      matchReason: r.reason,
      seriesBase: getSeriesBase(r.item.vendor, r.item.catalog, r.item.description)?.key ?? null,
      seriesLabel: getSeriesBase(r.item.vendor, r.item.catalog, r.item.description)?.label ?? null,
      variants: (variantMap.get(r.item.id) ?? []).map(v => ({
        ...v,
        binLocation: v.binLocation,
        aiKeywords: v.aiKeywords,
      })),
    }));

    res.json({
      results: finalResults,
      totalMatches: results.length,
      belowThreshold: belowCount,
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

    let itemsToEnrich;
    if (ids?.length) {
      itemsToEnrich = await db
        .select()
        .from(inventoryTable)
        .where(sql`${inventoryTable.id} = ANY(${ids})`);
    } else {
      itemsToEnrich = await db
        .select()
        .from(inventoryTable)
        .where(sql`${inventoryTable.enrichedAt} IS NULL`)
        .limit(500);
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
        if (event.type === "progress") {
          res.write(`data: ${JSON.stringify({ progress: processed, total, item: event.result })}\n\n`);
        } else if (event.type === "started") {
          res.write(`data: ${JSON.stringify({ progress: 0, total: event.total })}\n\n`);
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
