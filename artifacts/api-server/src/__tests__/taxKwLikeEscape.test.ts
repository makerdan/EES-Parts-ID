/**
 * Regression tests: taxonomy keyword LIKE-wildcard escaping.
 *
 * If a taxonomy keyword contains SQL LIKE wildcards (% or _), the push-down
 * query must escape them so the pattern matches the literal substring, not an
 * unintended broader set of rows.
 *
 * The escapeLikeWildcard helper is the single escape point used when building
 * `%<keyword>%` patterns for the uncategorized-browse SQL condition.
 */

import { escapeLikeWildcard } from "../utils/sqlUtils";

describe("escapeLikeWildcard", () => {
  it("passes through keywords with no wildcards unchanged", () => {
    expect(escapeLikeWildcard("conduit")).toBe("conduit");
    expect(escapeLikeWildcard("14 awg")).toBe("14 awg");
    expect(escapeLikeWildcard("")).toBe("");
  });

  it("escapes % so it is treated as a literal percent sign", () => {
    expect(escapeLikeWildcard("50%")).toBe("50\\%");
    expect(escapeLikeWildcard("%off")).toBe("\\%off");
    expect(escapeLikeWildcard("100%polyester")).toBe("100\\%polyester");
  });

  it("escapes _ so it is treated as a literal underscore", () => {
    expect(escapeLikeWildcard("part_no")).toBe("part\\_no");
    expect(escapeLikeWildcard("_suffix")).toBe("\\_suffix");
    expect(escapeLikeWildcard("a_b_c")).toBe("a\\_b\\_c");
  });

  it("escapes both % and _ in the same keyword", () => {
    expect(escapeLikeWildcard("50%_off")).toBe("50\\%\\_off");
    expect(escapeLikeWildcard("_100%_")).toBe("\\_100\\%\\_");
  });

  it("wrapping in % produces a correct LIKE pattern for literal substring matching", () => {
    const kw = "50%_off";
    const pattern = `%${escapeLikeWildcard(kw)}%`;
    expect(pattern).toBe("%50\\%\\_off%");
  });

  it("wrapping a plain keyword in % produces the same pattern as before", () => {
    const kw = "breaker";
    const pattern = `%${escapeLikeWildcard(kw)}%`;
    expect(pattern).toBe("%breaker%");
  });
});
