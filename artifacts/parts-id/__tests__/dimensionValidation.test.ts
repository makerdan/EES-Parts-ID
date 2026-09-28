import {
  dimensionInputsChanged,
  parseDimensionText,
  validateDimensionInputs,
} from "@/utils/dimensionValidation";

describe("dimension text validation", () => {
  it.each(["-12.5", "1..2", "100000.1", "100001", "1e3", "Infinity"])(
    "rejects malformed or out-of-range value %s without parsing a partial number",
    (value) => {
      expect(parseDimensionText(value)).toEqual({ valid: false });
    },
  );

  it("accepts complete decimals in range and rounds to one decimal place", () => {
    expect(parseDimensionText("12.34")).toEqual({ valid: true, value: 12.3 });
    expect(parseDimensionText(".5")).toEqual({ valid: true, value: 0.5 });
    expect(parseDimensionText("100000")).toEqual({ valid: true, value: 100000 });
    expect(parseDimensionText("0")).toEqual({ valid: true, value: 0 });
  });

  it("preserves blank-field semantics as null while accepting a partial dimension set", () => {
    expect(parseDimensionText("")).toEqual({ valid: true, value: null });
    expect(parseDimensionText("   ")).toEqual({ valid: true, value: null });
    expect(validateDimensionInputs({
      length: "12.3",
      width: "",
      height: " ",
      diameter: "",
    })).toEqual({
      valid: true,
      values: { length: 12.3, width: null, height: null, diameter: null },
    });
  });

  it("marks invalid text as changed so a save cannot treat it like a blank value", () => {
    const validation = validateDimensionInputs({
      length: "1..2",
      width: "",
      height: "",
      diameter: "",
    });

    expect(validation).toEqual({ valid: false, invalidFields: ["length"] });
    expect(dimensionInputsChanged(validation, {
      length: null,
      width: null,
      height: null,
      diameter: null,
    })).toBe(true);
  });
});