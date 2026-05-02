/**
 * Seeded three-level taxonomy.
 *
 * Top-level Categories follow the section structure of the Elliott
 * Electric Supply (EES) Product Catalog (June 2025) found in
 * `attached_assets/EES_Product_Catalog_(06.2025)_*.pdf`:
 *
 *   A. Distribution Equipment   → "breakers" + "panels-distribution"
 *   B. Wiring Devices           → "receptacles" + "switches"
 *   C. Lighting & Lighting Ctrl → "lighting"
 *   D. Wire & Cable             → "wire-cable"
 *   E. Conduit, Fittings, Boxes → "conduit-raceway" + "boxes-enclosures"
 *                                 + "connectors-terminations"
 *   F. Enclosures & Wireway     → covered by "boxes-enclosures"
 *   G. HVAC                     → not seen in current inventory
 *   H. Motor Control            → "motors-controls-sensors"
 *   I. Harsh Locations          → folded into existing categories
 *   J. Datacom                  → not seen in current inventory
 *   K. Tools / Terminals / Fast → not seen in current inventory
 *   L. References               → not categorisable
 *
 * Subcategory + Type splits below were then refined from existing
 * dictionaries (CHIP_DIMS_SERVER, abbreviation map categories, vendor
 * patterns) and from real inventory shapes observed in the database.
 *
 * The classifier rules in `taxonomyClassifier.ts` map onto the leaf
 * "type" slugs defined here — keep them in sync.
 *
 * Idempotent: an existing slug is left alone, missing slugs are
 * inserted, and node names/sort_order are updated in place.
 */

import { eq, sql } from "drizzle-orm";
import * as fs from "node:fs";
import * as path from "node:path";
import { db, categoryNodeTable } from "@workspace/db";

interface SeedType {
  slug: string;
  name: string;
}
interface SeedSubcategory {
  slug: string;
  name: string;
  types: SeedType[];
}
interface SeedCategory {
  slug: string;
  name: string;
  subcategories: SeedSubcategory[];
}

/**
 * Default seed taxonomy, manually derived from the EES Product Catalog
 * (06.2025) PDF in `attached_assets/`. We keep this as a TypeScript
 * literal because (a) the canonical source is a PDF that needs human
 * review for category structure, (b) it gives us full type safety, and
 * (c) it avoids a runtime dependency on a parser.
 *
 * Override mechanism: if `attached_assets/eesTaxonomy.json` exists at
 * seed time, its contents are used INSTEAD of this default. That lets
 * ops drop a freshly-generated catalog dump into attached_assets without
 * a code change. See `loadTaxonomySource()`.
 */
