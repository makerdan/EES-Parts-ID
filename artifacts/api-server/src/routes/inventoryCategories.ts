import { db } from "@workspace/db";
import { collectKeywords,getAllTaxonomyKeywords, TAXONOMY } from "@workspace/db";
import { sql } from "drizzle-orm";
import { Router } from "express";

const router = Router();

// Matches the chip-text expression used in chip-filter WHERE clauses
// eslint-disable-next-line unused-imports/no-unused-vars
const CHIP_FN = `inventory_chip_text(vendor, catalog, description, ai_keywords)`;

function escapeForPattern(kw: string): string {
  return kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildPattern(keywords: Array<string>): string | null {
  if (!keywords || keywords.length === 0) return null;
  return keywords.map(escapeForPattern).join("|");
}

// ── GET /inventory/categories ─────────────────────────────────────────────────
// Strategy: single SQL pass to materialise chip text for every row, then
// classify entirely in JS using the same regex patterns as chip filters.
// This is equivalent to one COUNT(*) FILTER (WHERE chip ~* pat) per item type
// but avoids evaluating 132 separate regex patterns inside PostgreSQL for every
// of the 7 000+ rows (which times out at ~14 s).
//
// Optional dimension query params (all in mm):
//   minWidth, maxWidth, minHeight, maxHeight, minDiameter, maxDiameter
// When any are present the SQL WHERE clause is narrowed so counts reflect
// only items that match the size filter.
router.get("/categories", async (req, res) => {
  try {
    // ── Parse optional dimension filter params ────────────────────────────────
    // Returns null when the param is absent/empty, or throws a 400-class error
    // object when a value is present but not a finite number so NaN never
    // propagates into ORM queries.
    const DIM_PARAMS = ["minWidth", "maxWidth", "minHeight", "maxHeight", "minDiameter", "maxDiameter"] as const;
    const parsedDims: Record<string, number | null> = {};
    for (const key of DIM_PARAMS) {
      const v = req.query[key];
      if (v == null || v === "") {
        parsedDims[key] = null;
        continue;
      }
      const n = Number(v);
      if (!Number.isFinite(n)) {
        return void res.status(400).json({ error: `Invalid dimension parameter: ${key}=${String(v)} must be a finite number` });
      }
      parsedDims[key] = n;
    }
    const minWidth    = parsedDims["minWidth"]!;
    const maxWidth    = parsedDims["maxWidth"]!;
    const minHeight   = parsedDims["minHeight"]!;
    const maxHeight   = parsedDims["maxHeight"]!;
    const minDiameter = parsedDims["minDiameter"]!;
    const maxDiameter = parsedDims["maxDiameter"]!;

    // Build WHERE conditions using the same expression pattern as the indexed
    // columns so Postgres can use expression indexes.
    const dimClauses: Array<ReturnType<typeof sql>> = [];
    if (minWidth    !== null) dimClauses.push(sql`(dimensions->>'width')::numeric    >= ${minWidth}`);
    if (maxWidth    !== null) dimClauses.push(sql`(dimensions->>'width')::numeric    <= ${maxWidth}`);
    if (minHeight   !== null) dimClauses.push(sql`(dimensions->>'height')::numeric   >= ${minHeight}`);
    if (maxHeight   !== null) dimClauses.push(sql`(dimensions->>'height')::numeric   <= ${maxHeight}`);
    if (minDiameter !== null) dimClauses.push(sql`(dimensions->>'diameter')::numeric >= ${minDiameter}`);
    if (maxDiameter !== null) dimClauses.push(sql`(dimensions->>'diameter')::numeric <= ${maxDiameter}`);

    // Combine clauses with AND; empty when no dim filter is active.
    const whereFragment = dimClauses.length > 0
      ? sql`WHERE ${dimClauses.reduce((acc, clause) => sql`${acc} AND ${clause}`)}`
      : sql``;

    // ── Step 1: fetch chip texts (filtered by dimensions when active) ─────────
    const raw = await db.execute(
      sql`SELECT inventory_chip_text(vendor, catalog, description, ai_keywords) AS chip FROM inventory ${whereFragment}`
    );
    const chips = (raw.rows as Array<{ chip: string | null }>).map(r => r.chip ?? "");

    // ── Step 2: compile all item-type regex patterns (JS RegExp, same semantics
    //            as PostgreSQL ~* for simple keyword alternation patterns) ──────
    type ItemEntry = { slug: string; re: RegExp | null };
    const itemEntries: Array<ItemEntry> = [];

    for (const cat of TAXONOMY) {
      for (const sub of cat.subcategories) {
        for (const it of sub.itemTypes) {
          const pat = buildPattern(it.keywords);
          itemEntries.push({ slug: it.slug, re: pat ? new RegExp(pat, "i") : null });
        }
      }
    }

    // Also compile the inverse-match set for uncategorized
    const allTaxKws = getAllTaxonomyKeywords(TAXONOMY);
    const allTaxRe = allTaxKws.length > 0
      ? new RegExp(buildPattern(allTaxKws)!, "i")
      : null;

    // ── Step 3: pre-compile per-node regexes for categories and subcategories ─
    // Using collectKeywords(node) gives each parent node its own keyword union,
    // producing unique per-node counts (not child-sum aggregation).
    const mainCategories = TAXONOMY.filter(c => c.slug !== "uncategorized");
    const uncatTax = TAXONOMY.find(c => c.slug === "uncategorized")!;

    const catRegexMap = new Map<string, RegExp | null>();
    const subRegexMap = new Map<string, RegExp | null>();

    for (const cat of mainCategories) {
      const catPat = buildPattern(collectKeywords(cat));
      catRegexMap.set(cat.slug, catPat ? new RegExp(catPat, "i") : null);
      for (const sub of cat.subcategories) {
        const subPat = buildPattern(collectKeywords(sub));
        subRegexMap.set(sub.slug, subPat ? new RegExp(subPat, "i") : null);
      }
    }

    // ── Step 4: single-pass classification ───────────────────────────────────
    const itemCounts  = new Int32Array(itemEntries.length); // item-type counts
    const catCountMap = new Map<string, number>();
    const subCountMap = new Map<string, number>();
    let uncatCount = 0;

    for (const chip of chips) {
      // Item-type counts (each item can match multiple types)
      for (let i = 0; i < itemEntries.length; i++) {
        const { re } = itemEntries[i]!;
        if (re && re.test(chip)) itemCounts[i] = itemCounts[i]! + 1;
      }
      // Per-node unique counts via node's own keyword union
      for (const [slug, re] of catRegexMap) {
        if (re && re.test(chip)) catCountMap.set(slug, (catCountMap.get(slug) ?? 0) + 1);
      }
      for (const [slug, re] of subRegexMap) {
        if (re && re.test(chip)) subCountMap.set(slug, (subCountMap.get(slug) ?? 0) + 1);
      }
      // Uncategorized: no taxonomy keyword matches
      if (allTaxRe && !allTaxRe.test(chip)) uncatCount++;
      else if (!allTaxRe) uncatCount++;
    }

    // ── Step 5: build item-type count map ────────────────────────────────────
    const itemCountMap = new Map<string, number>();
    itemEntries.forEach((e, i) => itemCountMap.set(e.slug, itemCounts[i]!));

    // ── Step 6: assemble response ─────────────────────────────────────────────
    const categories = mainCategories.map(cat => {
      const catCount = catCountMap.get(cat.slug) ?? 0;
      const subcategories = cat.subcategories.map(sub => {
        const subCount = subCountMap.get(sub.slug) ?? 0;
        const itemTypes = sub.itemTypes.map(it => ({
          slug: it.slug, label: it.label, count: itemCountMap.get(it.slug) ?? 0,
        }));
        return { slug: sub.slug, label: sub.label, count: subCount, itemTypes };
      });
      return { slug: cat.slug, label: cat.label, color: cat.color, count: catCount, subcategories };
    });

    const uncategorizedNode = {
      slug: "uncategorized",
      label: "Uncategorized",
      color: "#9CA3AF",
      count: uncatCount,
      subcategories: uncatTax.subcategories.map(sub => ({
        slug: sub.slug,
        label: sub.label,
        count: uncatCount,
        itemTypes: sub.itemTypes.map(it => ({
          slug: it.slug,
          label: it.label,
          count: uncatCount,
        })),
      })),
    };

    res.json({ categories: [...categories, uncategorizedNode] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load categories" });
  }
});

export default router;
