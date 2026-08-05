/**
 * Regression tests for Map2Screen rendering.
 *
 * Covers three paths:
 *
 *   1. Web   — dynamic import of warehouse-map-raw resolves and the SVG string
 *              is forwarded to dangerouslySetInnerHTML.
 *   2. Native normal — Asset.loadAsync returns a valid localUri; fetch resolves
 *              to the SVG text; SvgXml receives a non-empty xml prop.
 *   3. Native fallback — Asset.loadAsync returns localUri:"" and uri:"" (blank);
 *              the component falls back to the bundled raw string and SvgXml
 *              still renders instead of showing a spinner indefinitely.
 *
 * No real I/O, network, or the 2.7 MB SVG file is used.
 */

// Required for act() in the node test environment.
// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { render, act } from "@testing-library/react-native";

// ─── Stub warehouse-map-raw ───────────────────────────────────────────────────
// A short but valid SVG string.  Using this constant in assertions makes the
// tests deterministic and prevents the 2.7 MB real module from being parsed.

// Note: no width= or height= attributes on the rect so the Map2Web
// displayXml transform (which rewrites those on the root element to scale
// the SVG to viewport width) does not mutate the stub string.
const STUB_SVG = '<svg viewBox="0 0 10 10"><rect/></svg>';

jest.mock("../assets/warehouse-map-raw", () => ({
  WAREHOUSE_MAP_SVG: STUB_SVG,
}));

// ─── react-native-svg ────────────────────────────────────────────────────────
// SvgXml renders as the "svg-xml" host tag so its xml prop is inspectable.

jest.mock("react-native-svg", () => require("./helpers/mapMocks").createSvgMock());

// ─── @/hooks/useColors ───────────────────────────────────────────────────────

jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());

// ─── @/utils/useTrackScreen ──────────────────────────────────────────────────
// No-op so analytics calls don't throw or make network requests.

jest.mock("@/utils/useTrackScreen", () => ({
  useTrackScreen: () => {},
}));

// ─── expo-asset ──────────────────────────────────────────────────────────────
// Use jest.fn() for loadAsync so individual tests can call mockResolvedValue().

jest.mock("expo-asset", () => ({
  Asset: {
    fromModule: jest.fn(() => ({ downloadAsync: async () => {}, localUri: "" })),
    loadAsync: jest.fn(),
  },
}));

// ─── react-native-reanimated ─────────────────────────────────────────────────
// Map2Screen does not use Reanimated directly, but subcomponent imports may
// pull it in.  Provide the standard mock to avoid worklet resolution errors.

jest.mock("react-native-reanimated", () => require("./helpers/mapMocks").createReanimatedMock());

// ─── react-native-gesture-handler ────────────────────────────────────────────
// Handled automatically by moduleNameMapper in jest.config.js → __mocks__/react-native-gesture-handler.js

// ─── component under test (after all mocks) ──────────────────────────────────

import Map2Screen from "@/app/(tabs)/map2";

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Recursively walk a react-test-renderer JSON node tree. */
type JsonNode = {
  type: string;
  props: Record<string, unknown>;
  children: JsonNode[] | null;
};

function findAll(root: JsonNode | null, predicate: (n: JsonNode) => boolean): JsonNode[] {
  if (!root) return [];
  const results: JsonNode[] = [];
  if (predicate(root)) results.push(root);
  for (const child of root.children ?? []) {
    results.push(...findAll(child, predicate));
  }
  return results;
}

