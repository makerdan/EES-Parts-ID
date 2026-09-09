import { createHash } from "node:crypto";

/**
 * These are the configuration tables that can be compared without reading
 * user-provided environment values. `userenv` is deliberately not included.
 */
export const STRUCTURAL_TABLES = Object.freeze([
  "modules",
  "deployment",
  "workflows",
  "agent",
  "postMerge",
  "ports",
  "nix",
]);

const EXPECTED_TYPES = Object.freeze({
  modules: "array",
  deployment: "object",
  workflows: "object",
  agent: "object",
  postMerge: "object",
  ports: "array",
  nix: "object",
});

const SENSITIVE_KEYS = new Set([
  "env",
  "environment",
  "secrets",
  "secret",
  "userenv",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isRecord(value)) {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      typeof value === "number"
    ) {
      return value;
    }
    throw new TypeError(`unsupported value type: ${typeof value}`);
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys(value[key])]),
  );
}

function redactValue(value, path, diagnostics) {
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      redactValue(entry, `${path}[${index}]`, diagnostics),
    );
  }
  if (!isRecord(value)) return value;

  const redacted = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      diagnostics.push({
        table: path.split(".")[0] || key,
        issue: "environment-bearing-table",
      });
      continue;
    }
    redacted[key] = redactValue(child, `${path}.${key}`, diagnostics);
  }
  return redacted;
}

function validateShape(
  snapshot,
  label,
  { rejectUnexpectedTables, rejectSensitive },
) {
  const diagnostics = [];
  if (!isRecord(snapshot)) {
    return {
      diagnostics: [{ table: "<root>", issue: "malformed-snapshot" }],
    };
  }

  if (rejectUnexpectedTables) {
    for (const key of Object.keys(snapshot)) {
      if (!STRUCTURAL_TABLES.includes(key) && !SENSITIVE_KEYS.has(key.toLowerCase())) {
        diagnostics.push({
          source: label,
          table: key,
          issue: "unexpected-table",
        });
      }
    }
  }

  for (const table of STRUCTURAL_TABLES) {
    if (!(table in snapshot)) {
      diagnostics.push({ table, issue: "missing-table" });
      continue;
    }
    const expectedType = EXPECTED_TYPES[table];
    const actualType = Array.isArray(snapshot[table])
      ? "array"
      : typeof snapshot[table];
    if (
      (expectedType === "object" && !isRecord(snapshot[table])) ||
      (expectedType === "array" && !Array.isArray(snapshot[table]))
    ) {
      diagnostics.push({
        table,
        issue: `expected-${expectedType}`,
        actualType,
      });
      continue;
    }
    try {
      sortKeys(snapshot[table]);
    } catch {
      diagnostics.push({
        table,
        issue: "malformed-table",
      });
    }
  }

  if (rejectSensitive) {
    const redactionDiagnostics = [];
    redactValue(snapshot, "", redactionDiagnostics);
    diagnostics.push(...redactionDiagnostics);
  }

  return diagnostics.length
    ? {
        diagnostics: diagnostics.map((diagnostic) => ({
          source: label,
          ...diagnostic,
        })),
      }
    : { diagnostics: [] };
}

function structuralTables(snapshot) {
  return Object.fromEntries(
    STRUCTURAL_TABLES.map((table) => [table, snapshot[table]]),
  );
}

function digestValue(value) {
  const canonical = JSON.stringify(sortKeys(value));
  return createHash("sha256").update(canonical).digest("hex");
}

function tableDigests(snapshot) {
  return Object.fromEntries(
    STRUCTURAL_TABLES.map((table) => [table, digestValue(snapshot[table])]),
  );
}

/**
 * Compare a checked-in `.replit` parse with a complete structural snapshot
 * supplied by a documented, read-only platform source.
 *
 * This function intentionally does not discover or read a source. Replit's
 * current documentation does not provide one, and environment metadata is not
 * a safe substitute. A future documented adapter can pass its snapshot here.
 */
export function compareStructuralConfig({ checkedIn, active }) {
  const checkedInShape = validateShape(checkedIn, "checked-in", {
    rejectUnexpectedTables: true,
    rejectSensitive: false,
  });
  const activeShape = validateShape(active, "active", {
    rejectUnexpectedTables: true,
    rejectSensitive: true,
  });
  const diagnostics = [
    ...checkedInShape.diagnostics,
    ...activeShape.diagnostics,
  ];
  if (diagnostics.length) return { ok: false, diagnostics };

  const { snapshot: redactedCheckedIn } = redactStructuralConfig(checkedIn);
  const checkedInStructural = structuralTables(redactedCheckedIn);
  const activeStructural = structuralTables(active);
  const checkedInDigest = digestValue(checkedInStructural);
  const activeDigest = digestValue(activeStructural);
  if (checkedInDigest === activeDigest) {
    return { ok: true, checkedInDigest, activeDigest, diagnostics: [] };
  }

  const checkedInTables = tableDigests(checkedInStructural);
  const activeTables = tableDigests(activeStructural);
  return {
    ok: false,
    checkedInDigest,
    activeDigest,
    diagnostics: STRUCTURAL_TABLES.filter(
      (table) => checkedInTables[table] !== activeTables[table],
    ).map((table) => ({
      source: "active",
      table,
      issue: "digest-mismatch",
    })),
  };
}

export function redactStructuralConfig(snapshot) {
  const diagnostics = [];
  const redacted = redactValue(snapshot, "", diagnostics);
  return {
    snapshot: structuralTables(redacted),
    diagnostics,
  };
}