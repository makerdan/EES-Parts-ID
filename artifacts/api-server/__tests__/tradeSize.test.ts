/**
 * Unit tests for the server-side trade-size parser/formatter that drives
 * the Trade Size filter chip and the aiKeywords backfill.
 */
import {
  parseTradeSizeInches,
  isConduitOrPipe,
  tradeSizeChipLabel,
  tradeSizeKeywordTokens,
  deriveTradeSizeTokens,
} from "../src/utils/tradeSize";

describe("parseTradeSizeInches", () => {
  it.each([
    ["IMC12", 0.5],
    ["IMC34", 0.75],
    ["IMC212", 2.5],
    ["EMT114", 1.25],
    ["EMT112", 1.5],
    ["EMT100", 1],
    ["EMT400", 4],
    ["PVC2", 2],
  ])("parses %s → %s\"", (code, inches) => {
    expect(parseTradeSizeInches(code)).toBeCloseTo(inches, 5);
  });

  it.each([
    ["BR120"], ["BR15"], [""], ["EMT"], ["RANDOM999"],
  ])("returns null for %s", code => {
    expect(parseTradeSizeInches(code as string)).toBe(null);
  });
});

describe("isConduitOrPipe", () => {
  it("flags conduit family items", () => {
    expect(isConduitOrPipe("IMC212")).toBe(true);
    expect(isConduitOrPipe("EMT34 Coupling")).toBe(true);
    expect(isConduitOrPipe(null, undefined, "PVC sched 40 elbow")).toBe(true);
  });

  it("returns false for non-conduit items", () => {
    expect(isConduitOrPipe("BR120 20A breaker")).toBe(false);
    expect(isConduitOrPipe("Duplex receptacle")).toBe(false);
  });
});

describe("tradeSizeChipLabel", () => {
  it("matches the FilterPanel chip option strings", () => {
    expect(tradeSizeChipLabel(0.5)).toBe('1/2"');
    expect(tradeSizeChipLabel(0.75)).toBe('3/4"');
    expect(tradeSizeChipLabel(1)).toBe('1"');
    expect(tradeSizeChipLabel(1.25)).toBe('1-1/4"');
    expect(tradeSizeChipLabel(1.5)).toBe('1-1/2"');
    expect(tradeSizeChipLabel(2)).toBe('2"');
    expect(tradeSizeChipLabel(2.5)).toBe('2-1/2"');
    expect(tradeSizeChipLabel(4)).toBe('4"');
  });
});

describe("tradeSizeKeywordTokens", () => {
  it("includes chip label plus natural-language variants", () => {
    const t = tradeSizeKeywordTokens(0.5);
    expect(t).toEqual(expect.arrayContaining(['1/2"', "1/2", "1/2 inch", "1/2 in", '0.5"']));
  });

  it("includes both dash and space forms for mixed numbers", () => {
    const t = tradeSizeKeywordTokens(1.25);
    expect(t).toEqual(expect.arrayContaining(['1-1/4"', "1-1/4", "1 1/4", "1-1/4 inch"]));
  });
});

describe("deriveTradeSizeTokens", () => {
  it("derives tokens from a conduit catalog code", () => {
    const t = deriveTradeSizeTokens({ vendor: "ALL", catalog: "IMC212", description: "IMC conduit" });
    expect(t[0]).toBe('2-1/2"');
  });

  it("returns [] for non-conduit items even with parseable digits", () => {
    expect(deriveTradeSizeTokens({ vendor: "ETN", catalog: "BR120", description: "20A breaker" })).toEqual([]);
  });

  it("falls back to description when catalog has no parseable size", () => {
    const t = deriveTradeSizeTokens({ vendor: "X", catalog: "FOO", description: "EMT 1/2 conduit ABC EMT12" });
    expect(t).toContain('1/2"');
  });
});
