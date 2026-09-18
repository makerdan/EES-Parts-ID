/**
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
import { render, act } from "@testing-library/react-native";
import type { RenderResult } from "@testing-library/react-native";
import type { TestInstance } from "test-renderer";

// Use the canonical artifact-wide mock so native APIs cannot drift between
// description suites.
jest.mock("react-native", () => require("./helpers/mapMocks").createReactNativeMock());

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

function allTextStrings(root: TestInstance): string[] {
  return root
    .queryAll((n: TestInstance) => (n.type as string) === "Text", { includeSelf: true })
    .map((n: TestInstance) => (typeof n.props.children === "string" ? n.props.children : ""))
    .filter(Boolean);
}

describe("Aisle-browse shelf card — description display priority", () => {
  it("renders description as primary text when both fields are present (aisle-browse props: confidence=1, matchReason='')", async () => {
    const result = await render(
      <ResultCard
        result={makeAisleBrowseResult({
          description: "Primary description from description field",
          expandedDescription: "Expanded fallback text",
        })}
        rank={0}
      />,
    );

    const texts = allTextStrings(result.root!);
    // description must appear as the primary text
    expect(texts).toContain("Primary description from description field");
    // expandedDescription must NOT be rendered when description is present
    expect(texts).not.toContain("Expanded fallback text");

    await result.unmount();
  });

  it("SITG6: shows full description, not the shorter expandedDescription, when description is the longer field (aisle-browse props)", async () => {
    // Reproduces the original bug: item.description holds the full/long text,
    // item.expandedDescription holds a shorter snippet — the card must display
    // the full description, not the snippet.
    const result = await render(
      <ResultCard
        result={makeAisleBrowseResult({
          description: "Full technical specification for the EATON relay including all ratings and dimensions",
          expandedDescription: "EATON relay",
        })}
        rank={0}
      />,
    );

    const texts = allTextStrings(result.root!);
    expect(texts).toContain("Full technical specification for the EATON relay including all ratings and dimensions");
    // The short snippet must not appear as the primary description text
    expect(texts).not.toContain("EATON relay");

    await result.unmount();
  });

  it("falls back to expandedDescription when description is absent, instead of showing 'No description' (aisle-browse props)", async () => {
    const result = await render(
      <ResultCard
        result={makeAisleBrowseResult({
          description: "",
          expandedDescription: "Fallback expanded text used when description is empty",
        })}
        rank={0}
      />,
    );

    const texts = allTextStrings(result.root!);
    expect(texts).toContain("Fallback expanded text used when description is empty");
    expect(texts).not.toContain("No description");

    await result.unmount();
  });

  it("renders the plain description when expandedDescription is absent (aisle-browse props)", async () => {
    const result = await render(
      <ResultCard
        result={makeAisleBrowseResult({ description: "Plain description only" })}
        rank={0}
      />,
    );

    const texts = allTextStrings(result.root!);
    expect(texts).toContain("Plain description only");
    expect(texts.every((t) => !t.includes("expanded"))).toBe(true);

    await result.unmount();
  });
});
