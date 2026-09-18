const {
  removeRetiredDictionaryVersionObjects,
} = require("../jest.globalSetup.cjs") as {
  removeRetiredDictionaryVersionObjects: (client: {
    query: jest.Mock;
  }) => Promise<number>;
};

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