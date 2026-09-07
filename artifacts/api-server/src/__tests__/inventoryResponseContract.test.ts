/**
 * Every response family that returns InventoryItem must enforce the same
 * required order fields. These fixtures intentionally exercise nested search
 * results, variants, and size-unknown results rather than only the top-level
 * item shape.
 */

import {
  AddPartConflictResponse,
  AddPartResponse,
  ListInventoryResponse,
  LookupByBarcodeResponse,
  ReenrichItemResponse,
  SearchInventoryResponse,
  UpdateItemBarcodesResponse,
  UpdateItemBinsResponse,
  UpdateItemDescriptionResponse,
  UpdateItemDimensionsResponse,
  UpdateItemKeywordsResponse,
  UpdateItemOrderResponse,
  UpdateItemSizeResponse,
} from "@workspace/api-zod";

import {
  makeInventoryItemFixture,
  makeInventoryItemMissingOrderField,
  makeListInventoryResponseFixture,
  makeSearchInventoryResponseFixture,
  makeSearchResultFixture,
  type InventoryOrderField,
} from "./fixtures/inventoryResponseFixtures";

const updateResponseSchemas = {
  UpdateItemBarcodesResponse,
  UpdateItemBinsResponse,
  UpdateItemDescriptionResponse,
  UpdateItemDimensionsResponse,
  UpdateItemKeywordsResponse,
  UpdateItemOrderResponse,
  UpdateItemSizeResponse,
  ReenrichItemResponse,
};

function makeResponseFixture(
  responseName: string,
  field: InventoryOrderField,
) {
  const item = makeInventoryItemMissingOrderField(field);

  switch (responseName) {
    case "AddPartResponse":
      return { item };
    case "AddPartConflictResponse":
      return { error: "Part already exists", existingItem: item };
    case "ListInventoryResponse":
      return makeListInventoryResponseFixture(item);
    case "SearchInventoryResponse": {
      const unknownItem = makeInventoryItemMissingOrderField(field);
      const variant = makeInventoryItemMissingOrderField(field);
      return {
        ...makeSearchInventoryResponseFixture(item),
        results: [makeSearchResultFixture(item, [variant])],
        sizeUnknownResults: [makeSearchResultFixture(unknownItem, [variant])],
        sizeUnknownCount: 1,
      };
    }
    default:
      return item;
  }
}

describe("InventoryItem response contract", () => {
  const envelopeSchemas = {
    AddPartResponse,
    AddPartConflictResponse,
    ListInventoryResponse,
    LookupByBarcodeResponse,
    SearchInventoryResponse,
    ...updateResponseSchemas,
  };

  it.each(Object.entries(envelopeSchemas))(
    "%s accepts a complete reusable fixture",
    (_responseName, schema) => {
      const fixture =
        _responseName === "AddPartResponse"
          ? { item: makeInventoryItemFixture() }
          : _responseName === "AddPartConflictResponse"
            ? { error: "Part already exists", existingItem: makeInventoryItemFixture() }
            : _responseName === "ListInventoryResponse"
              ? makeListInventoryResponseFixture()
              : _responseName === "SearchInventoryResponse"
                ? makeSearchInventoryResponseFixture()
                : makeInventoryItemFixture();

      expect(() => schema.parse(fixture)).not.toThrow();
    },
  );

  it.each(Object.entries(envelopeSchemas))(
    "%s rejects a missing orderPurchase or orderQuantity",
    (responseName, schema) => {
      for (const field of ["orderPurchase", "orderQuantity"] as const) {
        expect(() => schema.parse(makeResponseFixture(responseName, field))).toThrow();
      }
    },
  );
});