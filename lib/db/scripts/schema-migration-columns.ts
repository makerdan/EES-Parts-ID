export type MigrationColumns = Map<string, Set<string>>;

export interface ExpectedColumn {
  tableName: string;
  columnName: string;
}

function normalizeIdentifier(identifier: string): string {
  return identifier.toLowerCase();
}

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\r\n]*/g, "");
}

function findMatchingParenthesis(sql: string, openingIndex: number): number {
  let depth = 0;
  let quote: "'" | '"' | undefined;

  for (let index = openingIndex; index < sql.length; index += 1) {
    const character = sql[index];

    if (quote !== undefined) {
      if (character === quote) {
        if (sql[index + 1] === quote) {
          index += 1;
        } else {
          quote = undefined;
        }
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
    } else if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function splitTopLevelDefinitions(body: string): Array<string> {
  const definitions: Array<string> = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | '"' | undefined;

  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];

    if (quote !== undefined) {
      if (character === quote) {
        if (body[index + 1] === quote) {
          index += 1;
        } else {
          quote = undefined;
        }
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
    } else if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
    } else if (character === "," && depth === 0) {
      definitions.push(body.slice(start, index));
      start = index + 1;
    }
  }

  definitions.push(body.slice(start));
  return definitions;
}

function addColumn(
  migrationColumns: MigrationColumns,
  tableName: string,
  columnName: string,
): void {
  const columns = migrationColumns.get(tableName) ?? new Set<string>();
  columns.add(columnName);
  migrationColumns.set(tableName, columns);
}

/**
 * Extract the table/column relationships declared by migration DDL.
 *
 * This intentionally only records columns from CREATE TABLE definitions and
 * ALTER TABLE ... ADD COLUMN statements. Other quoted identifiers in a
 * migration (indexes, constraints, expressions, and data updates) must not
 * satisfy a schema column check.
 */
export function collectMigrationColumns(sql: string): MigrationColumns {
  const source = stripSqlComments(sql);
  const migrationColumns: MigrationColumns = new Map();
  const createTablePattern =
    /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|([A-Za-z_][\w$]*))\s*\(/gi;

  for (const match of source.matchAll(createTablePattern)) {
    const tableName = normalizeIdentifier(match[1] ?? match[2]);
    const openingIndex = match.index + match[0].lastIndexOf("(");
    const closingIndex = findMatchingParenthesis(source, openingIndex);
    if (closingIndex === -1) continue;

    const tableColumns = migrationColumns.get(tableName) ?? new Set<string>();
    for (const definition of splitTopLevelDefinitions(
      source.slice(openingIndex + 1, closingIndex),
    )) {
      const columnMatch = definition
        .trim()
        .match(/^(?:"([^"]+)"|([A-Za-z_][\w$]*))\s+/);
      if (!columnMatch) continue;

      const firstWord = (columnMatch[1] ?? columnMatch[2]).toUpperCase();
      if (
        firstWord === "CONSTRAINT" ||
        firstWord === "PRIMARY" ||
        firstWord === "UNIQUE" ||
        firstWord === "CHECK" ||
        firstWord === "FOREIGN" ||
        firstWord === "EXCLUDE"
      ) {
        continue;
      }

      tableColumns.add(
        normalizeIdentifier(columnMatch[1] ?? columnMatch[2]),
      );
    }
    migrationColumns.set(tableName, tableColumns);
  }

  const alterTablePattern =
    /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:"([^"]+)"|([A-Za-z_][\w$]*))([\s\S]*?)(?:;|$)/gi;
  const addColumnPattern =
    /\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|([A-Za-z_][\w$]*))/gi;

  for (const match of source.matchAll(alterTablePattern)) {
    const tableName = normalizeIdentifier(match[1] ?? match[2]);
    const alterClause = match[3];
    for (const columnMatch of alterClause.matchAll(addColumnPattern)) {
      addColumn(
        migrationColumns,
        tableName,
        normalizeIdentifier(columnMatch[1] ?? columnMatch[2]),
      );
    }
  }

  return migrationColumns;
}

export function findMissingColumns(
  expectedColumns: Array<ExpectedColumn>,
  migrationColumns: MigrationColumns,
): Array<ExpectedColumn> {
  return expectedColumns.filter(
    ({ tableName, columnName }) =>
      !migrationColumns
        .get(tableName.toLowerCase())
        ?.has(columnName.toLowerCase()),
  );
}