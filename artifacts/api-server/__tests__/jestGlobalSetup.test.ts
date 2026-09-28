const {
  removeRetiredDictionaryVersionObjects,
  removeUnusedDictionaryVersionTables,
  provisionInventoryChipText,
  verifyInventoryChipText,
} = require("../jest.globalSetup.cjs") as {
  removeRetiredDictionaryVersionObjects: (client: {
    query: jest.Mock;
  }) => Promise<number>;
  removeUnusedDictionaryVersionTables: (client: {
    query: jest.Mock;
  }, databaseEnvironment?: string) => Promise<{
    status: "absent" | "removed" | "retained";
    removedCount: number;
    retainedCount: number;
  }>;
  provisionInventoryChipText: (client: { query: jest.Mock }) => Promise<void>;
  verifyInventoryChipText: (client: { query: jest.Mock }) => Promise<void>;
};

export {};

describe("jest global setup retired dictionary cleanup", () => {
  it("drops discovered legacy triggers before dropping their function", async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            schema_name: "public",
            table_name: "abbreviation_map",
            trigger_name: "trg_dict_ver_abbreviation_map",
          },
          {
            schema_name: 'test"schema',
            table_name: "synonym_group",
            trigger_name: "trg_dict_ver_synonym_group",
          },
        ],
      })
      .mockResolvedValue({ rows: [] });

    await expect(
      removeRetiredDictionaryVersionObjects({ query }),
    ).resolves.toBe(2);

    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("t.tgname = ANY($1::text[])"),
      [
        [
          "trg_dict_ver_synonym_group",
          "trg_dict_ver_abbreviation_map",
          "trg_dict_ver_electrical_slang_map",
          "trg_dict_ver_misspelling_map",
        ],
      ],
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      'DROP TRIGGER IF EXISTS "trg_dict_ver_abbreviation_map" ON "public"."abbreviation_map"',
    );
    expect(query).toHaveBeenNthCalledWith(
      3,
      'DROP TRIGGER IF EXISTS "trg_dict_ver_synonym_group" ON "test""schema"."synonym_group"',
    );
    expect(query).toHaveBeenNthCalledWith(
      4,
      "DROP FUNCTION IF EXISTS increment_dict_version()",
    );
  });

  it("still removes the retired function when no legacy triggers remain", async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      removeRetiredDictionaryVersionObjects({ query }),
    ).resolves.toBe(0);

    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenLastCalledWith(
      "DROP FUNCTION IF EXISTS increment_dict_version()",
    );
  });
});

describe("jest global setup retired dictionary table cleanup", () => {
  it("refuses to inspect or drop tables outside test database mode", async () => {
    const query = jest.fn();

    await expect(
      removeUnusedDictionaryVersionTables({ query }, "development"),
    ).rejects.toThrow("DATABASE_ENV=test is required");

    expect(query).not.toHaveBeenCalled();
  });

  it("leaves a fresh database unchanged when no obsolete table exists", async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [] });

    await expect(
      removeUnusedDictionaryVersionTables({ query }, "test"),
    ).resolves.toEqual({
      status: "absent",
      removedCount: 0,
      retainedCount: 0,
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("c.relname = 'dictionary_version'"),
    );
  });

  it("drops isolated dictionary_version tables discovered in reused databases", async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({
        rows: [{ schema_name: 'test"schema', table_name: "dictionary_version" }],
      })
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      removeUnusedDictionaryVersionTables({ query }, "test"),
    ).resolves.toEqual({
      status: "removed",
      removedCount: 1,
      retainedCount: 0,
    });

    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("FROM pg_depend d"),
    );
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("FROM pg_trigger t"),
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      'DROP TABLE "test""schema"."dictionary_version"',
    );
  });

  it("retains dictionary_version tables that have triggers or external dependencies", async () => {
    const query = jest.fn().mockResolvedValueOnce({
      rows: [
        {
          schema_name: "public",
          table_name: "dictionary_version",
          has_user_trigger: true,
          has_external_dependency: false,
        },
        {
          schema_name: "public",
          table_name: "dictionary_version",
          has_user_trigger: false,
          has_external_dependency: true,
        },
      ],
    });

    await expect(
      removeUnusedDictionaryVersionTables({ query }, "test"),
    ).resolves.toEqual({
      status: "retained",
      removedCount: 0,
      retainedCount: 2,
    });

    const eligibilityQuery = query.mock.calls[0][0] as string;
    expect(eligibilityQuery).toContain("NOT t.tgisinternal");
    expect(eligibilityQuery).toContain("d.refobjid = c.oid");
    expect(eligibilityQuery).toContain("d.deptype NOT IN ('a', 'i')");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("reports retained when PostgreSQL rejects a race-time dependent drop", async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            schema_name: "public",
            table_name: "dictionary_version",
            has_user_trigger: false,
            has_external_dependency: false,
          },
        ],
      })
      .mockRejectedValueOnce(Object.assign(new Error("dependent objects exist"), {
        code: "2BP01",
      }));

    await expect(
      removeUnusedDictionaryVersionTables({ query }, "test"),
    ).resolves.toEqual({
      status: "retained",
      removedCount: 0,
      retainedCount: 1,
    });
  });

  describe("inventory chip text provisioning", () => {
    it("provisions and verifies the inventory chip function contract", async () => {
      const query = jest
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{ signature: "inventory_chip_text(text,text,text,text[])" }],
        });

      await provisionInventoryChipText({ query });
      await verifyInventoryChipText({ query });

      expect(query).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining(
          "CREATE OR REPLACE FUNCTION public.inventory_chip_text",
        ),
      );
      expect(query).toHaveBeenNthCalledWith(
        2,
        "SELECT to_regprocedure($1)::text AS signature",
        ["inventory_chip_text(text,text,text,text[])"],
      );
    });

    it("fails verification when the expected function signature is absent", async () => {
      const query = jest.fn().mockResolvedValue({ rows: [{ signature: null }] });

      await expect(verifyInventoryChipText({ query })).rejects.toThrow(
        "inventory_chip_text verification failed",
      );
    });
  });
});
