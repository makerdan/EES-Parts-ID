/**
 * Every response family that returns InventoryItem must enforce the same
 * required order fields. These fixtures intentionally exercise nested search
 * results, variants, and size-unknown results rather than only the top-level
 * item shape.
 */

const mockSelect = jest.fn();
const mockExecute = jest.fn();
const mockLimiterCheck = jest.fn();
let routeTestMode: "list" | "search" = "list";
let mockedInventoryRows: Array<Record<string, unknown>> = [];
let searchDictionariesServed = false;
let searchDictionarySelectCount = 0;

function makeQuery(result: unknown[]) {
  const query = {
    from: jest.fn(),
    where: jest.fn(),
    limit: jest.fn(),
    offset: jest.fn(),
    orderBy: jest.fn(),
    then: undefined as unknown,
  };

  query.from.mockReturnValue(query);
  query.where.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  query.offset.mockReturnValue(query);
  query.orderBy.mockReturnValue(query);
  query.then = (
    resolve: (value: unknown[]) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);

  return query;
}

jest.mock("@workspace/db", () => ({
  db: {
    select: mockSelect,
    execute: mockExecute,
  },
  inventoryTable: {},
  misspellingMapTable: {},
  abbreviationMapTable: {},
  vendorMapTable: {},
  synonymMapTable: {},
  electricalSlangMapTable: {},
  inventoryFtsVector: {},
  measureEnrichJobTable: {},
  collectKeywords: jest.fn(() => ["widget"]),
  findNodeBySlug: jest.fn(() => ({ slug: "receptacles" })),
  getAllTaxonomyKeywords: jest.fn(() => []),
  TAXONOMY: [],
}));

jest.mock("../lib/rateLimiter", () => ({
  inventorySearchLimiter: { check: mockLimiterCheck },
  identifyLimiter: { check: mockLimiterCheck },
  translateLimiter: { check: mockLimiterCheck },
  partCardLimiter: { check: mockLimiterCheck },
  referenceAskLimiter: { check: mockLimiterCheck },
  helpAskLimiter: { check: mockLimiterCheck },
  catalogPdfUploadLimiter: { check: mockLimiterCheck },
  adminQueryLimiter: { check: mockLimiterCheck },
  contactLimiter: { check: mockLimiterCheck },
  screenViewLimiter: { check: mockLimiterCheck },
}));

jest.mock("../middlewares/requireAppAuth", () => ({
  requireAppAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock("../middlewares/requireAdminAuth", () => ({
  requireAdminAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: { completions: { create: jest.fn() } },
    audio: { transcriptions: { create: jest.fn() } },
  },
  generateImageBuffer: jest.fn(),
  editImages: jest.fn(),
  batchProcess: jest.fn(),
  batchProcessWithSSE: jest.fn(),
  isRateLimitError: jest.fn(() => false),
}));

jest.mock("@workspace/integrations-openai-ai-server/batch", () => ({
  batchProcess: jest.fn(),
  batchProcessWithSSE: jest.fn(),
  isRateLimitError: jest.fn(() => false),
}));

jest.mock("../lib/answerCache", () => ({
  invalidateReferenceAnswerCache: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../lib/objectStorage", () => ({
  deletePrivateObjects: jest.fn().mockResolvedValue(undefined),
  isPrivateObjectPath: jest.fn(() => false),
  readPrivateObject: jest.fn(),
  uploadCatalogImage: jest.fn(),
}));

jest.mock("../utils/generateKeywords", () => ({
  generateKeywords: jest.fn().mockResolvedValue([]),
  mergeWithPinned: jest.fn(() => []),
}));

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
  makeRawSearchRowFixture,
  makeSearchInventoryResponseFixture,
  makeSearchResultFixture,
  type InventoryOrderField,
} from "./fixtures/inventoryResponseFixtures";

import supertest from "supertest";
import app from "../app";

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

beforeEach(() => {
  jest.clearAllMocks();
  routeTestMode = "list";
  mockedInventoryRows = [];
  searchDictionarySelectCount = 0;
  mockSelect.mockImplementation((selection?: unknown) => {
    if (routeTestMode === "list") {
      return makeQuery(selection !== undefined ? [{ count: "1" }] : mockedInventoryRows);
    }

    if (!searchDictionariesServed && searchDictionarySelectCount < 5) {
      const dictionaryRows = [
        [{ misspelling: "widgit", correction: "widget" }],
        [{ abbreviation: "w", expansions: ["widget"] }],
        [{ code: "ACME", names: ["ACME"] }],
        [{ term: "widget", synonyms: ["widget"] }],
        [{ slangTerm: "widget", standardTerms: ["widget"] }],
      ];
      return makeQuery(dictionaryRows[searchDictionarySelectCount++] ?? []);
    }

    searchDictionariesServed = true;
    return makeQuery(mockedInventoryRows);
  });
  mockExecute.mockResolvedValue({ rows: [] });
  mockLimiterCheck.mockResolvedValue({ allowed: true });
});


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

describe("Inventory list and search route response contracts", () => {
  it.each(["orderPurchase", "orderQuantity"] as const)(
    "GET /api/inventory returns its documented error when a row is missing %s",
    async (field) => {
      routeTestMode = "list";
      mockedInventoryRows = [
        makeInventoryItemMissingOrderField(field) as Record<string, unknown>,
      ];

      const response = await supertest(app).get("/api/inventory");

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: "Failed to list inventory" });
      expect(response.body).not.toHaveProperty(field);
    },
  );

  it.each(["orderPurchase", "orderQuantity"] as const)(
    "POST /api/inventory/search returns its documented error when a row is missing %s",
    async (field) => {
      routeTestMode = "search";
      const primary = makeInventoryItemFixture({
        id: 42,
        vendor: "ACME",
        catalog: "BR15",
        description: "Test widget",
      });
      const malformedVariant = makeInventoryItemMissingOrderField(field, {
        id: 43,
        vendor: "ACME",
        catalog: "BR20",
        description: "Other size",
      });
      mockedInventoryRows = [
        primary,
        malformedVariant as Record<string, unknown>,
      ];
      mockExecute.mockResolvedValueOnce({
        rows: [
          makeRawSearchRowFixture({
            id: primary.id,
            vendor: primary.vendor,
            catalog: primary.catalog,
            description: primary.description,
          }),
        ],
      });

      const response = await supertest(app)
        .post("/api/inventory/search")
        .send({ keywords: "widget" });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: "Search failed" });
      expect(response.body).not.toHaveProperty(field);
    },
  );
});