import { expandMeasurements } from "../src/utils/measurementConversion";

describe("expandMeasurements", () => {
  describe("metric → imperial", () => {
    it("converts mm to inch terms", () => {
      const terms = expandMeasurements("25mm conduit");
      const joined = terms.join(" ");
      // 25mm ≈ 0.984 inch (nearest trade size = 1 inch)
      expect(terms.some(t => /inch/i.test(t) || t.includes('"'))).toBe(true);
    });

    it("converts cm to inch terms", () => {
      const terms = expandMeasurements("2.54cm");
      // 2.54cm = 25.4mm = 1 inch
      expect(terms.some(t => /1(\s*inch|")/i.test(t))).toBe(true);
    });

    it("converts meters to feet", () => {
      const terms = expandMeasurements("3m conduit");
      expect(terms.some(t => /ft|feet/i.test(t))).toBe(true);
    });

    it("does not convert a bare number with no unit", () => {
      const terms = expandMeasurements("20 breaker");
      expect(terms).toHaveLength(0);
    });
  });

  describe("imperial → metric", () => {
    it("converts fractional inch to mm terms", () => {
      const terms = expandMeasurements('1/2" conduit');
      // 0.5 inch = 12.7mm
      expect(terms.some(t => /mm/i.test(t))).toBe(true);
    });

    it("converts mixed fraction inch to mm terms", () => {
      const terms = expandMeasurements("1-1/2 inch conduit");
      // 1.5 inch = 38.1mm
      expect(terms.some(t => /mm/i.test(t))).toBe(true);
    });

    it("converts written 'half inch' to mm terms", () => {
      const terms = expandMeasurements("half inch conduit");
      expect(terms.some(t => /mm/i.test(t))).toBe(true);
    });

    it("converts decimal inch to mm terms", () => {
      const terms = expandMeasurements("0.75 inch conduit");
      expect(terms.some(t => /mm/i.test(t))).toBe(true);
    });

    it("converts whole-number inch to mm terms", () => {
      const terms = expandMeasurements('2" conduit');
      // 2 inch = 50.8mm
      expect(terms.some(t => /mm/i.test(t))).toBe(true);
    });

    it("converts feet to meters", () => {
      const terms = expandMeasurements("250ft cable");
      expect(terms.some(t => /\d+m\b/i.test(t))).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("returns an array for empty input", () => {
      expect(Array.isArray(expandMeasurements(""))).toBe(true);
    });

    it("does not produce terms for out-of-range mm values", () => {
      // 0mm and very large values should be ignored
      const zero = expandMeasurements("0mm conduit");
      expect(zero).toHaveLength(0);
    });

    it("does not match wire-gauge fractions (14/2) as inch measurements", () => {
      // 14/2 has no explicit inch unit, so it must NOT be treated as 7 inches
      const terms = expandMeasurements("12/2 NM-B cable");
      // No inch-to-metric conversion should happen for bare wire gauge fractions
      expect(terms.filter(t => /\d+mm/i.test(t))).toHaveLength(0);
    });
  });
});
