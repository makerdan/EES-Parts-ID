import {
  boundedErrorDiagnostic,
  boundedErrorStatus,
  boundedStoredErrorStatus,
} from "../src/lib/logger";

describe("boundedErrorDiagnostic", () => {
  it("retains only allowlisted diagnostic fields", () => {
    const error = Object.assign(
      new Error(
        "catalog=SECRET-CATALOG vendor=SECRET-VENDOR description=SECRET-DESCRIPTION upload=private/object",
      ),
      {
        code: "SECRET-CATALOG",
        requestBody: {
          catalog: "SECRET-CATALOG",
          vendor: "SECRET-VENDOR",
        },
      },
    );

    expect(boundedErrorDiagnostic(error)).toEqual({ errorName: "Error" });
    expect(JSON.stringify(boundedErrorDiagnostic(error))).not.toMatch(
      /SECRET-CATALOG|SECRET-VENDOR|SECRET-DESCRIPTION|private\/object/,
    );
  });

  it("keeps stable allowlisted classifications used by inventory handlers", () => {
    const error = Object.assign(new Error("request-derived text"), {
      code: "DICTIONARY_LOAD_TIMEOUT",
      name: "DictionaryLoadTimeoutError",
    });

    expect(boundedErrorDiagnostic(error)).toEqual({
      errorName: "DictionaryLoadTimeoutError",
      errorCode: "DICTIONARY_LOAD_TIMEOUT",
    });
  });

  it("normalizes attacker-controlled error names and codes", () => {
    const error = {
      name: "SECRET-CATALOG",
      code: "SECRET-VENDOR",
      message: "SECRET-DESCRIPTION",
    };

    expect(boundedErrorDiagnostic(error)).toEqual({ errorName: "UnknownError" });
  });

  it("returns only a bounded classification for persisted and returned job status", () => {
    const error = Object.assign(
      new Error(
        "catalog=SECRET-CATALOG vendor=SECRET-VENDOR description=SECRET-DESCRIPTION upload=private/object",
      ),
      { code: "SECRET-CATALOG" },
    );

    const status = boundedErrorStatus(error);

    expect(status).toBe("Error");
    expect(status).not.toMatch(
      /SECRET-CATALOG|SECRET-VENDOR|SECRET-DESCRIPTION|private\/object/,
    );
  });

  it("prefers an allowlisted machine code for job status", () => {
    const error = Object.assign(new Error("sensitive provider text"), {
      code: "ai_payload_too_large",
      name: "CatalogAiError",
    });

    expect(boundedErrorStatus(error)).toBe("ai_payload_too_large");
  });

  it("sanitizes legacy persisted messages before status responses return them", () => {
    expect(
      boundedStoredErrorStatus(
        "catalog=SECRET-CATALOG vendor=SECRET-VENDOR upload=private/object",
      ),
    ).toBe("UnknownError");
    expect(boundedStoredErrorStatus("DICTIONARY_LOAD_TIMEOUT")).toBe(
      "DICTIONARY_LOAD_TIMEOUT",
    );
    expect(boundedStoredErrorStatus("Error")).toBe("Error");
    expect(boundedStoredErrorStatus(null)).toBeNull();
  });
});