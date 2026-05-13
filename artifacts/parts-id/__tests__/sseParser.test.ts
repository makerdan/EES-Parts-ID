/**
 * Unit tests for the Reference Q&A SSE parser helpers.
 * Covers content frames, done frames, error frames, and the partial-tail case.
 */

import { parseSseLine, parseFinalBuffer } from "../utils/sseParser";

describe("parseSseLine", () => {
  it("parses a content frame", () => {
    expect(parseSseLine('data: {"content":"hello"}')).toEqual({
      kind: "content",
      content: "hello",
    });
  });

  it("parses a done frame", () => {
    expect(parseSseLine('data: {"done":true}')).toEqual({ kind: "done" });
  });

  it("parses an error frame", () => {
    expect(parseSseLine('data: {"error":"boom"}')).toEqual({
      kind: "error",
      message: "boom",
    });
  });

  it("ignores blank lines and unrelated lines", () => {
    expect(parseSseLine("")).toBeNull();
    expect(parseSseLine(": comment")).toBeNull();
    expect(parseSseLine("event: error")).toBeNull();
  });

  it("returns unparseable for malformed JSON in a data frame", () => {
    const ev = parseSseLine('data: {"content":"hel');
    expect(ev).toEqual({ kind: "unparseable", raw: '{"content":"hel' });
  });
});

describe("parseFinalBuffer", () => {
  it("returns null for empty/whitespace leftovers", () => {
    expect(parseFinalBuffer("")).toBeNull();
    expect(parseFinalBuffer("   \n  ")).toBeNull();
  });

  it("parses a clean leftover frame", () => {
    expect(parseFinalBuffer('data: {"content":"tail"}')).toEqual({
      kind: "content",
      content: "tail",
    });
  });

  it("flags a truncated JSON tail as unparseable instead of dropping it", () => {
    const ev = parseFinalBuffer('data: {"content":"truncat');
    expect(ev?.kind).toBe("unparseable");
  });

  it("flags non-data leftover bytes as unparseable", () => {
    const ev = parseFinalBuffer("garbage tail");
    expect(ev?.kind).toBe("unparseable");
  });
});
