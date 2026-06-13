/**
 * @jest-environment node
 *
 * Regression guard: the aisle-browse shelf card (ResultCard rendered by
 * BrowseByAisle when a bin is selected) must surface `expandedDescription`
 * when the field is set on the item, just as the main search ResultCard does.
 *
 * This mirrors `resultCardExpandedDescription.test.tsx` but uses the exact
 * prop shape that BrowseByAisle passes to ResultCard:
 *   { item, confidence: 1, matchReason: "", seriesLabel: undefined, variants: [] }
 *
 * Without this guard a refactor that strips expandedDescription rendering from
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

jest.mock("@/hooks/useColors", () => ({
  useColors: () => ({
    background: "#fff", foreground: "#000", card: "#fff", border: "#ccc",
    primary: "#3b82f6", primaryForeground: "#fff", muted: "#f1f5f9",
    mutedForeground: "#64748b", destructive: "#ef4444",
    success: "#22c55e", warning: "#f59e0b", accent: "#f1f5f9",
    accentForeground: "#000",
  }),
}));

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

describe("Aisle-browse shelf card — expandedDescription rendering", () => {
  it("renders expandedDescription as primary text when the field is set (aisle-browse props: confidence=1, matchReason='')", async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <ResultCard
          result={makeAisleBrowseResult({
            description: "Short desc",
            expandedDescription: "Full technical spec from the expanded description field",
          })}
          rank={0}
        />,
      );
    });

    const texts = allTextStrings(tree.root);
    expect(texts).toContain("Full technical spec from the expanded description field");

    await act(async () => { tree.unmount(); });
  });

  it("also renders the abbreviated description in a muted role alongside expandedDescription", async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <ResultCard
          result={makeAisleBrowseResult({
            description: "Short desc",
            expandedDescription: "Full technical spec from the expanded description field",
          })}
          rank={0}
        />,
      );
    });

    const texts = allTextStrings(tree.root);
    expect(texts).toContain("Full technical spec from the expanded description field");
    expect(texts).toContain("Short desc");

    await act(async () => { tree.unmount(); });
  });

  it("falls back to the plain description when expandedDescription is absent (aisle-browse props)", async () => {
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
