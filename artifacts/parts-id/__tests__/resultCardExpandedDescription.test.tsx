/**
 * @jest-environment node
 *
 * Regression tests: ResultCard must render expandedDescription as the primary
 * text block for all users when present, and must also show the original
 * abbreviated description in a muted secondary role.
 *
 * A second case without expandedDescription confirms the component falls back
 * to the plain description field without breaking.
 *
 * Pattern mirrors resultCardPhotoSlots.test.tsx — all native/expo deps mocked
 * inline; component imported from its real source file.
 */

// Required for act() to work correctly in the node test environment.
// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import renderer, { act } from "react-test-renderer";

// ─── react-native ─────────────────────────────────────────────────────────────

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
    Image:        ({ uri, ...props }: { uri?: string; [k: string]: unknown }) =>
                    React.createElement("rn-image", { uri, ...props }),
    Modal:        ({ children, visible }: { children?: React.ReactNode; visible?: boolean }) =>
                    visible ? React.createElement("rn-modal", {}, children) : null,
    StatusBar:    () => null,
    ActivityIndicator: () => null,
    PixelRatio:   { get: () => 3 },
    useColorScheme: () => "light",
    AppState:     { currentState: "active", addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
  };
});

// ─── @expo/vector-icons ───────────────────────────────────────────────────────

jest.mock("@expo/vector-icons", () => ({
  Feather: () => null,
  MaterialCommunityIcons: () => null,
}));

// ─── @react-native-async-storage/async-storage ───────────────────────────────

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem:    jest.fn().mockResolvedValue(null),
  setItem:    jest.fn().mockResolvedValue(undefined),
  removeItem: jest.fn().mockResolvedValue(undefined),
}));

// ─── @/components/RetryImage ─────────────────────────────────────────────────

jest.mock("@/components/RetryImage", () => {
  const React = require("react");
  return {
    RetryImage: ({ uri, ...props }: { uri: string; [k: string]: unknown }) =>
      React.createElement("retry-image", { uri, ...props }),
  };
});

// ─── @/components/PinIcon ────────────────────────────────────────────────────

jest.mock("@/components/PinIcon", () => {
  const React = require("react");
  return {
    PinIcon: () => React.createElement("pin-icon"),
  };
});

// ─── @/hooks/useColors ───────────────────────────────────────────────────────

jest.mock("@/hooks/useColors", () => ({
  useColors: () => ({
    background: "#fff", foreground: "#000", card: "#fff", border: "#ccc",
    primary: "#3b82f6", primaryForeground: "#fff", muted: "#f1f5f9",
    mutedForeground: "#64748b", destructive: "#ef4444",
    success: "#22c55e", warning: "#f59e0b", accent: "#f1f5f9",
    accentForeground: "#000",
  }),
}));

// ─── Suppress react-test-renderer deprecation warnings ───────────────────────

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

// ─── Subject under test ───────────────────────────────────────────────────────

import { ResultCard } from "@/components/ResultCard";
import type { SearchResult } from "@workspace/api-client-react";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function makeResult(overrides: {
  description?: string;
  expandedDescription?: string;
}): SearchResult {
  return {
    item: {
      id: 1,
      catalog: "XYZ-999",
      vendor: "ACME",
      description: overrides.description ?? "Short desc",
      expandedDescription: overrides.expandedDescription,
      binLocations: ["B2"],
    },
    confidence: 0.9,
  } as unknown as SearchResult;
}

/** Collect the text content of all rn-text nodes whose children is a string. */
function allTextStrings(root: renderer.ReactTestInstance): string[] {
  return root
    .findAll((n) => (n.type as string) === "rn-text", { deep: true })
    .map((n) => (typeof n.props.children === "string" ? n.props.children : ""))
    .filter(Boolean);
}

// =============================================================================
// ResultCard — expandedDescription rendering
// =============================================================================

describe("ResultCard — expandedDescription rendering", () => {
  it("renders expandedDescription as the primary text when the field is present", async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <ResultCard
          result={makeResult({
            description: "Short desc",
            expandedDescription: "A much longer expanded description of the part",
          })}
          rank={0}
        />,
      );
    });

    const texts = allTextStrings(tree.root);
    expect(texts).toContain("A much longer expanded description of the part");

    await act(async () => { tree.unmount(); });
  });

  it("also renders the original abbreviated description in a muted role when expandedDescription is present", async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <ResultCard
          result={makeResult({
            description: "Short desc",
            expandedDescription: "A much longer expanded description of the part",
          })}
          rank={0}
        />,
      );
    });

    // Both texts must appear in the tree.
    const texts = allTextStrings(tree.root);
    expect(texts).toContain("A much longer expanded description of the part");
    expect(texts).toContain("Short desc");

    // The abbreviated description node must carry the muted foreground color,
    // confirming it renders in the secondary/muted role (descriptionAbbrev style).
    // The style prop is an array [cardStyles.descriptionAbbrev, { color, fontSize }],
    // so we search the array members for the colour entry.
    const abbrevNode = tree.root.findAll(
      (n) => {
        if ((n.type as string) !== "rn-text") return false;
        if (n.props.children !== "Short desc") return false;
        const style = n.props.style;
        const styleArr: unknown[] = Array.isArray(style) ? style : [style];
        return styleArr.some(
          (s) =>
            s !== null &&
            typeof s === "object" &&
            (s as Record<string, unknown>).color === "#64748b",
        );
      },
      { deep: true },
    );
    expect(abbrevNode).toHaveLength(1);

    await act(async () => { tree.unmount(); });
  });

  it("renders only the plain description when expandedDescription is absent", async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <ResultCard
          result={makeResult({ description: "Plain description only" })}
          rank={0}
        />,
      );
    });

    const texts = allTextStrings(tree.root);
    expect(texts).toContain("Plain description only");

    // No expanded-description text present.
    expect(texts).not.toContain("A much longer expanded description of the part");

    await act(async () => { tree.unmount(); });
  });

  it("renders the fallback text when both description and expandedDescription are absent", async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <ResultCard
          result={makeResult({ description: "" })}
          rank={0}
        />,
      );
    });

    const texts = allTextStrings(tree.root);
    expect(texts).toContain("No description");

    await act(async () => { tree.unmount(); });
  });
});
