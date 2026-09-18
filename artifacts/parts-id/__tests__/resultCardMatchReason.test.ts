/**
 * @jest-environment node
 *
 * Regression test: ResultCard must never render the matchReason string.
 *
 * The matchReason field is a debug-level annotation (e.g. "↑ offline Fuse match")
 * that was mistakenly exposed in the UI. This test guards against it silently
 * reappearing by asserting the rendering block is absent from the source file.
 */

import * as fs from "fs";
import * as path from "path";

const RESULT_CARD_PATH = path.resolve(
  __dirname,
  "../components/ResultCard.tsx",
);

describe("ResultCard — matchReason is not rendered", () => {
  let source: string;

  beforeAll(() => {
    source = fs.readFileSync(RESULT_CARD_PATH, "utf8");
  });

  it("does not contain the match-reason JSX block", () => {
    expect(source).not.toMatch(/↑\s*\{matchReason\}/);
  });

  it("does not render matchReason inside a Text element", () => {
    expect(source).not.toMatch(/<Text[^>]*>[\s\S]*?↑[\s\S]*?matchReason[\s\S]*?<\/Text>/);
  });

  it("does not contain the 'Match reason' comment alongside a matchReason conditional", () => {
    expect(source).not.toMatch(/Match reason[\s\S]{0,200}matchReason\s*\?/);
  });
});
