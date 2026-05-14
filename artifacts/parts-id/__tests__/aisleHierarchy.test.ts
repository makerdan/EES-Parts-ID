/**
 * @jest-environment node
 */
import {
  parseBin,
  buildAisleHierarchy,
  filterSections,
} from "../lib/aisleHierarchy";
import type { InventoryItem } from "@workspace/api-client-react";

function makeItem(id: number, bins: string[]): InventoryItem {
  return {
    id,
    vendor: "Test",
    catalog: `CAT-${id}`,
    description: `Item ${id}`,
    binLocations: bins,
    aiKeywords: [],
    enrichedAt: null,
  } as unknown as InventoryItem;
}

describe("parseBin", () => {
  it("parses a valid bin code", () => {
    const p = parseBin("08-04-503");
    expect(p).toEqual({ raw: "08-04-503", aisle: 8, section: 4, shelfHundreds: 5, position: 503 });
  });

  it("returns null for malformed codes", () => {
    expect(parseBin("A1-04")).toBeNull();
    expect(parseBin("08-04")).toBeNull();
    expect(parseBin("8-4-503")).toBeNull();
    expect(parseBin("")).toBeNull();
    expect(parseBin("08-04-503x")).toBeNull();
  });

  it("trims whitespace", () => {
    expect(parseBin(" 08-04-503 ")?.raw).toBe("08-04-503");
  });

  it("computes shelfHundreds correctly", () => {
    expect(parseBin("00-00-099")?.shelfHundreds).toBe(0);
    expect(parseBin("00-00-100")?.shelfHundreds).toBe(1);
    expect(parseBin("00-00-900")?.shelfHundreds).toBe(9);
    expect(parseBin("00-00-999")?.shelfHundreds).toBe(9);
  });
});

describe("buildAisleHierarchy", () => {
  it("groups items into aisle → section → shelf", () => {
    const inventory = [
      makeItem(1, ["08-04-503"]),
      makeItem(2, ["08-04-505"]),
      makeItem(3, ["08-05-601"]),
      makeItem(4, ["14-02-301"]),
    ];
    const { aisles, unsorted } = buildAisleHierarchy(inventory);

    expect(aisles).toHaveLength(2);
    expect(aisles[0]!.aisleNum).toBe(8);
    expect(aisles[1]!.aisleNum).toBe(14);
    expect(unsorted.parts).toHaveLength(0);

    const aisle8 = aisles[0]!;
    expect(aisle8.sections).toHaveLength(2);
    expect(aisle8.sections[0]!.sectionNum).toBe(4);
    expect(aisle8.sections[1]!.sectionNum).toBe(5);

    const sec4 = aisle8.sections[0]!;
    expect(sec4.shelves).toHaveLength(1);
    expect(sec4.shelves[0]!.shelfHundreds).toBe(5);
    expect(sec4.shelves[0]!.parts).toHaveLength(2);
    expect(sec4.shelves[0]!.parts[0]!.item.id).toBe(1);
    expect(sec4.shelves[0]!.parts[1]!.item.id).toBe(2);
  });

  it("places items with no valid bin in unsorted", () => {
    const inventory = [
      makeItem(1, ["bad-bin"]),
      makeItem(2, []),
      makeItem(3, ["08-04-503"]),
    ];
    const { unsorted } = buildAisleHierarchy(inventory);
    expect(unsorted.parts).toHaveLength(2);
    expect(unsorted.parts.map(p => p.item.id).sort()).toEqual([1, 2]);
  });

  it("places item in multiple bins if it has several valid locations", () => {
    const item = makeItem(1, ["08-04-503", "14-02-301"]);
    const { aisles } = buildAisleHierarchy([item]);
    expect(aisles).toHaveLength(2);
    expect(aisles[0]!.partCount).toBe(1);
    expect(aisles[1]!.partCount).toBe(1);
  });

  it("counts distinct parts correctly (item in 2 bins in same aisle counted once)", () => {
    const item = makeItem(1, ["08-04-503", "08-05-601"]);
    const { aisles } = buildAisleHierarchy([item]);
    expect(aisles[0]!.partCount).toBe(1);
  });

  it("sorts sections numerically ASC and shelves DESC by shelfHundreds", () => {
    const inventory = [
      makeItem(1, ["08-10-901"]),
      makeItem(2, ["08-10-101"]),
      makeItem(3, ["08-01-501"]),
    ];
    const { aisles } = buildAisleHierarchy(inventory);
    const aisle8 = aisles[0]!;
    expect(aisle8.sections[0]!.sectionNum).toBe(1);
    expect(aisle8.sections[1]!.sectionNum).toBe(10);
    const sec10 = aisle8.sections[1]!;
    expect(sec10.shelves[0]!.shelfHundreds).toBe(9);
    expect(sec10.shelves[1]!.shelfHundreds).toBe(1);
  });

  it("sorts parts within a shelf by position ASC, then id ASC", () => {
    const inventory = [
      makeItem(3, ["08-04-505"]),
      makeItem(1, ["08-04-501"]),
      makeItem(2, ["08-04-501"]),
    ];
    const { aisles } = buildAisleHierarchy(inventory);
    const parts = aisles[0]!.sections[0]!.shelves[0]!.parts;
    expect(parts[0]!.item.id).toBe(1);
    expect(parts[1]!.item.id).toBe(2);
    expect(parts[2]!.item.id).toBe(3);
  });
});

describe("filterSections", () => {
  const sections = [
    { sectionNum: 1, label: "Section 01", shelves: [], partCount: 0 },
    { sectionNum: 2, label: "Section 02", shelves: [], partCount: 0 },
    { sectionNum: 3, label: "Section 03", shelves: [], partCount: 0 },
    { sectionNum: 4, label: "Section 04", shelves: [], partCount: 0 },
  ];

  it("returns all sections when no filter", () => {
    expect(filterSections(sections)).toHaveLength(4);
  });

  it("filters by sectionNumbers (takes precedence)", () => {
    const result = filterSections(sections, [1, 3], "even");
    expect(result.map(s => s.sectionNum)).toEqual([1, 3]);
  });

  it("filters by sectionParity odd", () => {
    expect(filterSections(sections, undefined, "odd").map(s => s.sectionNum)).toEqual([1, 3]);
  });

  it("filters by sectionParity even", () => {
    expect(filterSections(sections, undefined, "even").map(s => s.sectionNum)).toEqual([2, 4]);
  });
});
