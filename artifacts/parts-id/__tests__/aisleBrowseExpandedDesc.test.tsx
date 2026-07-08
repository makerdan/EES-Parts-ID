/**
 * @jest-environment node
 *
 * Regression guard: the aisle-browse shelf card (ResultCard rendered by
 * BrowseByAisle when a bin is selected) must surface `description` as the
 * primary text block, and must fall back to `expandedDescription` only when
 * `description` is absent or empty — exactly as the main search ResultCard does.
 *
 * This mirrors `resultCardExpandedDescription.test.tsx` but uses the exact
 * prop shape that BrowseByAisle passes to ResultCard:
 *   { item, confidence: 1, matchReason: "", seriesLabel: undefined, variants: [] }
 *
 * Without this guard a refactor that changes description display priority in
 * ResultCard would break both the search view and the aisle-browse shelf card,
 * but only the search case had a dedicated test.
 */

// Required for act() to work correctly in the node test environment.
// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import renderer, { act } from "react-test-renderer";

jest.mock("react-native", () => {
  const React = require("react");
  const noop = () => {};
  const Animated = {
    Value: class AnimatedValue {
      _value: number;
      constructor(v: number) { this._value = v; }
      setValue(v: number) { this._value = v; }
      interpolate() { return this; }
    },
    View: ({ children, ...props }: { children?: React.ReactNode; [k: string]: unknown }) =>
      React.createElement("rn-animated-view", props, children),
    loop: () => ({ start: noop, stop: noop, reset: noop }),
    timing: () => ({ start: noop, stop: noop, reset: noop }),
  };
  const Easing = { linear: noop, ease: noop, in: () => noop, out: () => noop };
  return {
    Platform:     { OS: "ios", select: (o: Record<string, unknown>) => o.ios ?? o.default },
    StyleSheet:   { create: (s: unknown) => s, flatten: (s: unknown) => s },
    View:         ({ children, ...props }: { children?: React.ReactNode; [k: string]: unknown }) =>
                    React.createElement("rn-view", props, children),
    Text:         ({ children, ...props }: { children?: React.ReactNode; [k: string]: unknown }) =>
                    React.createElement("rn-text", props, children),
    Pressable:    ({ children, ...props }: { children?: React.ReactNode; [k: string]: unknown }) =>
                    React.createElement("rn-pressable", props, children),
    Image:        (props: Record<string, unknown>) =>
                    React.createElement("rn-image", props),
    Modal:        ({ children, visible }: { children?: React.ReactNode; visible?: boolean }) =>
                    visible ? React.createElement("rn-modal", {}, children) : null,
    StatusBar:    () => null,
    ActivityIndicator: () => null,
    PixelRatio:   { get: () => 3 },
    useColorScheme: () => "light",
    AppState:     { currentState: "active", addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
    Animated,
    Easing,
    LayoutAnimation: { configureNext: noop, Presets: { easeInEaseOut: {}, linear: {}, spring: {} } },
    UIManager: { setLayoutAnimationEnabledExperimental: noop },
  };
});

jest.mock("@expo/vector-icons", () => ({
  Feather: () => null,
  MaterialCommunityIcons: () => null,
}));

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem:    jest.fn().mockResolvedValue(null),
  setItem:    jest.fn().mockResolvedValue(undefined),
  removeItem: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/components/RetryImage", () => {
  const React = require("react");
  return {
    RetryImage: ({ uri, ...props }: { uri: string; [k: string]: unknown }) =>
      React.createElement("retry-image", { uri, ...props }),
  };
});

jest.mock("@/components/PinIcon", () => {
  const React = require("react");
  return {
    PinIcon: () => React.createElement("pin-icon"),
  };
});

// ─── @/components/PartCard ───────────────────────────────────────────────────
// PartCard fetches from the API and imports apiBase at module load (which
// throws in the test environment). Mock it out as a no-op.

jest.mock("@/components/PartCard", () => ({
  PartCard: () => null,
}));

jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());

let origConsoleError: typeof console.error;
beforeAll(() => {
  origConsoleError = console.error.bind(console);
  jest.spyOn(console, "error").mockImplementation(
    (msg: unknown, ...args: unknown[]) => {
      if (
        typeof msg === "string" &&
        (msg.includes("react-test-renderer is deprecated") ||
          msg.includes("Warning:"))
      ) return;
      origConsoleError(msg, ...args);
    },
  );
});
afterAll(() => { (console.error as jest.Mock).mockRestore?.(); });

import { ResultCard } from "@/components/ResultCard";
import type { SearchResult } from "@workspace/api-client-react";

function makeAisleBrowseResult(opts: {
  expandedDescription?: string;
  description?: string;
}): SearchResult {
  return {
    item: {
      id: 42,
      catalog: "RELAY-X",
      vendor: "EATON",
      description: opts.description ?? "Short description",
      expandedDescription: opts.expandedDescription,
      binLocations: ["09-02-050"],
    },
    confidence: 1,
    matchReason: "",
    seriesLabel: undefined,
    variants: [],
  } as unknown as SearchResult;
}

function allTextStrings(root: renderer.ReactTestInstance): string[] {
  return root
    .findAll((n) => (n.type as string) === "rn-text", { deep: true })
    .map((n) => (typeof n.props.children === "string" ? n.props.children : ""))
    .filter(Boolean);
}

describe("Aisle-browse shelf card — description display priority", () => {
  it("renders description as primary text when both fields are present (aisle-browse props: confidence=1, matchReason='')", async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <ResultCard
          result={makeAisleBrowseResult({
            description: "Primary description from description field",
            expandedDescription: "Expanded fallback text",
          })}
          rank={0}
        />,
      );
    });

    const texts = allTextStrings(tree.root);
    // description must appear as the primary text
    expect(texts).toContain("Primary description from description field");
    // expandedDescription must NOT be rendered when description is present
    expect(texts).not.toContain("Expanded fallback text");

    await act(async () => { tree.unmount(); });
  });

  it("SITG6: shows full description, not the shorter expandedDescription, when description is the longer field (aisle-browse props)", async () => {
    // Reproduces the original bug: item.description holds the full/long text,
    // item.expandedDescription holds a shorter snippet — the card must display
    // the full description, not the snippet.
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <ResultCard
          result={makeAisleBrowseResult({
            description: "Full technical specification for the EATON relay including all ratings and dimensions",
            expandedDescription: "EATON relay",
          })}
          rank={0}
        />,
      );
    });

    const texts = allTextStrings(tree.root);
    expect(texts).toContain("Full technical specification for the EATON relay including all ratings and dimensions");
    // The short snippet must not appear as the primary description text
    expect(texts).not.toContain("EATON relay");

    await act(async () => { tree.unmount(); });
  });

  it("falls back to expandedDescription when description is absent, instead of showing 'No description' (aisle-browse props)", async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <ResultCard
          result={makeAisleBrowseResult({
            description: "",
            expandedDescription: "Fallback expanded text used when description is empty",
          })}
          rank={0}
        />,
      );
    });

    const texts = allTextStrings(tree.root);
    expect(texts).toContain("Fallback expanded text used when description is empty");
    expect(texts).not.toContain("No description");

    await act(async () => { tree.unmount(); });
  });

  it("renders the plain description when expandedDescription is absent (aisle-browse props)", async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <ResultCard
          result={makeAisleBrowseResult({ description: "Plain description only" })}
          rank={0}
        />,
      );
    });

    const texts = allTextStrings(tree.root);
    expect(texts).toContain("Plain description only");
    expect(texts.every((t) => !t.includes("expanded"))).toBe(true);

    await act(async () => { tree.unmount(); });
  });
});
