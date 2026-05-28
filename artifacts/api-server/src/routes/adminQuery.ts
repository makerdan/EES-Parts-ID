/**
 * POST /api/admin/query
 *
 * Execute a read-only SELECT query against the live database and return
 * column names and rows as JSON, CSV, or Excel. Only SELECT statements are
 * permitted; any other statement type is rejected with a 400 error.
 *
 * Safeguards:
 *   - Statement timeout of QUERY_TIMEOUT_MS (default 5 000 ms) via SET LOCAL
 *   - Results capped at MAX_ROWS (default 500); response includes truncated flag
 *
 * Request body (JSON):
 *   { sql: string }
 *
 * Query params:
 *   format=csv  — returns a CSV file download
 *   format=xlsx — returns an Excel file download
 *
 * Response:
 *   200 { columns: string[], rows: Record<string, unknown>[], rowCount: number, truncated: boolean }
 *   200 text/csv attachment                      — when ?format=csv
 *   200 application/vnd.openxmlformats... attachment — when ?format=xlsx
 *   400 { error: string }  — non-SELECT query or empty input
 *   401                    — missing or invalid admin token
 *   408 { error: string }  — statement timeout fired
 *   500 { error: string }  — query execution error (message forwarded)
 */

import { Router } from "express";
import ExcelJS from "exceljs";
import { pool } from "@workspace/db";
import { verifyAdminToken } from "./admin";

const router = Router();

const QUERY_TIMEOUT_MS = parseInt(process.env.ADMIN_QUERY_TIMEOUT_MS ?? "5000", 10);
const MAX_ROWS = parseInt(process.env.ADMIN_QUERY_MAX_ROWS ?? "500", 10);

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

function escapeCSVField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildCSV(
  columns: string[],
  rows: Record<string, unknown>[],
  truncated: boolean,
  maxRows: number,
): string {
  const header = columns.map(escapeCSVField).join(",");
  const body = rows
    .map((row) => columns.map((col) => escapeCSVField(row[col])).join(","))
    .join("\r\n");
  const truncationNote = truncated
    ? `\r\n"[Results truncated at ${maxRows} rows — refine your query for complete data]"`
    : "";
  return header + "\r\n" + body + truncationNote;
}

router.post("/query", requireAdminAuth, async (req, res) => {
  const { sql: rawSql } = req.body as { sql?: string };
  const format = (req.query.format as string | undefined)?.toLowerCase();

  const validationError = validateSelect(typeof rawSql === "string" ? rawSql : "");
  if (validationError) {
    return void res.status(400).json({ error: validationError });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`SET LOCAL statement_timeout = ${QUERY_TIMEOUT_MS}`);

    const trimmedSql = rawSql!.trim().replace(/;+$/, "");
    const capped = `SELECT * FROM (${trimmedSql}) AS _admin_query_wrapper LIMIT ${MAX_ROWS + 1}`;
    const result = await client.query(capped);

    await client.query("COMMIT");

    const columns: string[] = result.fields.map((f: { name: string }) => f.name);
    const allRows = result.rows as Record<string, unknown>[];
    const truncated = allRows.length > MAX_ROWS;
    const rows = truncated ? allRows.slice(0, MAX_ROWS) : allRows;

    if (format === "csv") {
      const csv = buildCSV(columns, rows, truncated, MAX_ROWS);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="query-results.csv"');
      return void res.send(csv);
    }

    if (format === "xlsx") {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Query Results");

      sheet.columns = columns.map((col) => ({ header: col, key: col }));

      for (const row of rows) {
        sheet.addRow(row);
      }

      sheet.getRow(1).font = { bold: true };

      if (truncated) {
        const noteRow = sheet.addRow([
          `[Results truncated at ${MAX_ROWS} rows — refine your query for complete data]`,
        ]);
        noteRow.getCell(1).font = { italic: true, color: { argb: "FFCC0000" } };
      }

      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.setHeader("Content-Disposition", 'attachment; filename="query-results.xlsx"');
      await workbook.xlsx.write(res);
      return void res.end();
    }

    res.json({ columns, rows, rowCount: rows.length, truncated });
  } catch (err: unknown) {
    await client.query("ROLLBACK").catch(() => {});

    const message = err instanceof Error ? err.message : "Query failed";
    const isTimeout =
      err instanceof Error &&
      (message.includes("canceling statement due to statement timeout") ||
        message.includes("statement timeout"));
    if (isTimeout) {
      res.status(408).json({
        error: `Query timed out after ${QUERY_TIMEOUT_MS / 1000}s. Try a more specific query or add a LIMIT clause.`,
      });
    } else {
      res.status(500).json({ error: message });
    }
  } finally {
    client.release();
  }
});

export default router;