export const SEED_TAXONOMY: SeedCategory[] = [
  {
    slug: "breakers",
    name: "Breakers",
    subcategories: [
      {
        slug: "breakers-by-type",
        name: "By Type",
        types: [
          { slug: "breaker-standard", name: "Standard Circuit Breakers" },
          { slug: "breaker-gfci", name: "GFCI Breakers" },
          { slug: "breaker-afci", name: "AFCI Breakers" },
        ],
      },
    ],
  },
  {
    slug: "wire-cable",
    name: "Wire & Cable",
    subcategories: [
      {
        slug: "wire-by-type",
        name: "By Type",
        types: [
          { slug: "wire-thhn", name: "THHN / THWN Building Wire" },
          { slug: "wire-romex", name: "Romex / NM-B Cable" },
          { slug: "wire-mc", name: "MC / Armored Cable" },
          { slug: "wire-uf", name: "UF Underground Feeder" },
          { slug: "wire-ser", name: "SER / Service Entrance" },
          { slug: "wire-other", name: "Other Wire & Cable" },
        ],
      },
    ],
  },
  {
    slug: "conduit-raceway",
    name: "Conduit & Raceway",
    subcategories: [
      {
        slug: "conduit-by-material",
        name: "By Material",
        types: [
          { slug: "conduit-emt", name: "EMT" },
          { slug: "conduit-pvc", name: "PVC" },
          { slug: "conduit-rmc", name: "RMC / Rigid Metal" },
          { slug: "conduit-imc", name: "IMC" },
          { slug: "conduit-fmc", name: "FMC / Flexible Metal" },
          { slug: "conduit-ent", name: "ENT / Smurf Tube" },
          { slug: "conduit-other", name: "Other Conduit" },
        ],
      },
      {
        slug: "conduit-fittings",
        name: "Fittings",
        types: [
          { slug: "fitting-coupling", name: "Couplings" },
          { slug: "fitting-elbow", name: "Elbows" },
          { slug: "fitting-connector", name: "Connectors" },
          { slug: "fitting-condulet", name: "Condulets / Conduit Bodies" },
          { slug: "fitting-strap", name: "Straps & Hangers" },
          { slug: "fitting-other", name: "Other Fittings" },
        ],
      },
    ],
  },
  {
    slug: "receptacles",
    name: "Receptacles",
    subcategories: [
      {
        slug: "receptacles-by-type",
        name: "By Type",
        types: [
          { slug: "receptacle-duplex", name: "Duplex Receptacles" },
          { slug: "receptacle-gfci", name: "GFCI Receptacles" },
          { slug: "receptacle-usb", name: "USB Receptacles" },
          { slug: "receptacle-twist-lock", name: "Twist-Lock Receptacles" },
          { slug: "receptacle-range", name: "Range / Dryer Receptacles" },
          { slug: "receptacle-other", name: "Other Receptacles" },
        ],
      },
    ],
  },
  {
    slug: "switches",
    name: "Switches & Dimmers",
    subcategories: [
      {
        slug: "switches-by-type",
        name: "By Type",
        types: [
          { slug: "switch-toggle", name: "Toggle Switches" },
          { slug: "switch-3way", name: "3-Way Switches" },
          { slug: "switch-4way", name: "4-Way Switches" },
          { slug: "switch-dimmer", name: "Dimmers" },
          { slug: "switch-occupancy", name: "Occupancy Sensors" },
          { slug: "switch-other", name: "Other Switches" },
        ],
      },
    ],
  },
  {
    slug: "boxes-enclosures",
    name: "Boxes & Enclosures",
    subcategories: [
      {
        slug: "boxes-by-type",
        name: "By Type",
        types: [
          { slug: "box-device", name: "Device / Switch Boxes" },
          { slug: "box-junction", name: "Junction / Pull Boxes" },
          { slug: "box-weatherproof", name: "Weatherproof Boxes" },
          { slug: "box-floor", name: "Floor Boxes" },
          { slug: "box-fan", name: "Fan-Rated Boxes" },
          { slug: "box-other", name: "Other Boxes & Enclosures" },
        ],
      },
    ],
  },
  {
    slug: "panels-distribution",
    name: "Panels & Distribution",
    subcategories: [
      {
        slug: "panels-by-type",
        name: "By Type",
        types: [
          { slug: "panel-loadcenter", name: "Load Centers / Panelboards" },
          { slug: "panel-meter", name: "Meter Sockets / Meter Mains" },
          { slug: "panel-other", name: "Other Panels" },
        ],
      },
      {
        slug: "transformers",
        name: "Transformers",
        types: [
          { slug: "transformer-control", name: "Control / Buck-Boost Transformers" },
          { slug: "transformer-other", name: "Other Transformers" },
        ],
      },
      {
        slug: "fuses",
        name: "Fuses",
        types: [
          { slug: "fuse-cartridge", name: "Cartridge Fuses" },
          { slug: "fuse-glass", name: "Glass / Automotive Fuses" },
          { slug: "fuse-other", name: "Other Fuses" },
        ],
      },
    ],
  },
  {
    slug: "lighting",
    name: "Lighting",
    subcategories: [
      {
        slug: "lighting-by-type",
        name: "By Type",
        types: [
          { slug: "lighting-led-bulb", name: "LED Bulbs" },
          { slug: "lighting-fluorescent", name: "Fluorescent" },
          { slug: "lighting-fixture", name: "Fixtures" },
          { slug: "lighting-recessed", name: "Recessed / Cans" },
          { slug: "lighting-other", name: "Other Lighting" },
        ],
      },
    ],
  },
  {
    slug: "connectors-terminations",
    name: "Connectors & Terminations",
    subcategories: [
      {
        slug: "connectors-by-type",
        name: "By Type",
        types: [
          { slug: "connector-wirenut", name: "Wire Nuts" },
          { slug: "connector-lug", name: "Lugs" },
          { slug: "connector-terminal", name: "Terminal Blocks" },
          { slug: "connector-other", name: "Other Connectors" },
        ],
      },
    ],
  },
  {
    slug: "motors-controls-sensors",
    name: "Motors, Controls & Sensors",
    subcategories: [
      {
        slug: "motor-controls",
        name: "Motor Controls",
        types: [{ slug: "motor-control", name: "Starters / Contactors / VFDs" }],
      },
      {
        slug: "sensors",
        name: "Sensors",
        types: [{ slug: "sensor-photo", name: "Photocells / Light Sensors" }],
      },
    ],
  },
  // ── Uncategorized fallback ──────────────────────────────────────────────
  // Every part must map to a Category → Subcategory → Type triple. When the
  // rule classifier (and optional AI fallback) can't place a row, it lands
  // here so it stays visible in Browse instead of silently disappearing.
  {
    slug: "uncategorized",
    name: "Uncategorized",
    subcategories: [
      {
        slug: "uncategorized-general",
        name: "Needs Review",
        types: [{ slug: "uncategorized-type", name: "Unclassified Items" }],
      },
    ],
  },
];

