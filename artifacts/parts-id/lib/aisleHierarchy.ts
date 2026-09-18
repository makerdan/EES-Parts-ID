/**
 * Pure data layer for the Browse Aisles feature.
 *
 * No React Native imports — safe to unit-test in a plain Node/Jest env.
 *
 * Bin-code format: AA-SS-PPP
 *   AA  = 2-digit aisle  (00–99)
 *   SS  = 2-digit section (00–99)
 *   PPP = 3-digit position (001–999)
 *        shelfHundreds = Math.floor(PPP / 100)  → shelf tier
 */
import type { InventoryItem } from "@workspace/api-client-react";

const BIN_RE = /^(\d{2})-(\d{2})-(\d{3})$/;

export type ParsedBin = {
  raw: string;
  aisle: number;
  section: number;
  shelfHundreds: number;
  position: number;
};

export type PartOnShelf = {
  item: InventoryItem;
  bin: ParsedBin;
};

export type ShelfNode = {
  shelfHundreds: number;
  label: string;
  parts: Array<PartOnShelf>;
};

export type SectionNode = {
  sectionNum: number;
  label: string;
  shelves: Array<ShelfNode>;
  partCount: number;
};

export type AisleNode = {
  aisleNum: number;
  label: string;
  sections: Array<SectionNode>;
  partCount: number;
};

export type UnsortedPart = {
  item: InventoryItem;
  rawBin: string;
};

export type AisleHierarchy = {
  aisles: Array<AisleNode>;
  unsorted: { parts: Array<UnsortedPart> };
};

export type WarehouseZone = {
  aisleNum: number;
  sectionNumbers?: Array<number>;
};

export function parseBin(raw: string): ParsedBin | null {
  const m = BIN_RE.exec(raw.trim());
  if (!m) return null;
  const aisle = parseInt(m[1]!, 10);
  const section = parseInt(m[2]!, 10);
  const position = parseInt(m[3]!, 10);
  return { raw: raw.trim(), aisle, section, shelfHundreds: Math.floor(position / 100), position };
}

/**
 * Fold a flat inventory list into the aisle → section → shelf tree the Browse
 * Aisles UI renders.
 *
 * Two passes:
 *   1. Bucket every parsed bin into a nested Map keyed
 *      aisle → section → shelfHundreds.  An item can appear on multiple shelves
 *      because it may have several bin codes; any item whose bins ALL fail to
 *      parse lands in the flat `unsorted` list instead.  Using Maps (not arrays)
 *      here gives O(1) bucket lookup regardless of warehouse size and keeps
 *      insertion order irrelevant — the second pass imposes the display order.
 *   2. Materialise the Maps into sorted node arrays with the labels/counts the
 *      UI needs.
 *
 * Part counts are computed with Sets of item.id (not raw part totals) so a part
 * sitting in two shelves/sections of the same aisle is counted once per aisle
 * and once per section — the badge shows distinct parts, not bin occurrences.
 */
export function buildAisleHierarchy(inventory: Array<InventoryItem>): AisleHierarchy {
  // Nested bucket map: aisleNum → sectionNum → shelfHundreds → parts on that shelf.
  const aisleMap = new Map<number, Map<number, Map<number, Array<PartOnShelf>>>>();
  const unsorted: Array<UnsortedPart> = [];

  // ── Pass 1: bucket each valid bin into the nested map ──────────────────────
  for (const item of inventory) {
    const bins = item.binLocations ?? [];
    let hasValid = false;
    for (const raw of bins) {
      const parsed = parseBin(raw);
      if (!parsed) continue; // skip malformed bins; item still eligible via its other bins
      hasValid = true;
      // Lazily create each level of the nested map on first use.
      if (!aisleMap.has(parsed.aisle)) aisleMap.set(parsed.aisle, new Map());
      const secMap = aisleMap.get(parsed.aisle)!;
      if (!secMap.has(parsed.section)) secMap.set(parsed.section, new Map());
      const shelfMap = secMap.get(parsed.section)!;
      if (!shelfMap.has(parsed.shelfHundreds)) shelfMap.set(parsed.shelfHundreds, []);
      shelfMap.get(parsed.shelfHundreds)!.push({ item, bin: parsed });
    }
    // No parseable bin at all → the part has no shelf home; surface it separately
    // so it is never silently dropped from the Browse view.
    if (!hasValid) unsorted.push({ item, rawBin: bins[0] ?? "" });
  }

  // ── Pass 2: flatten the maps into sorted, labelled nodes ───────────────────
  const aisles: Array<AisleNode> = [];
  for (const [aisleNum, secMap] of aisleMap) {
    const sections: Array<SectionNode> = [];
    const aisleIds = new Set<number>(); // distinct part ids across the whole aisle
    for (const [sectionNum, shelfMap] of secMap) {
      const shelves: Array<ShelfNode> = [];
      const secIds = new Set<number>(); // distinct part ids within this section
      for (const [shelfHundreds, parts] of shelfMap) {
        // Within a shelf, order by walking position ascending; ties broken by
        // item.id so the ordering is deterministic across renders/sessions.
        const sorted = [...parts].sort((a, b) =>
          a.bin.position !== b.bin.position
            ? a.bin.position - b.bin.position
            : a.item.id - b.item.id,
        );
        sorted.forEach(p => { secIds.add(p.item.id); aisleIds.add(p.item.id); });
        // Shelf label is the hundreds tier zero-padded to 3 digits (0→"000",
        // 2→"200") to mirror the PPP field of the bin code.
        shelves.push({ shelfHundreds, label: `Shelf ${String(shelfHundreds * 100).padStart(3, "0")}`, parts: sorted });
      }
      // Shelves display top-down (highest tier first) — matches how a worker
      // reads a physical rack, so sort shelfHundreds descending.
      shelves.sort((a, b) => b.shelfHundreds - a.shelfHundreds);
      sections.push({
        sectionNum,
        label: `Section ${String(sectionNum).padStart(2, "0")}`,
        shelves,
        partCount: secIds.size,
      });
    }
    // Sections and aisles both display in natural ascending numeric order.
    sections.sort((a, b) => a.sectionNum - b.sectionNum);
    aisles.push({
      aisleNum,
      label: `Aisle ${String(aisleNum).padStart(2, "0")}`,
      sections,
      partCount: aisleIds.size,
    });
  }
  aisles.sort((a, b) => a.aisleNum - b.aisleNum);

  return { aisles, unsorted: { parts: unsorted } };
}

export function filterSections(
  sections: Array<SectionNode>,
  sectionNumbers?: Array<number>,
): Array<SectionNode> {
  if (sectionNumbers && sectionNumbers.length > 0) {
    return sections.filter(s => sectionNumbers.includes(s.sectionNum));
  }
  return sections;
}
