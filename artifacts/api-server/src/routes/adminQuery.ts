/**
 * POST /api/admin/query
 *
 * Execute a read-only SELECT query against the live database and return
 * column names and rows as JSON, CSV, or Excel. Only SELECT statements are
 * permitted; any other statement type is rejected with a 400 error.
 *
 * Safeguards:
 *   - Every query runs inside a transaction that is ALWAYS rolled back, even
 *     on success.  This is the primary read-only enforcement mechanism: the
 *     database engine guarantees no mutations survive regardless of what SQL
 *     was submitted.
 *   - The WRITE_KEYWORDS regex blocklist is retained as secondary
 *     defence-in-depth (fast 400 before the query reaches the DB) but is NOT
 *     relied upon as the primary control.
 *   - Statement timeout of QUERY_TIMEOUT_MS (default 5 000 ms) via SET LOCAL
 *   - Results capped at MAX_ROWS (default 500); response includes truncated flag
 *   - Sensitive columns (matching SENSITIVE_COLUMN_PATTERN) are stripped from
 *     every response before serialization; stripped column names are listed in
 *     the response metadata so the admin knows data was omitted.
 *
 * Request body (JSON):
 *   { sql: string }
 *
 * Query params:
 *   format=csv  — returns a CSV file download
 *   format=xlsx — returns an Excel file download
 *
 * Response:
 *   200 { columns: string[], rows: Record<string, unknown>[], rowCount: number, truncated: boolean, strippedColumns: string[] }
 *   200 text/csv attachment                      — when ?format=csv
 *   200 application/vnd.openxmlformats... attachment — when ?format=xlsx
 *   400 { error: string }  — non-SELECT query or empty input
 *   401                    — missing or invalid admin token
 *   408 { error: string }  — statement timeout fired
 *   500 { error: string }  — query execution error (message forwarded)
 */

import { getAuth } from "@clerk/express";
import { pool } from "@workspace/db";
import ExcelJS from "exceljs";
import { Router } from "express";

import { adminQueryLimiter } from "../lib/rateLimiter";
import { requireAdminAuth } from "../middlewares/requireAdminAuth";

const router = Router();

/** A single row returned by the database: column name → cell value (unknown until narrowed). */
interface AdminQueryRow {
  [col: string]: unknown;
}

const QUERY_TIMEOUT_MS = parseInt(process.env.ADMIN_QUERY_TIMEOUT_MS ?? "5000", 10);
const MAX_ROWS = parseInt(process.env.ADMIN_QUERY_MAX_ROWS ?? "500", 10);

/**
 * Regex used to detect sensitive column names that must never be sent to the
 * browser.  The default covers the most common patterns for secrets stored in
 * relational databases, as well as PII columns that should not be exposed to
 * admin query results verbatim.  Override via the ADMIN_QUERY_SENSITIVE_COLUMNS
 * env var (a pipe-separated list of patterns, each treated as a full-column-name
 * regex, case-insensitive).
 *
 * Default patterns (case-insensitive):
 *   .*_hash     — e.g. password_hash, pin_hash
 *   .*_token    — e.g. reset_token, refresh_token, api_token
 *   .*_secret   — e.g. totp_secret, client_secret
 *   .*_key      — e.g. api_key, encryption_key
 *   password    — exact column named "password"
 *   .*password.* — any column containing "password"
 *   .*_salt     — e.g. password_salt
 *   email       — exact column named "email" (PII)
 *   clerk_user_id — Clerk identity reference (PII / auth)
 *   .*phone.*   — any column containing "phone" (e.g. phone, phone_number, backup_phone)
 *   .*user_id.* — any column whose name contains "user_id" (auth identifiers)
 */
const DEFAULT_SENSITIVE_PATTERN =
  ".*_hash|.*_token|.*_secret|.*_key|password|.*password.*|.*_salt|email|clerk_user_id|.*phone.*|.*user_id.*";

function buildSensitiveColumnPattern(): RegExp {
  const envPattern = process.env.ADMIN_QUERY_SENSITIVE_COLUMNS;
  if (envPattern) {
    try {
      return new RegExp(`^(${envPattern})$`, "i");
    } catch {
      console.warn(
        `[adminQuery] ADMIN_QUERY_SENSITIVE_COLUMNS contains an invalid regex ("${envPattern}"); ` +
          "falling back to the default sensitive-column denylist.",
      );
    }
  }
  return new RegExp(`^(${DEFAULT_SENSITIVE_PATTERN})$`, "i");
}

const SENSITIVE_COLUMN_PATTERN = buildSensitiveColumnPattern();

/**
 * Given the raw column list and rows from the database, return filtered copies
 * with any column whose name matches SENSITIVE_COLUMN_PATTERN removed.
 * The list of stripped column names is returned alongside so callers can
 * surface it in the response metadata.
 */
