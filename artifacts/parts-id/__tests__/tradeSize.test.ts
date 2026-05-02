/**
 * @jest-environment node
 *
 * Unit tests for the trade-size parser used to default-sort conduit and
 * pipe results small → large.
 */
import { parseTradeSizeInches, isConduitOrPipe } from "../lib/tradeSize";

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