/** Slug of the leaf "type" node every unmatched part is pinned to. */
export const UNCATEGORIZED_TYPE_SLUG = "uncategorized-type";

/**
 * Idempotent seed of the taxonomy tree.
 *
 * - Missing nodes are inserted.
 * - Existing nodes (matched by slug) have their `name` and `sortOrder`
 *   refreshed to match the latest seed definition. This lets us rename
 *   or re-order seed nodes without manual SQL.
 *
 * We deliberately do NOT touch `parentId` or `source` on existing rows —
 * a node's parent should never silently move (that would break references
 * from inventory_category and re-parent ops/AI edits), and `source`
 * preserves manual/AI provenance on rows that started life as "seed".
 *
 * Returns counts for logging.
 */
/**
 * Load the taxonomy source. Prefers `attached_assets/eesTaxonomy.json`
 * (so ops can ship updated EES catalog data without a code change) and
 * falls back to the embedded SEED_TAXONOMY constant.
 *
 * Validation is deliberately minimal — the file is operator-controlled,
 * not user input. We just verify it has the right top-level shape; if
 * anything looks wrong we log and fall back rather than seeding garbage.
 */
function loadTaxonomySource(): { source: "file" | "embedded"; tree: SeedCategory[] } {
  // Try several plausible locations relative to wherever the seed is run from.
  const candidates = [
    path.resolve(process.cwd(), "attached_assets/eesTaxonomy.json"),
    path.resolve(process.cwd(), "../../attached_assets/eesTaxonomy.json"),
    path.resolve(__dirname, "../../../../attached_assets/eesTaxonomy.json"),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(p, "utf-8")) as unknown;
      if (!Array.isArray(parsed)) {
        console.warn(`[seedTaxonomy] ${p} is not an array — falling back to embedded seed`);
        return { source: "embedded", tree: SEED_TAXONOMY };
      }
      // Light shape validation — accept anything Category[] shaped.
      const ok = parsed.every(
        c =>
          typeof c === "object" && c !== null &&
          typeof (c as SeedCategory).slug === "string" &&
          typeof (c as SeedCategory).name === "string" &&
          Array.isArray((c as SeedCategory).subcategories),
      );
      if (!ok) {
        console.warn(`[seedTaxonomy] ${p} failed shape validation — falling back to embedded seed`);
        return { source: "embedded", tree: SEED_TAXONOMY };
      }
      console.log(`[seedTaxonomy] using EES catalog override at ${p}`);
      return { source: "file", tree: parsed as SeedCategory[] };
    } catch (err) {
      console.warn(`[seedTaxonomy] failed to parse ${p}: ${String(err)} — falling back`);
      return { source: "embedded", tree: SEED_TAXONOMY };
    }
  }
  return { source: "embedded", tree: SEED_TAXONOMY };
}

