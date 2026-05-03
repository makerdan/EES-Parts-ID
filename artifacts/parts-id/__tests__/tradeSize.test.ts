/**
 * @jest-environment node
 *
 * Unit tests for the trade-size parser used to default-sort conduit and
 * pipe results small → large.
 */
import {
  parseTradeSizeInches,
  isConduitOrPipe,
  formatInchesAsFraction,
  catalogSuffix,
} from "../lib/tradeSize";

describe("parseTradeSizeInches", () => {
  it.each([
    ["IMC12", 0.5],
    ["IMC34", 0.75],
    ["IMC14", 0.25],
    ["IMC38", 0.375],
    ["IMC212", 2.5],
    ["EMT114", 1.25],
    ["EMT112", 1.5],
    ["EMT100", 1],
    ["EMT200", 2],
    ["EMT400", 4],
    ["EMT600", 6],
    ["PVC2", 2],
    ["PVC78", 0.875],
    ["PVC158", 1.625],
  ])("parses %s → %s\"", (code, inches) => {
    expect(parseTradeSizeInches(code)).toBeCloseTo(inches, 5);
  });

  it.each([
    ["BR120", null],         // 20A breaker, not a conduit size
    ["BR15", null],          // 15A breaker
    ["AFCI20", null],        // 20A AFCI
    ["BRP120AF", null],      // trailing letters, no digits at end
    ["", null],
    [null, null],
    [undefined, null],
    ["EMT", null],           // no trailing digits
    ["RANDOM999", null],     // 999 doesn't fit any pattern
  ])("returns null for %s", (code, expected) => {
    expect(parseTradeSizeInches(code)).toBe(expected);
  });
});

describe("isConduitOrPipe", () => {
  it("flags conduit family items by token", () => {
    expect(isConduitOrPipe("IMC212", "Allied 2 1/2 IMC")).toBe(true);
    expect(isConduitOrPipe("EMT34 Coupling")).toBe(true);
    expect(isConduitOrPipe("PVC sched 40 elbow")).toBe(true);
  });

  it("returns false for non-conduit items", () => {
    expect(isConduitOrPipe("BR120", "Eaton 20A breaker")).toBe(false);
    expect(isConduitOrPipe("Duplex receptacle 20A white")).toBe(false);
    expect(isConduitOrPipe(null, undefined, "")).toBe(false);
  });
});

describe("formatInchesAsFraction", () => {
  it.each([
    [0.125, '1/8"'],
    [0.25, '1/4"'],
    [0.375, '3/8"'],
    [0.5, '1/2"'],
    [0.625, '5/8"'],
    [0.75, '3/4"'],
    [0.875, '7/8"'],
    [1, '1"'],
    [1.25, '1 1/4"'],
    [1.5, '1 1/2"'],
    [2, '2"'],
    [2.5, '2 1/2"'],
    [4, '4"'],
  ])("formats %s → %s", (inches, expected) => {
    expect(formatInchesAsFraction(inches)).toBe(expected);
  });

  it("returns empty string for null/undefined/zero/negative", () => {
    expect(formatInchesAsFraction(null)).toBe("");
    expect(formatInchesAsFraction(undefined)).toBe("");
    expect(formatInchesAsFraction(0)).toBe("");
    expect(formatInchesAsFraction(-1)).toBe("");
  });
});

describe("catalogSuffix", () => {
  it("strips the longest shared leading alpha prefix", () => {
    expect(catalogSuffix("BR130", "BR120")).toBe("130");
    expect(catalogSuffix("EMT34", "EMT12")).toBe("34");
    expect(catalogSuffix("AFCI30", "AFCI20")).toBe("30");
  });

  it("stops at the first digit even if both share more chars", () => {
    expect(catalogSuffix("BR2120", "BR120")).toBe("2120");
  });

  it("handles missing parent gracefully", () => {
    expect(catalogSuffix("BR130", null)).toBe("BR130");
    expect(catalogSuffix("BR130", "")).toBe("BR130");
    expect(catalogSuffix("BR130", undefined)).toBe("BR130");
  });

  it("returns empty for empty/missing variant", () => {
    expect(catalogSuffix(null, "BR120")).toBe("");
    expect(catalogSuffix("", "BR120")).toBe("");
    expect(catalogSuffix("   ", "BR120")).toBe("");
  });

  it("is case-insensitive on the shared prefix", () => {
    expect(catalogSuffix("br130", "BR120")).toBe("130");
  });
});
