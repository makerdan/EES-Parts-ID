#!/usr/bin/env node
/**
 * Shared Failure Gate baseline catalog helpers.
 *
 * The catalog is deliberately boring JSON. Keeping validation here means the
 * plan guard and the opt-in maintenance report cannot disagree about whether a
 * record is referenceable.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const BASELINE_PATH = resolve("docs/validation/failure-baseline.json");

export const ACTIVE_STATUSES = new Set(["active"]);
export const KNOWN_STATUSES = new Set([
  "active",
  "needs-review",
  "intermittent",
  "environment-limited",
  "resolved",
]);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function asDate(value) {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
  return date;
}

export function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

export function validateCatalog(catalog) {
  const errors = [];
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
    return ["catalog must be a JSON object"];
  }
  if (catalog.version !== 1) errors.push("catalog.version must be 1");
  if (!Array.isArray(catalog.records)) {
    errors.push("catalog.records must be an array");
    return errors;
  }

  const ids = new Set();
  for (const [index, record] of catalog.records.entries()) {
    const prefix = `records[${index}]`;
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    for (const field of ["id", "suite", "test", "signature", "owner"]) {
      if (typeof record[field] !== "string" || record[field].trim() === "") {
        errors.push(`${prefix}.${field} must be a non-empty string`);
      }
    }
    if (ids.has(record.id)) errors.push(`${prefix}.id duplicates "${record.id}"`);
    ids.add(record.id);
    if (!KNOWN_STATUSES.has(record.status)) {
      errors.push(`${prefix}.status must be one of ${[...KNOWN_STATUSES].join(", ")}`);
    }
    if (typeof record.authority !== "string" || record.authority.trim() === "") {
      errors.push(`${prefix}.authority must be a non-empty string`);
    }
    for (const field of ["evidenceDate", "reviewDeadline"]) {
      if (!asDate(record[field])) errors.push(`${prefix}.${field} must be YYYY-MM-DD`);
    }
    if (record.verificationDate !== undefined && !asDate(record.verificationDate)) {
      errors.push(`${prefix}.verificationDate must be YYYY-MM-DD when present`);
    }
  }
  return errors;
}

export function readCatalog(filePath = BASELINE_PATH) {
  const path = resolve(filePath);
  if (!existsSync(path)) {
    return { ok: false, path, errors: [`catalog not found: ${path}`], catalog: null };
  }
  let catalog;
  try {
    catalog = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      ok: false,
      path,
      errors: [`catalog is not valid JSON: ${error instanceof Error ? error.message : String(error)}`],
      catalog: null,
    };
  }
  const errors = validateCatalog(catalog);
  return { ok: errors.length === 0, path, errors, catalog };
}

export function referenceStatus(record, asOf = todayUtc()) {
  if (!record) return { ok: false, reason: "unknown baseline ID" };
  if (!ACTIVE_STATUSES.has(record.status)) {
    return { ok: false, reason: `status "${record.status}" is not referenceable` };
  }
  if (record.authority !== "authoritative") {
    return { ok: false, reason: "record is not authoritative" };
  }
  if (record.reviewDeadline < asOf) {
    return { ok: false, reason: `review deadline ${record.reviewDeadline} has expired` };
  }
  if (record.evidenceDate > asOf) {
    return { ok: false, reason: `evidence date ${record.evidenceDate} is in the future` };
  }
  return { ok: true };
}

export function findRecord(catalog, id) {
  return catalog?.records?.find((record) => record.id === id) ?? null;
}

export function recordsById(catalog) {
  return new Map((catalog?.records ?? []).map((record) => [record.id, record]));
}

/**
 * Parse the deliberately explicit plan declaration format:
 *   **Ignored baseline:** `ID` — suite › test; match only this signature: text
 */
export function parseBaselineDeclarations(content) {
  const declarations = [];
  const linePattern =
    /^\s*-\s*\*\*(Ignored baseline|Owned baseline repair):\*\*\s*`([^`]+)`\s*[—-]\s*(.*?)\s*;\s*match only this signature:\s*(.*?)\s*\.?\s*$/;
  for (const [lineNumber, line] of content.split(/\r?\n/).entries()) {
    const match = line.match(linePattern);
    if (!match) continue;
    const subject = match[3].trim();
    const separator = subject.indexOf("›");
    const test = separator >= 0 ? subject.slice(separator + 1).trim() : "";
    const suite = separator >= 0 ? subject.slice(0, separator).trim() : subject;
    declarations.push({
      line: lineNumber + 1,
      ownership: match[1] === "Ignored baseline" ? "ignored" : "owned",
      id: match[2].trim(),
      suite,
      test,
      signature: match[4].trim(),
    });
  }
  return declarations;
}

export function compareDeclaration(record, declaration) {
  const mismatches = [];
  if (record.suite !== declaration.suite) mismatches.push(`suite "${declaration.suite}"`);
  if (record.test !== declaration.test) mismatches.push(`test "${declaration.test}"`);
  if (record.signature !== declaration.signature) mismatches.push("failure signature");
  return mismatches;
}

export function baselineErrorsForPlan(content, catalog, asOf = todayUtc()) {
  const declarations = parseBaselineDeclarations(content);
  const errors = [];
  const seen = new Set();
  const byId = recordsById(catalog);

  for (const declaration of declarations) {
    if (seen.has(declaration.id)) {
      errors.push(`line ${declaration.line}: baseline "${declaration.id}" is declared more than once`);
      continue;
    }
    seen.add(declaration.id);
    const record = byId.get(declaration.id);
    const status = referenceStatus(record, asOf);
    if (!status.ok) {
      errors.push(`line ${declaration.line}: baseline "${declaration.id}" cannot authorize an ignore: ${status.reason}`);
      continue;
    }
    const mismatches = compareDeclaration(record, declaration);
    if (mismatches.length > 0) {
      errors.push(
        `line ${declaration.line}: baseline "${declaration.id}" does not exactly match ${mismatches.join(", ")}`,
      );
    }
  }
  const lines = content.split(/\r?\n/);
  const sectionStart = lines.findIndex((line) => /^## Pre-existing failures to ignore\b/.test(line));
  const sectionEnd =
    sectionStart >= 0
      ? lines.findIndex((line, index) => index > sectionStart && /^## /.test(line))
      : -1;
  const baselineLines =
    sectionStart >= 0
      ? lines.slice(sectionStart + 1, sectionEnd >= 0 ? sectionEnd : lines.length)
      : [];
  for (const [offset, line] of baselineLines.entries()) {
    if (!/baseline/i.test(line) || !/`[^`]+`/.test(line)) continue;
    const lineNumber = sectionStart + offset + 2;
    if (declarations.some((item) => item.line === lineNumber)) continue;
    const id = line.match(/`([^`]+)`/)?.[1] ?? "(unparseable)";
    errors.push(`line ${lineNumber}: baseline "${id}" is referenced without a valid Ignored baseline or Owned baseline repair declaration`);
  }
  return { declarations, errors };
}