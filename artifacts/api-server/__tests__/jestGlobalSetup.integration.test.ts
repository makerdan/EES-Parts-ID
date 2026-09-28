import type { Client as PgClient } from "pg";

const { Client } = require("pg") as typeof import("pg");
const {
  cleanupTemporarySchema,
  removeUnusedDictionaryVersionTables,
} = require("../jest.globalSetup.cjs") as {
  cleanupTemporarySchema: (
    client: {
      query?: PgClient["query"];
      end?: PgClient["end"];
    } | undefined,
    schemaName: string,
    schemaCreated?: boolean,
  ) => Promise<void>;
  removeUnusedDictionaryVersionTables: (
    client: { query: PgClient["query"] },
    databaseEnvironment?: string,
  ) => Promise<{
    status: "absent" | "removed" | "retained";
    removedCount: number;
    retainedCount: number;
  }>;
};

describe("temporary PostgreSQL schema fixture cleanup", () => {
  it("drops an owned schema and closes its client", async () => {
    const client = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      end: jest.fn().mockResolvedValue(undefined),
    };

    await cleanupTemporarySchema(client, 'temporary"schema');

    expect(client.query).toHaveBeenCalledWith(
      'DROP SCHEMA IF EXISTS "temporary""schema" CASCADE',
    );
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it("preserves an original setup failure when teardown also fails", async () => {
    const setupError = new Error("fixture setup failed");
    const teardownError = new Error("database connection already closed");
    const client = {
      query: jest.fn().mockRejectedValue(teardownError),
      end: jest.fn().mockRejectedValue(teardownError),
    };
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await expect(
        (async () => {
          try {
            throw setupError;
          } finally {
            await cleanupTemporarySchema(client, "temporary_schema");
          }
        })(),
      ).rejects.toBe(setupError);
    } finally {
      warn.mockRestore();
    }

    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it("closes an unowned client without dropping an uncreated schema", async () => {
    const client = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      end: jest.fn().mockResolvedValue(undefined),
    };

    await cleanupTemporarySchema(client, "never_created", false);

    expect(client.query).not.toHaveBeenCalled();
    expect(client.end).toHaveBeenCalledTimes(1);
  });
});

describe("real PostgreSQL legacy table cleanup diagnostics", () => {
  let client: InstanceType<typeof Client> | undefined;
  const schemaName = `cleanup_diag_${process.pid}_${Date.now()}`;
  let schemaCreated = false;
  let setupComplete = false;

  const cleanupFixture = async () => {
    const activeClient = client;
    const ownsSchema = schemaCreated;
    client = undefined;
    schemaCreated = false;

    await cleanupTemporarySchema(activeClient, schemaName, ownsSchema);
  };

  beforeAll(async () => {
    try {
      client = new Client({
        connectionString: process.env.DATABASE_URL,
      });
      await client.connect();
      await client.query(`CREATE SCHEMA "${schemaName}"`);
      schemaCreated = true;
      await client.query(
        `CREATE TABLE "${schemaName}"."dictionary_version" (id integer PRIMARY KEY)`,
      );
      await client.query(
        `CREATE VIEW "${schemaName}"."dictionary_version_view" AS SELECT id FROM "${schemaName}"."dictionary_version"`,
      );
      await client.query(
        `CREATE FUNCTION "${schemaName}"."dictionary_version_guard"() RETURNS trigger LANGUAGE plpgsql AS $function$ BEGIN RETURN NEW; END; $function$`,
      );
      await client.query(
        `CREATE TRIGGER "dictionary_version_guard_trigger" BEFORE INSERT ON "${schemaName}"."dictionary_version" FOR EACH ROW EXECUTE FUNCTION "${schemaName}"."dictionary_version_guard"()`,
      );
      setupComplete = true;
    } finally {
      if (!setupComplete) {
        await cleanupFixture();
      }
    }
  });

  afterAll(async () => {
    await cleanupFixture();
  });

  it("retains a legacy table and its dependent view", async () => {
    const result = await removeUnusedDictionaryVersionTables(client!, "test");

    expect(result).toEqual({
      status: "retained",
      removedCount: 0,
      retainedCount: 1,
    });

    const { rows } = await client!.query(
      `
        SELECT
          to_regclass($1)::text AS table_name,
          to_regclass($2)::text AS view_name,
          EXISTS (
            SELECT 1
            FROM pg_trigger t
            JOIN pg_class c ON c.oid = t.tgrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE NOT t.tgisinternal
              AND n.nspname = $3
              AND c.relname = 'dictionary_version'
              AND t.tgname = 'dictionary_version_guard_trigger'
          ) AS trigger_present
      `,
      [
        `${schemaName}.dictionary_version`,
        `${schemaName}.dictionary_version_view`,
        schemaName,
      ],
    );
    expect(rows[0]).toEqual({
      table_name: `${schemaName}.dictionary_version`,
      view_name: `${schemaName}.dictionary_version_view`,
      trigger_present: true,
    });
  });
});
