/**
 * @jest-environment node
 *
 * Regression guards for the render-stability audit. These checks intentionally
 * inspect the source because mounting the Expo and Radix provider trees would
 * require unrelated native/browser infrastructure; the implementation
 * invariants are structural and should remain easy to verify in CI.
 */
import * as fs from "fs";
import * as path from "path";

function read(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, "..", "..", relativePath), "utf8");
}

describe("render stability regression guards", () => {
  it("keeps Parts ID list headers out of inline component factories", () => {
    const searchSource = read("parts-id/app/(tabs)/index.tsx");
    const categorySource = read("parts-id/components/BrowseByCategory.tsx");

    expect(searchSource).toContain("const searchListHeader = useMemo(");
    expect(searchSource).toContain("ListHeaderComponent={searchListHeader}");
    expect(searchSource).not.toContain("ListHeaderComponent={() =>");

    expect(categorySource).toContain("const BrowseListHeader = React.memo(");
    expect(categorySource).toContain("ListHeaderComponent={");
    expect(categorySource).not.toContain("ListHeaderComponent={() =>");
  });

  it("keeps shared provider values referentially stable between relevant updates", () => {
    const appContextSource = read("parts-id/contexts/AppContext.tsx");
    const healthContextSource = read("parts-id/contexts/ApiHealthContext.tsx");
    const carouselSource = read("mockup-sandbox/src/components/ui/carousel.tsx");
    const formSource = read("mockup-sandbox/src/components/ui/form.tsx");
    const toggleGroupSource = read("mockup-sandbox/src/components/ui/toggle-group.tsx");
    const chartSource = read("mockup-sandbox/src/components/ui/chart.tsx");

    expect(appContextSource).toContain("const contextValue = useMemo<AppContextValue>");
    expect(appContextSource).toContain("<AppContext.Provider value={contextValue}>");
    expect(healthContextSource).toContain("const contextValue = useMemo(() => ({");
    expect(healthContextSource).toContain("<ApiHealthContext.Provider value={contextValue}>");
    expect(carouselSource).toContain("const contextValue = React.useMemo(");
    expect(formSource).toContain("const contextValue = React.useMemo(");
    expect(toggleGroupSource).toContain("const contextValue = React.useMemo(");
    expect(chartSource).toContain("const contextValue = React.useMemo(");
  });
});