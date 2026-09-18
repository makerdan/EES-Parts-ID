import * as schema from "../../../../lib/db/src/schema";

import { REQUIRED_SCHEMA_TABLES } from "../lib/readiness";

const DRIZZLE_NAME_SYMBOL = Symbol.for("drizzle:Name");

describe("required schema manifest", () => {
  it("only designates tables present in the canonical Drizzle schema", () => {
    const schemaTableNames = new Set(
      Object.values(schema)
        .filter(
          (value): value is Record<symbol, unknown> =>
            value !== null &&
            typeof value === "object" &&
            DRIZZLE_NAME_SYMBOL in value,
        )
        .map((table) => table[DRIZZLE_NAME_SYMBOL])
        .filter((name): name is string => typeof name === "string"),
    );

    const missingFromSchema = REQUIRED_SCHEMA_TABLES.filter(
      (tableName) => !schemaTableNames.has(tableName),
    );

    expect(missingFromSchema).toEqual([]);
    expect(new Set(REQUIRED_SCHEMA_TABLES).size).toBe(
      REQUIRED_SCHEMA_TABLES.length,
    );
  });
});