export async function seedTaxonomy(): Promise<{
  insertedCategories: number;
  insertedSubcategories: number;
  insertedTypes: number;
  updatedNodes: number;
  source: "file" | "embedded";
}> {
  let insertedCategories = 0;
  let insertedSubcategories = 0;
  let insertedTypes = 0;
  let updatedNodes = 0;

  const { source, tree } = loadTaxonomySource();

  // Build a slug → row map from any nodes already present so we don't duplicate.
  const existing = await db.select().from(categoryNodeTable);
  const bySlug = new Map<string, (typeof existing)[number]>();
  for (const n of existing) bySlug.set(n.slug, n);
  const slugToId = new Map<string, number>();
  for (const n of existing) slugToId.set(n.slug, n.id);

  // Helper: refresh name + sortOrder if either differs from what's seeded.
  const upsertExisting = async (slug: string, name: string, sortOrder: number) => {
    const cur = bySlug.get(slug);
    if (!cur) return;
    if (cur.name !== name || cur.sortOrder !== sortOrder) {
      await db
        .update(categoryNodeTable)
        .set({ name, sortOrder, updatedAt: new Date() })
        .where(eq(categoryNodeTable.id, cur.id));
      updatedNodes++;
    }
  };

  for (let ci = 0; ci < tree.length; ci++) {
    const cat = tree[ci]!;
    let catId = slugToId.get(cat.slug);
    if (!catId) {
      const [row] = await db
        .insert(categoryNodeTable)
        .values({
          parentId: null,
          level: "category",
          name: cat.name,
          slug: cat.slug,
          sortOrder: ci,
          source: "seed",
        })
        .returning();
      catId = row!.id;
      slugToId.set(cat.slug, catId);
      insertedCategories++;
    } else {
      await upsertExisting(cat.slug, cat.name, ci);
    }

    for (let si = 0; si < cat.subcategories.length; si++) {
      const sub = cat.subcategories[si]!;
      let subId = slugToId.get(sub.slug);
      if (!subId) {
        const [row] = await db
          .insert(categoryNodeTable)
          .values({
            parentId: catId,
            level: "subcategory",
            name: sub.name,
            slug: sub.slug,
            sortOrder: si,
            source: "seed",
          })
          .returning();
        subId = row!.id;
        slugToId.set(sub.slug, subId);
        insertedSubcategories++;
      } else {
        await upsertExisting(sub.slug, sub.name, si);
      }

      for (let ti = 0; ti < sub.types.length; ti++) {
        const t = sub.types[ti]!;
        if (slugToId.has(t.slug)) {
          await upsertExisting(t.slug, t.name, ti);
          continue;
        }
        const [row] = await db
          .insert(categoryNodeTable)
          .values({
            parentId: subId,
            level: "type",
            name: t.name,
            slug: t.slug,
            sortOrder: ti,
            source: "seed",
          })
          .returning();
        slugToId.set(t.slug, row!.id);
        insertedTypes++;
      }
    }
  }

  // bump updated_at on the table even if no inserts (for the `/version` poll)
  await db.execute(sql`SELECT 1`);

  return { insertedCategories, insertedSubcategories, insertedTypes, updatedNodes, source };
}
