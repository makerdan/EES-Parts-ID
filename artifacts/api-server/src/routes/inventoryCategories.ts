import { Router } from "express";
import { db } from "@workspace/db";
import { inventoryTable } from "@workspace/db";
import { itemFullText } from "../utils/searchHelpers";
import {
  TAXONOMY,
  collectKeywords,
  getAllTaxonomyKeywords,
  type TaxonomyCategory,
  type TaxonomySubcategory,
  type TaxonomyItemType,
} from "@workspace/db";

const router = Router();

type ItemRow = {
  vendor: string;
  catalog: string;
  description: string;
  aiKeywords: string[] | null;
};

function buildKeywordRegex(keywords: string[]): RegExp | null {
  if (keywords.length === 0) return null;
  const escaped = keywords.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(escaped.join("|"), "i");
}

function countForNode(items: ItemRow[], keywords: string[]): number {
  const re = buildKeywordRegex(keywords);
  if (!re) return 0;
  return items.filter(item => re.test(itemFullText(item))).length;
}

// ── GET /inventory/categories ─────────────────────────────────────────────────
// Returns the full taxonomy tree as a uniform categories array.
// The uncategorized catch-all is appended last as a full 3-level node:
//   uncategorized → needs-review → unclassified-items
router.get("/categories", async (_req, res) => {
  try {
    const rows = await db
      .select({
        vendor: inventoryTable.vendor,
        catalog: inventoryTable.catalog,
        description: inventoryTable.description,
        aiKeywords: inventoryTable.aiKeywords,
      })
      .from(inventoryTable);

    const allTaxonomyKeywords = getAllTaxonomyKeywords(TAXONOMY);
    const allTaxRe = buildKeywordRegex(allTaxonomyKeywords);

    const categories = TAXONOMY.map((cat: TaxonomyCategory) => {
      const catKeywords = collectKeywords(cat);

      const subcategories = cat.subcategories.map((sub: TaxonomySubcategory) => {
        const subKeywords = collectKeywords(sub);

        const itemTypes = sub.itemTypes.map((it: TaxonomyItemType) => {
          const itKeywords = collectKeywords(it);
          return {
            slug: it.slug,
            label: it.label,
            count: countForNode(rows, itKeywords),
          };
        });

        return {
          slug: sub.slug,
          label: sub.label,
          count: countForNode(rows, subKeywords),
          itemTypes,
        };
      });

      return {
        slug: cat.slug,
        label: cat.label,
        color: cat.color,
        count: countForNode(rows, catKeywords),
        subcategories,
      };
    });

    // Compute uncategorized count: items matching no taxonomy keyword
    const uncategorizedCount = allTaxRe
      ? rows.filter(item => !allTaxRe.test(itemFullText(item))).length
      : rows.length;

    // Append uncategorized as a full 3-level node (same shape as other categories)
    const uncategorizedNode = {
      slug: "uncategorized",
      label: "Uncategorized",
      color: "#9CA3AF",
      count: uncategorizedCount,
      subcategories: [
        {
          slug: "needs-review",
          label: "Needs Review",
          count: uncategorizedCount,
          itemTypes: [
            {
              slug: "unclassified-items",
              label: "Unclassified Items",
              count: uncategorizedCount,
            },
          ],
        },
      ],
    };

    res.json({ categories: [...categories, uncategorizedNode] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load categories" });
  }
});

export default router;
