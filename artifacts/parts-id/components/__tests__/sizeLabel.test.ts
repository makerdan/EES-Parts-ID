import { getSizeLabel } from "@/components/SizeVariantDropdown";

describe("getSizeLabel", () => {
  it("returns the size field when set", () => {
    expect(getSizeLabel('1/2"', "Some long description")).toBe('1/2"');
  });

  it("trims whitespace from size field", () => {
    expect(getSizeLabel('  3/4"  ', "Unused desc")).toBe('3/4"');
  });

  it("falls back to description when size is null", () => {
    expect(getSizeLabel(null, "Short desc")).toBe("Short desc");
  });

  it("falls back to description when size is empty string", () => {
    expect(getSizeLabel("", "Another desc")).toBe("Another desc");
  });

  it("falls back to description when size is whitespace only", () => {
    expect(getSizeLabel("   ", "Whitespace size")).toBe("Whitespace size");
  });

  it("truncates description longer than 20 chars and appends ellipsis", () => {
    const desc = "This is a very long description that exceeds twenty characters";
    const label = getSizeLabel(null, desc);
    expect(label.endsWith("…")).toBe(true);
    expect(label.length).toBeLessThanOrEqual(21);
  });

  it("does not truncate description of exactly 20 chars", () => {
    const desc = "Exactly twenty chars";
    expect(desc.length).toBe(20);
    expect(getSizeLabel(null, desc)).toBe(desc);
  });

  it("returns em-dash when both size and description are null", () => {
    expect(getSizeLabel(null, null)).toBe("—");
  });

  it("returns em-dash when both size and description are empty strings", () => {
    expect(getSizeLabel("", "")).toBe("—");
  });

  it("returns em-dash when size is null and description is undefined", () => {
    expect(getSizeLabel(null, undefined)).toBe("—");
  });

  it("prefers size over description when size is valid", () => {
    expect(getSizeLabel("2 inch", "A long description that would be truncated")).toBe("2 inch");
  });
});
