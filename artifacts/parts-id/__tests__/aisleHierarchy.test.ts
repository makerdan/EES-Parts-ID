/**
 * @jest-environment node
 *
 * Unit tests for the Browse-by-Aisle hierarchy builder.
 */
import type { InventoryItem } from '@workspace/api-client-react';
import { buildAisleHierarchy, parseBin } from '../lib/aisleHierarchy';

function makeItem(
  overrides: Partial<InventoryItem> & { id: number; binLocations: string[] }
): InventoryItem {
  return {
    id: overrides.id,
    vendor: overrides.vendor ?? 'ETN',
    catalog: overrides.catalog ?? `CAT${overrides.id}`,
    description: overrides.description ?? '',
    binLocations: overrides.binLocations,
    aiKeywords: overrides.aiKeywords ?? [],
    vendorFullName: overrides.vendorFullName ?? null,
    enrichedAt: overrides.enrichedAt ?? null,
    createdAt: overrides.createdAt ?? '2024-01-01T00:00:00Z',
    updatedAt: overrides.updatedAt ?? '2024-01-01T00:00:00Z',
  };
}

describe('parseBin', () => {
  it('parses a well-formed AA-SS-SHP bin', () => {
    expect(parseBin('17-06-907')).toEqual({
      raw: '17-06-907',
      aisle: '17',
      section: '06',
      shelfHundreds: 900,
      position: 7,
    });
  });

  it('trims surrounding whitespace', () => {
    expect(parseBin('  08-02-103  ')).toEqual({
      raw: '08-02-103',
      aisle: '08',
      section: '02',
      shelfHundreds: 100,
      position: 3,
    });
  });

  it('treats leading-zero shelf hundreds (0xx) as Shelf 0', () => {
    expect(parseBin('00-00-042')).toEqual({
      raw: '00-00-042',
      aisle: '00',
      section: '00',
      shelfHundreds: 0,
      position: 42,
    });
  });

  it('returns null for malformed bins', () => {
    expect(parseBin('17-6-907')).toBeNull();
    expect(parseBin('17-06-9070')).toBeNull();
    expect(parseBin('AA-06-907')).toBeNull();
    expect(parseBin('')).toBeNull();
    expect(parseBin('not-a-bin')).toBeNull();
  });
});