/** Flush async effects (dynamic import microtasks + React state updates). */
async function flushAsync(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Web path
// ─────────────────────────────────────────────────────────────────────────────

describe("Map2Screen — web path", () => {
  beforeAll(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require("react-native").Platform as { OS: string }).OS = "web";
  });

  afterAll(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require("react-native").Platform as { OS: string }).OS = "ios";
  });

  it("renders a div with dangerouslySetInnerHTML containing the SVG stub after the dynamic import resolves", async () => {
    const tree = await render(<Map2Screen />);

    // Flush the dynamic-import promise + React setState re-render.
    await flushAsync();

    const json = tree.toJSON() as JsonNode | null;
    const divs = findAll(json, (n) => n.type === "div");

    expect(divs.length).toBeGreaterThan(0);

    const withHtml = divs.find(
      (n) =>
        n.props.dangerouslySetInnerHTML != null &&
        typeof (n.props.dangerouslySetInnerHTML as Record<string, unknown>).__html === "string",
    );
    expect(withHtml).toBeDefined();

    const html = (withHtml!.props.dangerouslySetInnerHTML as { __html: string }).__html;
    expect(html).toContain(STUB_SVG);

    await tree.unmount();
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// Native — normal path (valid localUri)
// ─────────────────────────────────────────────────────────────────────────────

describe("Map2Screen — native normal path", () => {
  const SVG_CONTENT = "<svg>fetched-stub</svg>";
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require("react-native").Platform as { OS: string }).OS = "ios";

    // Asset.loadAsync returns a valid localUri.
    const { Asset } = require("expo-asset") as {
      Asset: { loadAsync: jest.Mock };
    };
    Asset.loadAsync.mockResolvedValue([
      { localUri: "/tmp/warehouse-map.svg", uri: "https://cdn.example.com/map.svg" },
    ]);

    // fetch resolves with the SVG text.
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => SVG_CONTENT,
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it("renders SvgXml with the fetched SVG text as the xml prop", async () => {
    const tree = await render(<Map2Screen />);
    await flushAsync();

    const json = tree.toJSON() as JsonNode | null;
    const svgXmlNodes = findAll(json, (n) => n.type === "svg-xml");

    expect(svgXmlNodes.length).toBeGreaterThan(0);
    expect(svgXmlNodes[0]!.props.xml).toBe(SVG_CONTENT);

    await tree.unmount();
  });

  it("wraps SvgXml in a ScrollView (rn-scroll) so the map is scrollable", async () => {
    const tree = await render(<Map2Screen />);
    await flushAsync();

    const json = tree.toJSON() as JsonNode | null;
    const scrollViews = findAll(json, (n) => n.type === "rn-scroll");
    expect(scrollViews.length).toBeGreaterThan(0);

    await tree.unmount();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Native — fallback path (both localUri and uri are empty)
// ─────────────────────────────────────────────────────────────────────────────

describe("Map2Screen — native fallback path (empty localUri and uri)", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require("react-native").Platform as { OS: string }).OS = "ios";

    // Asset.loadAsync returns blank URIs — simulates Expo Go cold start where
    // the local cache has not been written yet.
    const { Asset } = require("expo-asset") as {
      Asset: { loadAsync: jest.Mock };
    };
    Asset.loadAsync.mockResolvedValue([{ localUri: "", uri: "" }]);

    // fetch should NOT be called in this path; reject loudly to catch any leak.
    global.fetch = jest.fn().mockRejectedValue(
      new Error("fetch should not be called on the fallback path"),
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it("renders SvgXml with the bundled raw SVG string (not a spinner or error)", async () => {
    const tree = await render(<Map2Screen />);
    await flushAsync();

    const json = tree.toJSON() as JsonNode | null;

    // Must NOT be stuck on the spinner.
    const spinners = findAll(json, (n) => n.type === "rn-activity");
    expect(spinners).toHaveLength(0);

    // SvgXml must be present and carry the raw stub string.
    const svgXmlNodes = findAll(json, (n) => n.type === "svg-xml");
    expect(svgXmlNodes.length).toBeGreaterThan(0);
    expect(svgXmlNodes[0]!.props.xml).toBe(STUB_SVG);

    await tree.unmount();
  });

  it("does not call fetch when falling back to the bundled raw string", async () => {
    const tree = await render(<Map2Screen />);
    await flushAsync();

    expect(global.fetch).not.toHaveBeenCalled();

    await tree.unmount();
  });
});
