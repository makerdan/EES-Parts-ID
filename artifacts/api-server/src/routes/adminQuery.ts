/**
 * POST /api/admin/query
 *
 * Execute a read-only SELECT query against the live database and return
 * column names and rows as JSON. Only SELECT statements are permitted;
 * any other statement type is rejected with a 400 error.
 *
 * Request body (JSON):
 *   { sql: string }
 *
 * Response:
 *   200 { columns: string[], rows: Record<string, unknown>[], rowCount: number }
 *   400 { error: string }  — non-SELECT query or empty input
 *   401                    — missing or invalid admin token
 *   500 { error: string }  — query execution error (message forwarded)
 */

import { Router } from "express";
import { pool } from "@workspace/db";
import { verifyAdminToken } from "./admin";

const router = Router();

function requireAdminAuth(
  req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction,
): void {
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    res.status(503).json({ error: "Admin access is not configured. Set ADMIN_PASSWORD." });
    return;
  }
  const authHeader = req.headers["authorization"] ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token || !verifyAdminToken(token, adminPassword)) {
    res.status(401).json({ error: "Unauthorized: valid admin token required" });
    return;
  }
  next();
}

/**
 * Strip leading SQL line comments (--) and block comments (/* ... *\/) so
 * that the first meaningful token can be reliably identified.
 */
function stripLeadingComments(input: string): string {
  let s = input.trim();
  let changed = true;
  while (changed) {
    changed = false;
    if (s.startsWith("--")) {
      const nl = s.indexOf("\n");
      s = nl === -1 ? "" : s.slice(nl + 1).trim();
      changed = true;
    } else if (s.startsWith("/*")) {
      const end = s.indexOf("*/");
      s = end === -1 ? "" : s.slice(end + 2).trim();
      changed = true;
    }
  }
  return s;
}

const WRITE_KEYWORDS = /\b(insert|update|delete|drop|truncate|alter|create|replace|grant|revoke|copy|call|exec|execute|merge|upsert|set)\b/i;

/**
 * Validate that the submitted SQL is a safe read-only SELECT statement.
 * Returns an error string if rejected, or null if valid.
 */
function validateSelect(rawSql: string): string | null {
  if (!rawSql || !rawSql.trim()) {
    return "Query cannot be empty";
  }

  const stripped = stripLeadingComments(rawSql);
  if (!stripped) {
    return "Query cannot be empty";
  }

  const firstWord = stripped.split(/[\s(]/)[0]?.toUpperCase() ?? "";
  if (firstWord !== "SELECT" && firstWord !== "WITH") {
    return `Only SELECT queries are allowed (got: ${firstWord || "unknown"})`;
  }

  if (WRITE_KEYWORDS.test(stripped)) {
    return "Query contains disallowed write or DDL keywords";
  }

  return null;
}

router.post("/query", requireAdminAuth, async (req, res) => {
  try {
    const { sql: rawSql } = req.body as { sql?: string };

    const validationError = validateSelect(typeof rawSql === "string" ? rawSql : "");
    if (validationError) {
      return void res.status(400).json({ error: validationError });
    }

    const result = await pool.query(rawSql!);
    const columns: string[] = result.fields.map((f: { name: string }) => f.name);
    const rows = result.rows as Record<string, unknown>[];

    res.json({ columns, rows, rowCount: rows.length });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Query failed";
    res.status(500).json({ error: message });
  }
});

export default router;
