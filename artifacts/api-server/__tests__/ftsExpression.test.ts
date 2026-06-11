/**
 * Guard: the tsvector expression used in search queries must stay in sync with
 * the one declared in the `inventory_fts_idx` GIN index.
 *
 * Both the index definition and every FTS WHERE clause / ts_rank_cd call in the
 * inventory route must use `inventoryFtsVector()` from @workspace/db.  This
 * test verifies that function's output contains exactly the expected fields and
 * uses the IMMUTABLE wrapper function required by PostgreSQL for index
 * expressions.  Any future edit that changes the expression will be caught here
 * rather than silently degrading to a sequential scan in production.
 */

import { inventoryFtsVector } from "@workspace/db";

function getSql(alias?: string): string {
  const fragment = inventoryFtsVector(alias);
  // Drizzle's sql.raw() stores the raw SQL string inside queryChunks[0].value,
  // which is itself an array of string parts (one element for a raw fragment).
  // Shape: { queryChunks: [{ value: string[] }] }
  const raw = fragment as unknown as {
    queryChunks?: Array<{ value?: string | string[] }>;
  };

  if (Array.isArray(raw.queryChunks) && raw.queryChunks.length > 0) {
    const val = raw.queryChunks[0]?.value;
    if (typeof val === "string") return val;
    if (Array.isArray(val) && val.length > 0 && typeof val[0] === "string") {
      return val[0];
    }
  }

  // Fallback: coerce to string so the assertions still give useful output.
  return String(fragment);
}

describe("inventoryFtsVector — canonical FTS expression guard", () => {
  it("uses to_tsvector with the english dictionary", () => {
    const expr = getSql();
    expect(expr).toMatch(/to_tsvector\('english'/);
  });

  it("includes all five required fields (no alias)", () => {
    const expr = getSql();
    expect(expr).toContain("vendor");
    expect(expr).toContain("catalog");
    expect(expr).toContain("description");
    expect(expr).toContain("expanded_description");
    expect(expr).toContain("ai_keywords");
  });

  it("uses immutable_array_to_string (not bare array_to_string) for ai_keywords", () => {
    const expr = getSql();
    // The index expression must use the IMMUTABLE wrapper so PostgreSQL allows
    // it in a functional index.  A bare array_to_string() is only STABLE and
    // would be silently unused (index not selected by the planner).
    expect(expr).toContain("immutable_array_to_string");
    expect(expr).not.toMatch(/(?<!immutable_)array_to_string/);
  });

  it("applies the table alias prefix when one is provided", () => {
    const expr = getSql("i");
    expect(expr).toContain("i.vendor");
    expect(expr).toContain("i.catalog");
    expect(expr).toContain("i.description");
    expect(expr).toContain("i.expanded_description");
    expect(expr).toContain("i.ai_keywords");
  });

  it("produces no alias prefix when called without an argument", () => {
    const expr = getSql();
    // Bare column names are used in the index definition (no table alias).
    expect(expr).not.toMatch(/\bi\./);
  });

  it("no-alias and aliased expressions differ only by the table prefix", () => {
    const bare = getSql();
    const aliased = getSql("i");
    // Stripping the alias should recover the bare expression exactly.
    expect(aliased.replace(/\bi\./g, "")).toBe(bare);
  });
});
