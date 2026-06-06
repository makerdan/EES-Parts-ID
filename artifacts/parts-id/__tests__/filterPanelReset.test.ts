/**
 * @jest-environment node
 *
 * Regression guard: confirms that the FilterPanel reset action and the
 * DEFAULT_FILTERS constant both produce includeNullDimensions: true.
 *
 * A future change that reverts the default to false would silently exclude
 * unmeasured parts from search results. These tests lock in the behaviour
 * at the source level without requiring a full component render.
 */
import * as fs from "fs";
import * as path from "path";

const FILTER_PANEL_PATH = path.resolve(
  __dirname,
  "../components/FilterPanel.tsx",
);
const SEARCH_SCREEN_PATH = path.resolve(
  __dirname,
  "../app/(tabs)/index.tsx",
);

describe("FilterPanel — reset sets includeNullDimensions to true", () => {
  let filterPanelSource: string;

  beforeAll(() => {
    filterPanelSource = fs.readFileSync(FILTER_PANEL_PATH, "utf8");
  });

  it("resetTextFields callback sets includeNullDimensions to true (not false)", () => {
    expect(filterPanelSource).toContain(
      'onChange("includeNullDimensions", true)',
    );
  });

  it("resetTextFields callback does not reset includeNullDimensions to false", () => {
    const resetBlockMatch = filterPanelSource.match(
      /const resetTextFields[\s\S]*?\}, \[onChange\]\)/,
    );
    expect(resetBlockMatch).not.toBeNull();
    const resetBlock = resetBlockMatch![0];
    expect(resetBlock).not.toContain(
      'onChange("includeNullDimensions", false)',
    );
  });
});

describe("DEFAULT_FILTERS — includeNullDimensions defaults to true", () => {
  let searchScreenSource: string;

  beforeAll(() => {
    searchScreenSource = fs.readFileSync(SEARCH_SCREEN_PATH, "utf8");
  });

  it("DEFAULT_FILTERS sets includeNullDimensions: true", () => {
    const defaultBlockMatch = searchScreenSource.match(
      /const DEFAULT_FILTERS[\s\S]*?\};/,
    );
    expect(defaultBlockMatch).not.toBeNull();
    const defaultBlock = defaultBlockMatch![0];
    expect(defaultBlock).toContain("includeNullDimensions: true");
  });

  it("DEFAULT_FILTERS does not set includeNullDimensions: false", () => {
    const defaultBlockMatch = searchScreenSource.match(
      /const DEFAULT_FILTERS[\s\S]*?\};/,
    );
    expect(defaultBlockMatch).not.toBeNull();
    const defaultBlock = defaultBlockMatch![0];
    expect(defaultBlock).not.toContain("includeNullDimensions: false");
  });
});
