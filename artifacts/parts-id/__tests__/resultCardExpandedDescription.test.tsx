/**
 *
 * Regression tests: ResultCard must render `description` as the primary text
 * block for all users when present, and must fall back to `expandedDescription`
 * only when `description` is absent or empty.
 *
 * A second case without expandedDescription confirms the component renders
 * the plain description without breaking.
 *
 * Pattern mirrors resultCardPhotoSlots.test.tsx — all native/expo deps mocked
 * inline; component imported from its real source file.
 */

// Required for act() to work correctly in the node test environment.
// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { render } from "@testing-library/react-native";
import type { RenderResult } from "@testing-library/react-native";
import type { TestInstance } from "test-renderer";

// ─── react-native ─────────────────────────────────────────────────────────────

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
                    React.createElement("Text", props, children),
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
    Animated,
    Easing,
    LayoutAnimation: { configureNext: noop, Presets: { easeInEaseOut: {}, linear: {}, spring: {} } },
    UIManager: { setLayoutAnimationEnabledExperimental: noop },
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

// ─── @/components/PartCard ───────────────────────────────────────────────────
// PartCard fetches from the API and imports apiBase at module load (which
// throws in the test environment). Mock it out as a no-op.

jest.mock("@/components/PartCard", () => ({
  PartCard: () => null,
}));

// ─── @/hooks/useColors ───────────────────────────────────────────────────────

jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());

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
function allTextStrings(root: RenderResult["root"]): string[] {
  return root!
    .queryAll((n: TestInstance) => (n.type as string) === "Text", { includeSelf: true })
    .map((n: TestInstance) => (typeof n.props.children === "string" ? n.props.children : ""))
    .filter(Boolean);
}

// =============================================================================
// ResultCard — description display priority
// =============================================================================

describe("ResultCard — description display priority", () => {
  it("renders description as the primary text when both description and expandedDescription are present", async () => {
    const result = await render(
      <ResultCard
        result={makeResult({
          description: "Primary description text",
          expandedDescription: "Expanded description that is a fallback only",
        })}
        rank={0}
      />,
    );

    const texts = allTextStrings(result.root);
    // description must appear in the card
    expect(texts).toContain("Primary description text");
    // expandedDescription must NOT be rendered when description is present
    expect(texts).not.toContain("Expanded description that is a fallback only");

    await result.unmount();
  });

  it("SITG6: shows the full description text, not the shorter expandedDescription, when description is the longer field", async () => {
    // Reproduces the original bug: item.description holds the full/long text,
    // item.expandedDescription holds a shorter snippet — the card must display
    // the full description, not the snippet.
    const result = await render(
      <ResultCard
        result={makeResult({
          description: "Full detailed description of the relay with all specifications included",
          expandedDescription: "Relay",
        })}
        rank={0}
      />,
    );

    const texts = allTextStrings(result.root);
    expect(texts).toContain("Full detailed description of the relay with all specifications included");
    // The short snippet must not appear as the primary description text
    expect(texts).not.toContain("Relay");

    await result.unmount();
  });

  it("renders only the plain description when expandedDescription is absent", async () => {
    const result = await render(
      <ResultCard
        result={makeResult({ description: "Plain description only" })}
        rank={0}
      />,
    );

    const texts = allTextStrings(result.root);
    expect(texts).toContain("Plain description only");

    await result.unmount();
  });

  it("falls back to expandedDescription when description is absent, instead of showing 'No description'", async () => {
    const result = await render(
      <ResultCard
        result={makeResult({
          description: "",
          expandedDescription: "Fallback expanded text shown when description is empty",
        })}
        rank={0}
      />,
    );

    const texts = allTextStrings(result.root);
    expect(texts).toContain("Fallback expanded text shown when description is empty");
    expect(texts).not.toContain("No description");

    await result.unmount();
  });

  it("renders the fallback text when both description and expandedDescription are absent", async () => {
    const result = await render(
      <ResultCard
        result={makeResult({ description: "" })}
        rank={0}
      />,
    );

    const texts = allTextStrings(result.root);
    expect(texts).toContain("No description");

    await result.unmount();
  });
});
