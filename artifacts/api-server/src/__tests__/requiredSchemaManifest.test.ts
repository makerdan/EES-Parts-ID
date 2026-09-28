import * as schema from "../../../../lib/db/src/schema";

import {
  checkRequiredSchema,
  REQUIRED_SCHEMA_TABLES,
  STARTUP_MIGRATIONS_TIMEOUT_MS,
  STARTUP_SCHEMA_BUDGET_MS,
  STARTUP_SCHEMA_PROBE_TIMEOUT_MS,
} from "../lib/readiness";

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

  it("keeps all configured schema attempts and delays inside the startup budget", () => {
    expect(STARTUP_SCHEMA_BUDGET_MS).toBeLessThanOrEqual(
      STARTUP_MIGRATIONS_TIMEOUT_MS,
    );
    expect(STARTUP_SCHEMA_BUDGET_MS).toBe(20_400);
  });

  it("resets a probe client's statement timeout before returning it", async () => {
    const queries: string[] = [];
    const client = {
      query: jest.fn(async (query: string) => {
        queries.push(query);
        if (query.startsWith("SELECT")) {
          return { rows: [{ usable: true }] };
        }
        return { rows: [] };
      }),
      release: jest.fn(),
    };

    await expect(
      checkRequiredSchema(client, {
        statementTimeoutMs: STARTUP_SCHEMA_PROBE_TIMEOUT_MS,
      }),
    ).resolves.toBe(true);

    expect(queries[0]).toBe(`SET statement_timeout = ${STARTUP_SCHEMA_PROBE_TIMEOUT_MS}`);
    expect(queries.at(-1)).toBe("SET statement_timeout = 0");
  });
});