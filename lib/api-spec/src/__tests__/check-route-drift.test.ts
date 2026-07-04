/**
 * Tests for check-route-drift-helpers.ts
 *
 * Unit tests cover the three core AST extraction helpers:
 *   - objectLiteralKeys
 *   - collectResJsonLiterals
 *   - collectReqBodyFieldAccesses (called collectReqBodyTypeFields in the task)
 *
 * Integration tests verify that analyzeFile reports a violation for a synthetic
 * route file with an undeclared field, and passes a route file with correct fields.
 */

import * as ts from "typescript";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import {
  objectLiteralKeys,
  collectResJsonLiterals,
  collectReqBodyFieldAccesses,
  analyzeFile,
} from "../check-route-drift-helpers";

// ── Parsing helpers ───────────────────────────────────────────────────────────

function parse(src: string): ts.SourceFile {
  return ts.createSourceFile(
    "test.ts",
    src,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
}

/** Find the first ObjectLiteralExpression in a parsed source file. */
function firstObjectLiteral(
  sf: ts.SourceFile,
): ts.ObjectLiteralExpression | undefined {
  let found: ts.ObjectLiteralExpression | undefined;
  function walk(node: ts.Node) {
    if (found) return;
    if (ts.isObjectLiteralExpression(node)) {
      found = node;
      return;
    }
    ts.forEachChild(node, walk);
  }
  walk(sf);
  return found;
}

// ── objectLiteralKeys ─────────────────────────────────────────────────────────

describe("objectLiteralKeys", () => {
  it("extracts identifier keys from a plain object literal", () => {
    const sf = parse("const x = { foo: 1, bar: 2 };");
    const lit = firstObjectLiteral(sf)!;
    expect(objectLiteralKeys(lit)).toEqual(["foo", "bar"]);
  });

  it("extracts string-literal keys", () => {
    const sf = parse('const x = { "hello-world": 1, normal: 2 };');
    const lit = firstObjectLiteral(sf)!;
    expect(objectLiteralKeys(lit)).toEqual(["hello-world", "normal"]);
  });

  it("extracts shorthand property keys", () => {
    const sf = parse("const baz = 3; const x = { baz };");
    // The second object literal is { baz }
    let count = 0;
    let target: ts.ObjectLiteralExpression | undefined;
    function walk(node: ts.Node) {
      if (ts.isObjectLiteralExpression(node)) {
        count++;
        target = node;
      }
      ts.forEachChild(node, walk);
    }
    walk(sf);
    expect(objectLiteralKeys(target!)).toEqual(["baz"]);
  });

  it("skips spread elements", () => {
    const sf = parse("const x = { ...other, kept: 1 };");
    const lit = firstObjectLiteral(sf)!;
    expect(objectLiteralKeys(lit)).toEqual(["kept"]);
  });

  it("returns an empty array for an empty object literal", () => {
    const sf = parse("const x = {};");
    const lit = firstObjectLiteral(sf)!;
    expect(objectLiteralKeys(lit)).toEqual([]);
  });
});

// ── collectResJsonLiterals ─────────────────────────────────────────────────────

describe("collectResJsonLiterals", () => {
  it("finds a simple res.json({}) call", () => {
    const sf = parse("res.json({ id: 1, name: 'Alice' });");
    const hits = collectResJsonLiterals(sf);
    expect(hits).toHaveLength(1);
    expect(objectLiteralKeys(hits[0].literal)).toEqual(["id", "name"]);
    expect(hits[0].isErrorResponse).toBe(false);
    expect(hits[0].hasSpread).toBe(false);
  });

  it("finds res.status(200).json({}) and marks it as not an error response", () => {
    const sf = parse("res.status(200).json({ ok: true });");
    const hits = collectResJsonLiterals(sf);
    expect(hits).toHaveLength(1);
    expect(hits[0].isErrorResponse).toBe(false);
  });

  it("marks res.status(400).json({}) as an error response", () => {
    const sf = parse("res.status(400).json({ error: 'Bad request' });");
    const hits = collectResJsonLiterals(sf);
    expect(hits).toHaveLength(1);
    expect(hits[0].isErrorResponse).toBe(true);
  });

  it("marks res.status(500).json({}) as an error response", () => {
    const sf = parse("res.status(500).json({ message: 'fail' });");
    const hits = collectResJsonLiterals(sf);
    expect(hits).toHaveLength(1);
    expect(hits[0].isErrorResponse).toBe(true);
  });

  it("detects spread elements and sets hasSpread", () => {
    const sf = parse("res.json({ ...base, extra: 1 });");
    const hits = collectResJsonLiterals(sf);
    expect(hits).toHaveLength(1);
    expect(hits[0].hasSpread).toBe(true);
    // spread key is excluded, explicit key is kept
    expect(objectLiteralKeys(hits[0].literal)).toEqual(["extra"]);
  });

  it("finds multiple res.json calls in the same file", () => {
    const sf = parse(`
      res.json({ a: 1 });
      res.status(201).json({ b: 2 });
    `);
    const hits = collectResJsonLiterals(sf);
    expect(hits).toHaveLength(2);
  });

  it("ignores non-res .json() calls", () => {
    const sf = parse("other.json({ secret: 1 });");
    const hits = collectResJsonLiterals(sf);
    expect(hits).toHaveLength(0);
  });

  it("finds deeply nested res.json inside an arrow function handler", () => {
    const sf = parse(`
      router.get("/path", (req, res) => {
        res.status(201).json({ created: true });
      });
    `);
    const hits = collectResJsonLiterals(sf);
    expect(hits).toHaveLength(1);
    expect(objectLiteralKeys(hits[0].literal)).toEqual(["created"]);
  });

  it("does not pick up a variable passed to res.json (non-literal)", () => {
    const sf = parse("res.json(someVariable);");
    const hits = collectResJsonLiterals(sf);
    expect(hits).toHaveLength(0);
  });

  it("skips res.status(variable).json({}) — dynamic status code is ambiguous, not a false-positive success", () => {
    const sf = parse("res.status(code).json({ ghost: true });");
    const hits = collectResJsonLiterals(sf);
    expect(hits).toHaveLength(0);
  });

  it("skips res.status(statusCode).json({}) where statusCode is an identifier", () => {
    const sf = parse(`
      const statusCode = computeStatus();
      res.status(statusCode).json({ undeclared: 1 });
    `);
    const hits = collectResJsonLiterals(sf);
    expect(hits).toHaveLength(0);
  });

  it("still collects plain res.json({}) (no .status() call at all) as a non-error response", () => {
    const sf = parse("res.json({ id: 1 });");
    const hits = collectResJsonLiterals(sf);
    expect(hits).toHaveLength(1);
    expect(hits[0].isErrorResponse).toBe(false);
  });

  it("still collects res.status(200).json({}) as a non-error response", () => {
    const sf = parse("res.status(200).json({ id: 1 });");
    const hits = collectResJsonLiterals(sf);
    expect(hits).toHaveLength(1);
    expect(hits[0].isErrorResponse).toBe(false);
  });
});

// ── collectReqBodyFieldAccesses ───────────────────────────────────────────────

describe("collectReqBodyFieldAccesses", () => {
  it("extracts fields from req.body as { field: T } type assertion", () => {
    const sf = parse(
      "const data = req.body as { username: string; password: string };",
    );
    const groups = collectReqBodyFieldAccesses(sf);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual(expect.arrayContaining(["username", "password"]));
  });

  it("extracts fields from destructuring: const { field } = req.body", () => {
    const sf = parse("const { email, role } = req.body;");
    const groups = collectReqBodyFieldAccesses(sf);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual(expect.arrayContaining(["email", "role"]));
  });

  it("extracts the property name from aliased destructuring: const { a: b } = req.body", () => {
    const sf = parse("const { original: alias } = req.body;");
    const groups = collectReqBodyFieldAccesses(sf);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual(["original"]);
  });

  it("extracts field from req.body.field direct access", () => {
    const sf = parse("const val = req.body.fieldName;");
    const groups = collectReqBodyFieldAccesses(sf);
    const flat = groups.flat();
    expect(flat).toContain("fieldName");
  });

  it("handles destructuring when req.body is cast: const { x } = req.body as { x: number }", () => {
    const sf = parse("const { x } = req.body as { x: number };");
    const groups = collectReqBodyFieldAccesses(sf);
    // Two groups: one from the as-expression, one from the destructuring
    const flat = groups.flat();
    expect(flat).toContain("x");
  });

  it("returns empty array when req.body is not accessed", () => {
    const sf = parse("const data = other.body.field;");
    const groups = collectReqBodyFieldAccesses(sf);
    expect(groups).toHaveLength(0);
  });

  it("does not pick up req.params or req.query", () => {
    const sf = parse("const id = req.params.id; const q = req.query.search;");
    const groups = collectReqBodyFieldAccesses(sf);
    expect(groups).toHaveLength(0);
  });
});

// ── analyzeFile integration tests ─────────────────────────────────────────────

describe("analyzeFile (integration)", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-check-test-"));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeRoute(filename: string, content: string): string {
    const fp = path.join(tmpDir, filename);
    fs.writeFileSync(fp, content, "utf-8");
    return fp;
  }

  const specOps = new Map([
    [
      "GET /items",
      {
        requestFields: new Set<string>(),
        responseFields: new Set(["id", "name", "status"]),
      },
    ],
    [
      "POST /items",
      {
        requestFields: new Set(["name", "quantity"]),
        responseFields: new Set(["id", "name"]),
      },
    ],
  ]);

  it("returns no violations when the route uses only declared response fields", () => {
    const fp = writeRoute(
      "good-route.ts",
      `
      import { Router } from "express";
      const router = Router();
      router.get("/items", (req, res) => {
        res.json({ id: 1, name: "Widget", status: "active" });
      });
      export default router;
    `,
    );

    const violations = analyzeFile(fp, "", specOps);
    expect(violations).toHaveLength(0);
  });

  it("reports a violation when the route uses an undeclared response field", () => {
    const fp = writeRoute(
      "bad-response-route.ts",
      `
      import { Router } from "express";
      const router = Router();
      router.get("/items", (req, res) => {
        res.json({ id: 1, name: "Widget", undeclaredField: true });
      });
      export default router;
    `,
    );

    const violations = analyzeFile(fp, "", specOps);
    expect(violations.length).toBeGreaterThan(0);
    const v = violations[0];
    expect(v.kind).toBe("response");
    expect(v.undeclaredFields).toContain("undeclaredField");
    expect(v.specPath).toBe("/items");
    expect(v.method).toBe("GET");
  });

  it("skips error (4xx) response literals even if they contain undeclared fields", () => {
    const fp = writeRoute(
      "error-response-route.ts",
      `
      import { Router } from "express";
      const router = Router();
      router.get("/items", (req, res) => {
        res.status(200).json({ id: 1, name: "ok" });
        res.status(404).json({ undeclaredField: "not found" });
      });
      export default router;
    `,
    );

    const violations = analyzeFile(fp, "", specOps);
    expect(violations).toHaveLength(0);
  });

  it("reports a violation when the route accesses an undeclared req.body field", () => {
    const fp = writeRoute(
      "bad-request-route.ts",
      `
      import { Router } from "express";
      const router = Router();
      router.post("/items", (req, res) => {
        const { name, quantity, undeclaredBodyField } = req.body;
        res.json({ id: 1, name });
      });
      export default router;
    `,
    );

    const violations = analyzeFile(fp, "", specOps);
    expect(violations.some((v) => v.kind === "requestBody")).toBe(true);
    const reqViolation = violations.find((v) => v.kind === "requestBody")!;
    expect(reqViolation.undeclaredFields).toContain("undeclaredBodyField");
  });

  it("returns no violations for a route not declared in the spec (internal route)", () => {
    const fp = writeRoute(
      "internal-route.ts",
      `
      import { Router } from "express";
      const router = Router();
      router.get("/admin/internal", (req, res) => {
        res.json({ secret: "data", adminOnly: true });
      });
      export default router;
    `,
    );

    const violations = analyzeFile(fp, "", specOps);
    expect(violations).toHaveLength(0);
  });

  it("returns empty array for a non-existent file path", () => {
    const violations = analyzeFile(
      path.join(tmpDir, "does-not-exist.ts"),
      "",
      specOps,
    );
    expect(violations).toHaveLength(0);
  });

  it("does not produce a false-positive violation when status code is a variable (res.status(code).json({}))", () => {
    const fp = writeRoute(
      "dynamic-status-route.ts",
      `
      import { Router } from "express";
      const router = Router();
      router.get("/items", (req, res) => {
        const code = computeStatus();
        res.status(code).json({ undeclaredField: "value" });
      });
      export default router;
    `,
    );

    const violations = analyzeFile(fp, "", specOps);
    expect(violations).toHaveLength(0);
  });

  it("applies a non-empty prefix when matching spec routes", () => {
    // specOps only knows about "GET /items". Mount the same route under "/v2"
    // so it doesn't match unless the prefix is prepended correctly.
    const prefixedSpecOps = new Map([
      [
        "GET /v2/items",
        {
          requestFields: new Set<string>(),
          responseFields: new Set(["id", "name"]),
        },
      ],
    ]);

    const goodFp = writeRoute(
      "prefixed-good-route.ts",
      `
      import { Router } from "express";
      const router = Router();
      router.get("/items", (req, res) => {
        res.json({ id: 1, name: "Widget" });
      });
      export default router;
    `,
    );

    const badFp = writeRoute(
      "prefixed-bad-route.ts",
      `
      import { Router } from "express";
      const router = Router();
      router.get("/items", (req, res) => {
        res.json({ id: 1, name: "Widget", ghost: true });
      });
      export default router;
    `,
    );

    // With correct "/v2" prefix both files match GET /v2/items in the spec.
    expect(analyzeFile(goodFp, "/v2", prefixedSpecOps)).toHaveLength(0);
    const violations = analyzeFile(badFp, "/v2", prefixedSpecOps);
    expect(violations.some((v) => v.undeclaredFields.includes("ghost"))).toBe(true);

    // With wrong prefix (empty) neither file matches any spec route — no violations.
    expect(analyzeFile(badFp, "", prefixedSpecOps)).toHaveLength(0);
  });
});
