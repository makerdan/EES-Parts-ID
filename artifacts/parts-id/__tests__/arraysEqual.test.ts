/**
 * @jest-environment node
 */
import { arraysEqual } from "../utils/arraysEqual";

describe("arraysEqual", () => {
  it("treats identical references as equal", () => {
    const a = ["x", "y"];
    expect(arraysEqual(a, a)).toBe(true);
  });

  it("returns true for structurally equal string arrays", () => {
    expect(arraysEqual(["a", "b", "c"], ["a", "b", "c"])).toBe(true);
  });

  it("returns false when lengths differ", () => {
    expect(arraysEqual(["a"], ["a", "b"])).toBe(false);
  });

  it("returns false when elements differ", () => {
    expect(arraysEqual(["a", "b"], ["a", "c"])).toBe(false);
  });

  it("is order-sensitive", () => {
    expect(arraysEqual(["a", "b"], ["b", "a"])).toBe(false);
  });

  it("handles empty arrays", () => {
    expect(arraysEqual([], [])).toBe(true);
  });

  it("works on number arrays", () => {
    expect(arraysEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(arraysEqual([1, 2, 3], [1, 2, 4])).toBe(false);
  });
});
