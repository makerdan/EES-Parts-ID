export type InventoryOrderField = "orderPurchase" | "orderQuantity";

export function makeInventoryItemFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    vendor: "ACME",
    catalog: "W-999",
    orderPurchase: 5,
    orderQuantity: 10,
    description: "Test widget",
    binLocations: ["A1"],
    aiKeywords: ["widget"],
    barcodes: ["012345678901"],
    enrichedAt: null,
    imageUrl: null,
    thumbnailUrl: null,
    imageUrl2: null,
    thumbnailUrl2: null,
    expandedDescription: null,
    size: null,
    dimensions: null,
    createdAt: new Date("2025-06-01T00:00:00Z"),
    updatedAt: new Date("2025-06-01T00:00:00Z"),
    ...overrides,
  };
}

export function makeInventoryItemMissingOrderField(field: InventoryOrderField) {
  const item = makeInventoryItemFixture();
  delete item[field];
  return item;
}

export function makeSearchResultFixture(
  item = makeInventoryItemFixture(),
  variants = [makeInventoryItemFixture({ id: 43, catalog: "W-1000" })],
) {
  return {
    item,
    confidence: 0.95,
    matchReason: "catalog match",
    seriesBase: null,
    seriesLabel: null,
    variants,
  };
}

export function makeListInventoryResponseFixture(
  item = makeInventoryItemFixture(),
) {
  return {
    items: [item],
    total: 1,
    page: 1,
    limit: 50,
  };
}

export function makeSearchInventoryResponseFixture(
  item = makeInventoryItemFixture(),
) {
  return {
    results: [makeSearchResultFixture(item)],
    totalMatches: 1,
    belowThreshold: 0,
    sizeUnknownResults: [],
    sizeUnknownCount: 0,
  };
}