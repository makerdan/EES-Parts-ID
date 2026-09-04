import {
  AiCatalogEntrySchema,
  AiCatalogResponseSchema,
  AiDimensionsResponseSchema,
  AiEnrichmentResponseSchema,
  AiIdentifyResponseSchema,
  AiKeywordsResponseSchema,
  AiPartCardResponseSchema,
  AiTranslateResponseSchema,
} from "@workspace/api-zod";

import {
  MalformedAiResponseError,
  parseAiResponse,
  parseAiResponseOr,
} from "../utils/aiHelpers";

const emptyDimensions = {
  length: null,
  width: null,
  height: null,
  diameter: null,
};

describe("shared AI response runtime boundary", () => {
  it.each([
    ["identify", AiIdentifyResponseSchema, { searchTerms: ["breaker"] }],
    ["translate", AiTranslateResponseSchema, { translatedTerms: ["breaker"] }],
    ["part card", AiPartCardResponseSchema, { displayName: "Breaker" }],
    ["dimensions", AiDimensionsResponseSchema, { ...emptyDimensions }],
  ])("returns the safe fallback for malformed %s JSON", (_feature, schema, fallback) => {
    expect(parseAiResponseOr("provider returned prose, not JSON", schema, String(_feature), fallback)).toEqual(fallback);
  });

  it("rejects malformed enrichment instead of allowing persistence callers to continue", () => {
    expect(() =>
      parseAiResponse(
        '{"expandedDescription": "not enough shape"}',
        AiEnrichmentResponseSchema,
        "description enrichment",
      ),
    ).toThrow(MalformedAiResponseError);
  });

  it("rejects a keyword array containing non-string values", () => {
    expect(() =>
      parseAiResponse('["breaker", 120]', AiKeywordsResponseSchema, "keyword enrichment"),
    ).toThrow(MalformedAiResponseError);
  });

  it("validates catalogue entries independently so malformed entries are discarded", () => {
    const response = AiCatalogResponseSchema.parse([
      { catalogNumber: "BR120", description: "Breaker", confidence: 0.9 },
      { catalogNumber: 120, description: "Malformed", confidence: 0.8 },
    ]);

    const validEntries = response
      .map((entry) => AiCatalogEntrySchema.safeParse(entry))
      .filter((result) => result.success)
      .map((result) => result.data);

    expect(validEntries).toHaveLength(1);
    expect(validEntries[0]?.catalogNumber).toBe("BR120");
  });
});