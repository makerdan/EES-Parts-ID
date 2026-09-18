/**
 * Regression guard for task 1317.  These checks intentionally inspect the
 * screen source rather than mounting the whole authenticated tab navigator:
 * they protect the small, easy-to-regress reachability contracts without
 * requiring map/camera native modules in Jest.
 */
import * as fs from "fs";
import * as path from "path";

const appRoot = path.resolve(__dirname, "../app/(tabs)");
const source = (name: string) => fs.readFileSync(path.join(appRoot, name), "utf8");
const partsRoot = path.resolve(__dirname, "..");
const routeSource = (name: string) => fs.readFileSync(path.join(partsRoot, "app", name), "utf8");
const componentSource = (name: string) => fs.readFileSync(path.join(partsRoot, "components", name), "utf8");

describe("short-landscape screen reachability", () => {
  test("the app and tab navigator allow landscape without losing safe-area clearance", () => {
    const appConfig = JSON.parse(fs.readFileSync(path.join(partsRoot, "app.json"), "utf8")) as {
      expo: { orientation: string; web?: { orientation?: string } };
    };
    const tabLayout = source("_layout.tsx");

    expect(appConfig.expo.orientation).toBe("default");
    expect(appConfig.expo.web?.orientation).toBe("any");
    expect(tabLayout).toContain("useSafeAreaInsets");
    expect(tabLayout).toContain("shortLandscape");
    expect(tabLayout).toMatch(/52\s*\+\s*bottom/);
  });

  test.each(["index.tsx", "photo.tsx", "upload.tsx", "help.tsx"])(
    "%s derives layout from live window dimensions",
    (name) => {
      const text = source(name);
      expect(text).toContain("useWindowDimensions");
      expect(text).toMatch(/(?:width|screenWidth|windowWidth)\s*>\s*(?:height|screenHeight|windowHeight)/);
      expect(text).toMatch(/bottomClearance/);
    },
  );

  test("search results retain tab clearance and dismiss the keyboard interactively", () => {
    const text = source("index.tsx");
    expect(text).toMatch(/paddingBottom:\s*bottomClearance/);
    expect(text).toContain('keyboardDismissMode="interactive"');
  });

  test("the regular-user Admin guard remains reachable above the tab bar", () => {
    const text = source("upload.tsx");
    const guard = text.slice(text.indexOf("function AdminRestricted"), text.indexOf("const gateStyles"));

    expect(guard).toContain("<ScrollView");
    expect(guard).toContain("contentContainerStyle={gateStyles.container}");
    expect(text).toMatch(/container:\s*\{[^}]*flexGrow:\s*1[^}]*paddingBottom:\s*96/s);
  });

  test.each(["login.tsx", "sign-up.tsx", "pending.tsx", "banned.tsx"])(
    "%s keeps guarded and signed-out content vertically reachable",
    (name) => {
      const text = routeSource(name);
      expect(text).toContain("<ScrollView");
      expect(text).toMatch(/contentContainerStyle=\{styles\.scrollContent\}/);
      expect(text).toMatch(/scrollContent:\s*\{[^}]*flexGrow:\s*1/s);
    },
  );

  test.each([
    "admin-audit-log.tsx",
    "admin-inbox.tsx",
    "ai-log.tsx",
    "catalog-review.tsx",
  ])("%s preserves virtualized-list reachability", (name) => {
    const text = routeSource(name);
    expect(text).toContain("contentContainerStyle");
    expect(text).toMatch(/flexGrow:\s*1/);
  });

  test("map controls stay above the background and measurement fields remain scrollable", () => {
    const map = source("map.tsx");
    const warehouseMap = componentSource("WarehouseMapView.tsx");
    const measure = componentSource("MeasurePartScreen.tsx");

    expect(map).not.toContain("ScreenOrientation.lockAsync");
    expect(warehouseMap).toContain("shortLandscape");
    expect(warehouseMap).toContain("64 + insets.bottom");
    expect(warehouseMap).toMatch(/zoomControls:[\s\S]*zIndex:\s*30/);
    expect(measure).toContain("<ScrollView");
  });

  test.each(["photo.tsx", "help.tsx"])(
    "%s uses keyboard-aware scrolling for form controls",
    (name) => {
      const text = source(name);
      expect(text).toContain("KeyboardAwareScrollViewCompat");
      expect(text).toContain("bottomOffset={24}");
      expect(text).toContain('keyboardShouldPersistTaps="handled"');
    },
  );
});