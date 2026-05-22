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
  parts: PartOnShelf[];
};

export type SectionNode = {
  sectionNum: number;
  label: string;
  shelves: ShelfNode[];
  partCount: number;
};

export type AisleNode = {
  aisleNum: number;
  label: string;
  sections: SectionNode[];
  partCount: number;
};

export type UnsortedPart = {
  item: InventoryItem;
  rawBin: string;
};

export type AisleHierarchy = {
  aisles: AisleNode[];
  unsorted: { parts: UnsortedPart[] };
};

export type WarehouseZone = {
  aisleNum: number;
  sectionNumbers?: number[];
  sectionParity?: "odd" | "even";
  label: string;
};

export function parseBin(raw: string): ParsedBin | null {
  const m = BIN_RE.exec(raw.trim());
  if (!m) return null;
  const aisle = parseInt(m[1]!, 10);
  const section = parseInt(m[2]!, 10);
  const position = parseInt(m[3]!, 10);
  return { raw: raw.trim(), aisle, section, shelfHundreds: Math.floor(position / 100), position };
}

export function buildAisleHierarchy(inventory: InventoryItem[]): AisleHierarchy {
  const aisleMap = new Map<number, Map<number, Map<number, PartOnShelf[]>>>();
  const unsorted: UnsortedPart[] = [];

  for (const item of inventory) {
    const bins = item.binLocations ?? [];
    let hasValid = false;
    for (const raw of bins) {
      const parsed = parseBin(raw);
      if (!parsed) continue;
      hasValid = true;
      if (!aisleMap.has(parsed.aisle)) aisleMap.set(parsed.aisle, new Map());
      const secMap = aisleMap.get(parsed.aisle)!;
      if (!secMap.has(parsed.section)) secMap.set(parsed.section, new Map());
      const shelfMap = secMap.get(parsed.section)!;
      if (!shelfMap.has(parsed.shelfHundreds)) shelfMap.set(parsed.shelfHundreds, []);
      shelfMap.get(parsed.shelfHundreds)!.push({ item, bin: parsed });
    }
    if (!hasValid) unsorted.push({ item, rawBin: bins[0] ?? "" });
  }

  const aisles: AisleNode[] = [];
  for (const [aisleNum, secMap] of aisleMap) {
    const sections: SectionNode[] = [];
    const aisleIds = new Set<number>();
    for (const [sectionNum, shelfMap] of secMap) {
      const shelves: ShelfNode[] = [];
      const secIds = new Set<number>();
      for (const [shelfHundreds, parts] of shelfMap) {
        const sorted = [...parts].sort((a, b) =>
          a.bin.position !== b.bin.position
            ? a.bin.position - b.bin.position
            : a.item.id - b.item.id,
        );
        sorted.forEach(p => { secIds.add(p.item.id); aisleIds.add(p.item.id); });
        shelves.push({ shelfHundreds, label: `Shelf ${String(shelfHundreds * 100).padStart(3, "0")}`, parts: sorted });
      }
      shelves.sort((a, b) => b.shelfHundreds - a.shelfHundreds);
      sections.push({
        sectionNum,
        label: `Section ${String(sectionNum).padStart(2, "0")}`,
        shelves,
        partCount: secIds.size,
      });
    }
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
  sections: SectionNode[],
  sectionNumbers?: number[],
  sectionParity?: "odd" | "even",
): SectionNode[] {
  if (sectionNumbers && sectionNumbers.length > 0) {
    return sections.filter(s => sectionNumbers.includes(s.sectionNum));
  }
  if (sectionParity) {
    // NOTE: section 00 is treated as even (0 % 2 === 0). This is intentional —
    // section zero is a real bin location and even-parity zones should cover it.
    // Do NOT change this to exclude 0 or treat it as "no section"; doing so
    // would silently drop parts stored in section 00 from even-parity zones.
    return sections.filter(s =>
      sectionParity === "odd" ? s.sectionNum % 2 !== 0 : s.sectionNum % 2 === 0,
    );
  }
  return sections;
}