describe('buildAisleHierarchy', () => {
  it('groups single-bin parts under the right aisle/section/shelf', () => {
    const items = [
      makeItem({ id: 1, binLocations: ['17-06-907'] }),
      makeItem({ id: 2, binLocations: ['17-06-915'] }),
      makeItem({ id: 3, binLocations: ['17-08-503'] }),
    ];
    const tree = buildAisleHierarchy(items);
    expect(tree.aisles).toHaveLength(1);
    const a17 = tree.aisles[0]!;
    expect(a17.label).toBe('Aisle 17');
    expect(a17.partCount).toBe(3);
    expect(a17.sections.map((s) => s.label)).toEqual(['Section 06', 'Section 08']);
    const s06 = a17.sections[0]!;
    expect(s06.partCount).toBe(2);
    expect(s06.shelves[0]!.label).toBe('Shelf 900');
    expect(s06.shelves[0]!.partCount).toBe(2);
    expect(s06.shelves[0]!.parts.map((p) => p.item.id)).toEqual([1, 2]);
  });

  it('sorts aisles and sections numerically ASC and shelves by hundreds DESC', () => {
    const items = [
      makeItem({ id: 1, binLocations: ['08-02-101'] }),
      makeItem({ id: 2, binLocations: ['32-10-901'] }),
      makeItem({ id: 3, binLocations: ['17-06-501'] }),
      makeItem({ id: 4, binLocations: ['17-06-901'] }),
      makeItem({ id: 5, binLocations: ['17-06-001'] }),
      makeItem({ id: 6, binLocations: ['17-01-101'] }),
    ];
    const tree = buildAisleHierarchy(items);
    expect(tree.aisles.map((a) => a.aisle)).toEqual(['08', '17', '32']);
    const a17 = tree.aisles.find((a) => a.aisle === '17')!;
    expect(a17.sections.map((s) => s.section)).toEqual(['01', '06']);
    const s06 = a17.sections.find((s) => s.section === '06')!;
    expect(s06.shelves.map((s) => s.shelfHundreds)).toEqual([900, 500, 0]);
  });

  it('orders parts on a shelf by position ASC (left-to-right)', () => {
    const items = [
      makeItem({ id: 1, binLocations: ['17-06-915'] }),
      makeItem({ id: 2, binLocations: ['17-06-902'] }),
      makeItem({ id: 3, binLocations: ['17-06-907'] }),
    ];
    const tree = buildAisleHierarchy(items);
    const shelf = tree.aisles[0]!.sections[0]!.shelves[0]!;
    expect(shelf.parts.map((p) => p.position)).toEqual([2, 7, 15]);
    expect(shelf.parts.map((p) => p.item.id)).toEqual([2, 3, 1]);
  });

  it('places multi-bin parts under every matching shelf and counts them once per node', () => {
    const items = [
      makeItem({ id: 1, binLocations: ['17-06-907', '08-02-105'] }),
      makeItem({ id: 2, binLocations: ['17-06-908'] }),
    ];
    const tree = buildAisleHierarchy(items);
    expect(tree.aisles.map((a) => a.aisle)).toEqual(['08', '17']);
    const a08 = tree.aisles[0]!;
    const a17 = tree.aisles[1]!;
    expect(a08.partCount).toBe(1);
    expect(a17.partCount).toBe(2);
    const a17Shelf = a17.sections[0]!.shelves[0]!;
    expect(a17Shelf.parts.map((p) => p.item.id)).toEqual([1, 2]);
    expect(a17Shelf.partCount).toBe(2);
  });

  it('counts a part once at the aisle level even when it has multiple bins in that aisle', () => {
    const items = [makeItem({ id: 1, binLocations: ['17-06-907', '17-08-101'] })];
    const tree = buildAisleHierarchy(items);
    expect(tree.aisles[0]!.partCount).toBe(1);
    expect(tree.aisles[0]!.sections.map((s) => s.partCount)).toEqual([1, 1]);
  });

  it("buckets parts whose bins don't match the pattern under Unsorted", () => {
    const items = [
      makeItem({ id: 1, binLocations: ['WAREHOUSE-A'] }),
      makeItem({ id: 2, binLocations: ['17-06-907'] }),
      makeItem({ id: 3, binLocations: ['???'] }),
    ];
    const tree = buildAisleHierarchy(items);
    expect(tree.aisles).toHaveLength(1);
    expect(tree.unsorted).not.toBeNull();
    expect(tree.unsorted!.partCount).toBe(2);
    expect(tree.unsorted!.parts.map((i) => i.id)).toEqual([1, 3]);
  });

  it('does NOT add a part to Unsorted if it has at least one conforming bin', () => {
    const items = [makeItem({ id: 1, binLocations: ['LEGACY-A1', '17-06-907'] })];
    const tree = buildAisleHierarchy(items);
    expect(tree.unsorted).toBeNull();
    expect(tree.aisles[0]!.partCount).toBe(1);
  });

  it("ignores parts with no bins at all (they don't appear anywhere)", () => {
    const items = [
      makeItem({ id: 1, binLocations: [] }),
      makeItem({ id: 2, binLocations: ['17-06-907'] }),
    ];
    const tree = buildAisleHierarchy(items);
    expect(tree.aisles[0]!.partCount).toBe(1);
    expect(tree.unsorted).toBeNull();
  });

  it('returns an empty tree for an empty input', () => {
    expect(buildAisleHierarchy([])).toEqual({ aisles: [], unsorted: null });
  });
});
