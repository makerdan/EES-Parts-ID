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

// =============================================================================
// FTS expression drift guard — static source analysis
// =============================================================================
//
// Every FTS WHERE clause and ts_rank_cd call in the inventory route must go
// through inventoryFtsVector() from @workspace/db rather than inlining a bare
// to_tsvector() expression.  A bare call would silently bypass the GIN index
// (PostgreSQL only uses functional indexes when the query expression matches the
// index expression exactly), causing invisible sequential scans in production.
//
// This test reads every .ts file under src/ at test time and fails if any
// contains a bare to_tsvector( literal.  Running as a Jest test makes it an
// always-on CI check rather than a manual script.

import * as fs from "fs";
import * as path from "path";

describe("FTS expression drift guard — no bare to_tsvector() in src/", () => {
  const SRC_DIR = path.join(__dirname, "..", "src");

  function collectTsFiles(dir: string): string[] {
    const files: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...collectTsFiles(fullPath));
      } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        files.push(fullPath);
      }
    }
    return files;
  }

  it("no .ts file under src/ contains a bare to_tsvector( call", () => {
    const tsFiles = collectTsFiles(SRC_DIR);
    expect(tsFiles.length).toBeGreaterThan(0);

    const violations = tsFiles.filter((file) => {
      const content = fs.readFileSync(file, "utf-8");
      return content.includes("to_tsvector(");
    });

    if (violations.length > 0) {
      const relative = violations.map((f) => path.relative(SRC_DIR, f));
      throw new Error(
        `Bare to_tsvector() found in ${violations.length} file(s). ` +
        `Use inventoryFtsVector() from @workspace/db instead:\n  ${relative.join("\n  ")}`,
      );
    }

    expect(violations).toHaveLength(0);
  });

  it("src/ files that perform FTS searches use inventoryFtsVector", () => {
    const tsFiles = collectTsFiles(SRC_DIR);

    // Files that reference websearch_to_tsquery or ts_rank_cd must also import
    // inventoryFtsVector — they are performing FTS and must use the helper.
    const ftsFiles = tsFiles.filter((file) => {
      const content = fs.readFileSync(file, "utf-8");
      return content.includes("websearch_to_tsquery") || content.includes("ts_rank_cd");
    });

    for (const file of ftsFiles) {
      const content = fs.readFileSync(file, "utf-8");
      const relative = path.relative(SRC_DIR, file);
      if (!/inventoryFtsVector/.test(content)) {
        throw new Error(
          `${relative} uses FTS operators but does not call inventoryFtsVector() — ` +
          `add the import or delegate to the shared helper to keep expression in sync with the GIN index`,
        );
      }
    }
  });
});
