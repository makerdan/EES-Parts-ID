/**
 * Pure utility that builds the Browse-by-Aisle hierarchy
 * (Aisle → Section → Shelf → Parts) from a flat list of `InventoryItem`s.
 *
 * Bin-string format is `AA-SS-SHP` where:
 *   AA  = 2-digit aisle
 *   SS  = 2-digit section
 *   SHP = 3-digit "shelf + position"
 *           hundreds digit = shelf bucket (0..9 → 0, 100, 200, … 900)
 *           last two digits = position on the shelf, left-to-right
 *
 * Bins that don't match the pattern are bucketed under a single "Unsorted"
 * aisle at the bottom of the list (no further drill-down).
 *
 * Counts at every level are distinct-part counts (a part with multiple bins
 * under the same aisle is counted once for that aisle), and a part with
 * multiple bins shows up under every matching shelf.
 *
 * Lives in its own file (no React Native imports) so it's unit-testable in
 * the node Jest environment.
 */
import type { InventoryItem } from '@workspace/api-client-react';

export interface ParsedBin {
  raw: string;
  aisle: string; // "17"
  section: string; // "06"
  shelfHundreds: number; // 0, 100, 200, … 900
  position: number; // 0..99 (left-to-right on the shelf)
}

const BIN_PATTERN = /^(\d{2})-(\d{2})-(\d{3})$/;

/** Parse a single bin string. Returns null when the bin doesn't match `AA-SS-SHP`. */
export function parseBin(raw: string): ParsedBin | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const m = BIN_PATTERN.exec(trimmed);
  if (!m) return null;
  const [, aisle, section, shp] = m as unknown as [string, string, string, string];
  const hundreds = parseInt(shp[0]!, 10);
  const position = parseInt(shp.slice(1), 10);
  return {
    raw: trimmed,
    aisle,
    section,
    shelfHundreds: hundreds * 100,
    position,
  };
}

export interface PartOnShelf {
  item: InventoryItem;
  bin: string;
  position: number;
}

export interface ShelfNode {
  shelfHundreds: number; // 0, 100, … 900
  label: string; // "Shelf 900"
  partCount: number; // distinct parts on this shelf
  parts: PartOnShelf[]; // ordered by position ASC
}

export interface SectionNode {
  section: string; // "06"
  label: string; // "Section 06"
  partCount: number; // distinct parts in this section
  shelves: ShelfNode[]; // ordered by shelfHundreds DESC
}

export interface AisleNode {
  aisle: string; // "17"
  label: string; // "Aisle 17"
  partCount: number; // distinct parts in this aisle
  sections: SectionNode[]; // ordered numerically ASC
}

export interface UnsortedNode {
  label: 'Unsorted';
  partCount: number; // distinct parts that have at least one non-conforming bin
  parts: InventoryItem[]; // flat list, no further drill-down
}

export interface AisleHierarchy {
  aisles: AisleNode[]; // ordered numerically ASC
  unsorted: UnsortedNode | null;
}

/**
 * Build the Aisle → Section → Shelf → Parts hierarchy from a flat inventory
 * list. A part with multiple bins appears under every matching node.
 */
export function buildAisleHierarchy(items: readonly InventoryItem[]): AisleHierarchy {
  // aisleKey → sectionKey → shelfHundreds → array of { item, bin, position }
  const aisleMap = new Map<string, Map<string, Map<number, PartOnShelf[]>>>();
  const unsortedItems = new Map<number, InventoryItem>();

  for (const item of items) {
    const bins = item.binLocations ?? [];
    if (bins.length === 0) continue;
    let hasParsedBin = false;
    for (const rawBin of bins) {
      const parsed = parseBin(rawBin);
      if (!parsed) continue;
      hasParsedBin = true;
      let sections = aisleMap.get(parsed.aisle);
      if (!sections) {
        sections = new Map();
        aisleMap.set(parsed.aisle, sections);
      }
      let shelves = sections.get(parsed.section);
      if (!shelves) {
        shelves = new Map();
        sections.set(parsed.section, shelves);
      }
      let shelfParts = shelves.get(parsed.shelfHundreds);
      if (!shelfParts) {
        shelfParts = [];
        shelves.set(parsed.shelfHundreds, shelfParts);
      }
      shelfParts.push({ item, bin: parsed.raw, position: parsed.position });
    }
    // A part with at least one non-conforming bin AND no conforming bins
    // belongs in Unsorted. If it has any conforming bin, we keep it out of
    // Unsorted (the conforming bin already places it correctly).
    if (!hasParsedBin) {
      unsortedItems.set(item.id, item);
    }
  }

  // Materialize sorted tree
  const aisles: AisleNode[] = [];
  const aisleKeys = Array.from(aisleMap.keys()).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  for (const aisleKey of aisleKeys) {
    const sectionsMap = aisleMap.get(aisleKey)!;
    const sections: SectionNode[] = [];
    const distinctAisleIds = new Set<number>();
    const sectionKeys = Array.from(sectionsMap.keys()).sort(
      (a, b) => parseInt(a, 10) - parseInt(b, 10)
    );
    for (const sectionKey of sectionKeys) {
      const shelvesMap = sectionsMap.get(sectionKey)!;
      const shelves: ShelfNode[] = [];
      const distinctSectionIds = new Set<number>();
      const shelfKeys = Array.from(shelvesMap.keys()).sort((a, b) => b - a);
      for (const hundreds of shelfKeys) {
        const partsArr = shelvesMap.get(hundreds)!;
        // Sort by position ascending (left-to-right). Ties broken by id for stability.
        const sortedParts = [...partsArr].sort((a, b) => {
          if (a.position !== b.position) return a.position - b.position;
          return a.item.id - b.item.id;
        });
        const distinctShelfIds = new Set<number>();
        for (const p of sortedParts) {
          distinctShelfIds.add(p.item.id);
          distinctSectionIds.add(p.item.id);
          distinctAisleIds.add(p.item.id);
        }
        shelves.push({
          shelfHundreds: hundreds,
          label: `Shelf ${hundreds}`,
          partCount: distinctShelfIds.size,
          parts: sortedParts,
        });
      }
      sections.push({
        section: sectionKey,
        label: `Section ${sectionKey}`,
        partCount: distinctSectionIds.size,
        shelves,
      });
    }
    aisles.push({
      aisle: aisleKey,
      label: `Aisle ${aisleKey}`,
      partCount: distinctAisleIds.size,
      sections,
    });
  }

  const unsorted: UnsortedNode | null =
    unsortedItems.size > 0
      ? {
          label: 'Unsorted',
          partCount: unsortedItems.size,
          parts: Array.from(unsortedItems.values()).sort((a, b) => a.id - b.id),
        }
      : null;

  return { aisles, unsorted };
}
