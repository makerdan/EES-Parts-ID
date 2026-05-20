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

function itemMatchesKeywords(item: ItemRow, keywords: string[]): boolean {
  const text = itemFullText(item);
  return keywords.some(kw => text.includes(kw.toLowerCase()));
}

function countForNode(
  items: ItemRow[],
  keywords: string[],
): number {
  if (keywords.length === 0) return 0;
  return items.filter(item => itemMatchesKeywords(item, keywords)).length;
}

// ── GET /inventory/categories ─────────────────────────────────────────────────
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

    const uncategorizedCount = rows.filter(
      item => !itemMatchesKeywords(item, allTaxonomyKeywords),
    ).length;

    res.json({
      categories,
      uncategorized: {
        slug: "uncategorized",
        label: "Uncategorized",
        count: uncategorizedCount,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load categories" });
  }
});

export default router;
