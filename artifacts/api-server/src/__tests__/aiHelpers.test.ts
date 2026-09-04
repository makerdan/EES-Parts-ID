/**
 * Unit tests for extractJsonFromText's non-object guard.
 *
 * extractJsonFromText must return null whenever JSON.parse produces a value
 * that is not a plain non-null object (array or primitive), because those
 * values pass an unchecked `as Record<string, unknown>` cast but fail at
 * use-time downstream.  A valid object must still be returned unchanged.
 */

import {
  extractJsonFromText,
  MalformedAiResponseError,
} from "../utils/aiHelpers";
import { createAiHelpersMock } from "../../__tests__/helpers/aiHelpersMock";

describe("createAiHelpersMock", () => {
  it("preserves real exports and supports an estimateImageBytes override", () => {
    const actual = jest.requireActual("../utils/aiHelpers") as typeof import("../utils/aiHelpers");
    const mocked = createAiHelpersMock(actual, { estimateImageBytes: 1234 });

    expect(mocked.MalformedAiResponseError).toBe(MalformedAiResponseError);
    expect(mocked.checkImagePayloadSize).toBe(actual.checkImagePayloadSize);
    expect(mocked.estimateImageBytes("ignored")).toBe(1234);
  });
});

describe("extractJsonFromText", () => {
  // Mutation-proof: the input parses to a valid JS array, so this case only
  // returns null because of the post-parse `Array.isArray(parsed)` guard.
  // Removing that guard makes this test fail (the array would be returned).
  it("returns null when the first JSON token is an array", () => {
    expect(extractJsonFromText('["a","b"]')).toBeNull();
  });

  it("returns null when a bare array is wrapped in prose", () => {
    // Parses cleanly to [1, 2, 3]; only the non-object guard rejects it.
    expect(extractJsonFromText("The answer is [1, 2, 3]")).toBeNull();
  });

  it("prefers the first JSON object over a trailing array", () => {
    // The first bracketed value is an object (with a nested array member),
    // which must be returned intact rather than tripping the array guard.
    expect(
      extractJsonFromText('Here you go: {"items":["a"]} but really ["a","b"]'),
    ).toEqual({ items: ["a"] });
  });

  it("returns null when the JSON token is a numeric primitive", () => {
    expect(extractJsonFromText("42")).toBeNull();
  });

  it("returns null when the JSON token is a string primitive", () => {
    expect(extractJsonFromText('"text"')).toBeNull();
  });

  it("returns null when the JSON token is the literal null", () => {
    expect(extractJsonFromText("null")).toBeNull();
  });

  it("returns null when no JSON object braces are present", () => {
    expect(extractJsonFromText("no json here")).toBeNull();
  });

  it("returns null when the braces contain invalid JSON", () => {
    expect(extractJsonFromText("{not valid json}")).toBeNull();
  });

  it("returns the parsed object for a valid JSON object (happy path)", () => {
    const result = extractJsonFromText('{"summary":"a bolt","partNumbers":["X1"]}');
    expect(result).toEqual({ summary: "a bolt", partNumbers: ["X1"] });
  });

  it("extracts a JSON object embedded in surrounding prose", () => {
    const result = extractJsonFromText(
      'Sure! Here is the analysis: {"detectedVendor":"Acme"} Hope that helps.',
    );
    expect(result).toEqual({ detectedVendor: "Acme" });
  });
});