function filterSensitiveColumns(
  columns: Array<string>,
  rows: Array<AdminQueryRow>,
): { columns: Array<string>; rows: Array<AdminQueryRow>; strippedColumns: Array<string> } {
  const strippedColumns: Array<string> = [];
  const safeColumns: Array<string> = [];

  for (const col of columns) {
    if (SENSITIVE_COLUMN_PATTERN.test(col)) {
      strippedColumns.push(col);
    } else {
      safeColumns.push(col);
    }
  }

  if (strippedColumns.length === 0) {
    return { columns, rows, strippedColumns: [] };
  }

  const safeRows = rows.map((row) => {
    const filtered: AdminQueryRow = {};
    for (const col of safeColumns) {
      filtered[col] = row[col];
    }
    return filtered;
  });

  return { columns: safeColumns, rows: safeRows, strippedColumns };
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

/**
 * THREAT MODEL — what this validation does and does not protect:
 *
 * Protected:
 *   - DDL/DML keywords (DROP, INSERT, UPDATE, DELETE, ALTER, TRUNCATE, GRANT,
 *     REVOKE, CREATE, and others) are rejected via case-insensitive word-boundary
 *     regex so that subqueries or column aliases that merely contain the word
 *     cannot bypass the check (e.g. "updatedAt" won't match \bUPDATE\b).
 *   - Stacked statements (e.g. `SELECT 1; DROP TABLE zones`) are rejected by
 *     refusing any SQL that still contains a semicolon after trailing ones are
 *     removed.  This prevents an inner statement from escaping the wrapper.
 *   - Every query runs inside a read-only subquery wrapper:
 *       SELECT * FROM (...) AS _admin_query_wrapper LIMIT N
 *     so even a SELECT that somehow slipped through cannot directly mutate data.
 *
 * Remaining risk surface (accepted / out of scope):
 *   - Information disclosure via subqueries: an admin could craft a SELECT
 *     that reads tables beyond their normal scope through correlated subqueries
 *     or JOINs.  This is accepted because the endpoint is admin-only and
 *     requires a valid admin token.
 *   - Keywords hidden inside SQL string literals or dollar-quoted blocks are
 *     not fully stripped before scanning; the regex may produce false positives
 *     (rejecting valid queries with e.g. a column value containing "DROP") but
 *     not false negatives that would permit DDL.
 *   - Full AST-level parsing is explicitly out of scope per the threat model.
 */
const WRITE_KEYWORDS =
  /\b(drop|insert|update|delete|alter|truncate|grant|revoke|create|replace|copy|call|exec|execute|merge|upsert|set)\b/i;

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

  // Reject stacked statements: after stripping trailing semicolons, any
  // remaining semicolon means a second statement could execute outside the
  // wrapper (e.g. `SELECT 1; DROP TABLE zones`).
  const withoutTrailingSemicolons = stripped.replace(/;+$/, "");
  if (withoutTrailingSemicolons.includes(";")) {
    return "Query must be a single statement (semicolons within the query are not permitted)";
  }

  return null;
}

const FORMULA_TRIGGER = /^[=+\-@]/;

function sanitizeFormula(str: string): string {
  return FORMULA_TRIGGER.test(str) ? `'${str}` : str;
}

function escapeCSVField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = typeof value === "string" ? sanitizeFormula(value) : String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildCSV(
  columns: Array<string>,
  rows: Array<Record<string, unknown>>,
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
  const rlKey = getAuth(req)?.userId ?? String(req.ip ?? "unknown");
  const rateCheck = await adminQueryLimiter.check(rlKey);
  if (!rateCheck.allowed) {
    res.set("Retry-After", String(Math.ceil(rateCheck.retryAfterMs / 1000)));
    return void res.status(429).json({ error: "Too many admin query requests. Please slow down." });
  }

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

    // ALWAYS roll back — this is the primary read-only enforcement.  Even if a
    // write statement somehow slipped through validation (e.g. via a future SQL
    // parser edge case), the database engine guarantees no mutation survives.
    await client.query("ROLLBACK");

    const rawColumns: Array<string> = result.fields.map((f: { name: string }) => f.name);
    const allRows = result.rows as Array<AdminQueryRow>;
    const truncated = allRows.length > MAX_ROWS;
    const cappedRows = truncated ? allRows.slice(0, MAX_ROWS) : allRows;

    const {
      columns,
      rows,
      strippedColumns,
    } = filterSensitiveColumns(rawColumns, cappedRows);

    if (format === "csv") {
      const csv = buildCSV(columns, rows, truncated, MAX_ROWS);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="query-results.csv"');
      if (strippedColumns.length > 0) {
        res.setHeader(
          "X-Stripped-Columns",
          strippedColumns.join(", "),
        );
      }
      return void res.send(csv);
    }

    if (format === "xlsx") {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Query Results");

      sheet.columns = columns.map((col) => ({ header: col, key: col }));

      for (const row of rows) {
        const sanitizedRow: AdminQueryRow = {};
        for (const col of columns) {
          const v = row[col];
          sanitizedRow[col] = typeof v === "string" ? sanitizeFormula(v) : v;
        }
        sheet.addRow(sanitizedRow);
      }

      sheet.getRow(1).font = { bold: true };

      if (truncated) {
        const noteRow = sheet.addRow([
          `[Results truncated at ${MAX_ROWS} rows — refine your query for complete data]`,
        ]);
        noteRow.getCell(1).font = { italic: true, color: { argb: "FFCC0000" } };
      }

      if (strippedColumns.length > 0) {
        const metaSheet = workbook.addWorksheet("_metadata");
        metaSheet.addRow(["stripped_columns"]);
        metaSheet.addRow([strippedColumns.join(", ")]);
        metaSheet.getRow(1).font = { bold: true };
      }

      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.setHeader("Content-Disposition", 'attachment; filename="query-results.xlsx"');
      await workbook.xlsx.write(res);
      return void res.end();
    }

    res.json({ columns, rows, rowCount: rows.length, truncated, strippedColumns });
  } catch (err: unknown) {
    await client.query("ROLLBACK").catch(() => {});

    const message = err instanceof Error ? err.message : "Query failed";
    // Redacted log: emit only the error message and a truncated,
    // parameter-stripped SQL snippet so literal values (potential PII /
    // credentials) never appear in server logs.
    const redactedSql = (typeof rawSql === "string" ? rawSql : "")
      .replace(/\$\d+/g, "?")
      .replace(/'(?:[^'\\]|\\.)*'/g, "?")
      .slice(0, 120);
    console.error(`[adminQuery] error="${message}" query_prefix="${redactedSql}"`);
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
