/**
 * @jest-environment node
 *
 * Unit tests for the section-pinning logic used by the "Map it!" feature.
 *
 * Tests two concerns:
 *
 * 1. parseBin + pinnedSections — given a list of PinnedPart bin codes, the
 *    computation that builds `Map<aisleNum, number[]>` (used in map.tsx as
 *    `pinnedSections`) correctly extracts distinct section numbers per aisle.
 *
 * 2. pinnedZoneIds — given `pinnedSections` and a list of WarehouseZone-shaped
 *    objects, the IDs of zones whose (aisleId, sectionNum) match a pinned
 *    section are included in the result set.
 *
 * These pure-logic exercises mirror what map.tsx does inside its useMemo
 * callbacks, giving us a regression guard that doesn't require mounting any
 * React component.
 *
 * Regression scenario (part 2110, bin 18-02-901):
 *   Before the data fix: zone with label "02" had section_num=1, and the zone
 *   with section_num=2 had label "28" → wrong zone highlighted.
 *   After the fix: zone label "02" has section_num=2 → correct zone highlighted.
 */

import { parseBin } from "@/lib/aisleHierarchy";

// ── Helpers that mirror map.tsx useMemo logic ─────────────────────────────────

interface PinnedPart {
  binCode: string;
  aisleNum: number;
  variant?: boolean;
}

function buildPinnedSections(pinnedParts: PinnedPart[]): Map<number, number[]> {
  const m = new Map<number, number[]>();
  for (const p of pinnedParts) {
    if (p.variant) continue;
    const parsed = parseBin(p.binCode);
    if (!parsed) continue;
    const secs = m.get(p.aisleNum) ?? [];
    if (!secs.includes(parsed.section)) secs.push(parsed.section);
    m.set(p.aisleNum, secs);
  }
  return m;
}

interface ZoneLike {
  id: number;
  aisleId: string;
  sectionNum: number;
}

function buildPinnedZoneIds(zones: ZoneLike[], pinnedSections: Map<number, number[]>): Set<number> {
  const ids = new Set<number>();
  for (const zone of zones) {
    const aisleNum = parseInt(zone.aisleId, 10);
    const sections = pinnedSections.get(aisleNum);
    if (sections && sections.includes(zone.sectionNum)) ids.add(zone.id);
  }
  return ids;
}

// ── parseBin ──────────────────────────────────────────────────────────────────

describe("parseBin — section extraction", () => {
  it("correctly parses section 02 from '18-02-901'", () => {
    const parsed = parseBin("18-02-901");
    expect(parsed).not.toBeNull();
    expect(parsed!.aisle).toBe(18);
    expect(parsed!.section).toBe(2);
    expect(parsed!.position).toBe(901);
  });

  it("correctly parses section 27 from '18-27-001'", () => {
    const parsed = parseBin("18-27-001");
    expect(parsed).not.toBeNull();
    expect(parsed!.aisle).toBe(18);
    expect(parsed!.section).toBe(27);
  });
});

// ── pinnedSections ────────────────────────────────────────────────────────────

describe("buildPinnedSections — section mapping", () => {
  it("produces pinnedSections.get(18) = [2] for a single bin '18-02-901'", () => {
    const pins: PinnedPart[] = [{ binCode: "18-02-901", aisleNum: 18 }];
    const pinnedSections = buildPinnedSections(pins);
    expect(pinnedSections.get(18)).toEqual([2]);
  });

  it("produces pinnedSections.get(18) = [2, 27] for bins ['18-02-901', '18-27-001']", () => {
    const pins: PinnedPart[] = [
      { binCode: "18-02-901", aisleNum: 18 },
      { binCode: "18-27-001", aisleNum: 18 },
    ];
    const pinnedSections = buildPinnedSections(pins);
    expect(pinnedSections.get(18)).toEqual([2, 27]);
  });

  it("deduplicates sections when two bins share the same section", () => {
    const pins: PinnedPart[] = [
      { binCode: "18-02-901", aisleNum: 18 },
      { binCode: "18-02-100", aisleNum: 18 },
    ];
    const pinnedSections = buildPinnedSections(pins);
    expect(pinnedSections.get(18)).toEqual([2]);
  });

  it("does not include variant pins in pinnedSections", () => {
    const pins: PinnedPart[] = [
      { binCode: "18-02-901", aisleNum: 18 },
      { binCode: "18-27-001", aisleNum: 18, variant: true },
    ];
    const pinnedSections = buildPinnedSections(pins);
    expect(pinnedSections.get(18)).toEqual([2]);
  });
});

// ── pinnedZoneIds (regression: part 2110, aisle 18, section 02) ───────────────

describe("buildPinnedZoneIds — regression: part 2110 highlights correct zone", () => {
  // Mirrors the zone data for aisle 18 AFTER the section_num data fix:
  //   zone 672: label "02", section_num = 2  (the correct zone for bin 18-02-901)
  //   zone 716: label "27", section_num = 27
  //
  // Before the data fix, zone 672 had section_num=1 and zone 673 had
  // section_num=2 (label "28") — causing the wrong zone to highlight.
  const zones: ZoneLike[] = [
    { id: 672, aisleId: "18", sectionNum: 2 },  // label "02" — correct target
    { id: 673, aisleId: "18", sectionNum: 28 }, // label "28" — old erroneous match
    { id: 716, aisleId: "18", sectionNum: 27 }, // label "27"
  ];

  it("includes the section-02 zone (id=672) in pinnedZoneIds for bin '18-02-901'", () => {
    const pins: PinnedPart[] = [{ binCode: "18-02-901", aisleNum: 18 }];
    const pinnedSections = buildPinnedSections(pins);
    const pinnedZoneIds = buildPinnedZoneIds(zones, pinnedSections);

    expect(pinnedZoneIds.has(672)).toBe(true);
  });

  it("does NOT include the section-28 zone (id=673) for bin '18-02-901' (regression guard)", () => {
    const pins: PinnedPart[] = [{ binCode: "18-02-901", aisleNum: 18 }];
    const pinnedSections = buildPinnedSections(pins);
    const pinnedZoneIds = buildPinnedZoneIds(zones, pinnedSections);

    expect(pinnedZoneIds.has(673)).toBe(false);
  });

  it("highlights both section-02 and section-27 zones when bins are ['18-02-901', '18-27-001']", () => {
    const pins: PinnedPart[] = [
      { binCode: "18-02-901", aisleNum: 18 },
      { binCode: "18-27-001", aisleNum: 18 },
    ];
    const pinnedSections = buildPinnedSections(pins);
    const pinnedZoneIds = buildPinnedZoneIds(zones, pinnedSections);

    expect(pinnedZoneIds.has(672)).toBe(true);  // section 02
    expect(pinnedZoneIds.has(716)).toBe(true);  // section 27
    expect(pinnedZoneIds.has(673)).toBe(false); // section 28 — must not be lit
  });
});
