/**
 * @jest-environment node
 *
 * Regression guard: ensures AislePillRow, SectionPillRow, and pillRowStyles
 * have been fully removed from BrowseByAisle.tsx and cannot silently reappear.
 */
import * as fs from "fs";
import * as path from "path";

const SRC_PATH = path.resolve(__dirname, "../components/BrowseByAisle.tsx");

describe("BrowseByAisle — pill row removal regression", () => {
  let source: string;

  beforeAll(() => {
    source = fs.readFileSync(SRC_PATH, "utf8");
  });

  it("does not contain AislePillRow", () => {
    expect(source).not.toContain("AislePillRow");
  });

  it("does not contain SectionPillRow", () => {
    expect(source).not.toContain("SectionPillRow");
  });

  it("does not contain pillRowStyles", () => {
    expect(source).not.toContain("pillRowStyles");
  });
});
