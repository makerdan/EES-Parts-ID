import type { InventoryItem, SearchResult } from "@workspace/api-client-react";
import React from "react";
import { render, act } from "@testing-library/react-native";
import type { RenderResult } from "@testing-library/react-native";
import type { TestInstance as TRTestInstance } from "test-renderer";

import { ResultCard } from "@/components/ResultCard";

jest.mock("@expo/vector-icons", () => ({
  Feather: "Feather",
}));

jest.mock("expo-font", () => ({
  isLoaded: jest.fn(() => true),
  loadAsync: jest.fn(() => Promise.resolve()),
}));

const mockPartCard = jest.fn((_props: Record<string, unknown>) => null);

jest.mock("@/components/PartCard", () => ({
  PartCard: (props: Record<string, unknown>) => {
    mockPartCard(props);
    return null;
  },
}));

jest.mock("@/components/PhotoLightbox", () => ({
  PhotoLightbox: () => null,
}));

jest.mock("@/components/PinIcon", () => ({
  PinIcon: () => null,
}));

jest.mock("@/components/RetryImage", () => ({
  RetryImage: () => null,
}));

jest.mock("@/hooks/useColors", () => ({
  useColors: () => ({
    background: "#fff",
    card: "#fff",
    foreground: "#000",
    primary: "#007aff",
    primaryForeground: "#fff",
    muted: "#f3f4f6",
    mutedForeground: "#6b7280",
    border: "#e5e7eb",
    accent: "#fef3c7",
    accentForeground: "#92400e",
    destructive: "#ef4444",
    success: "#10b981",
    warning: "#f59e0b",
  }),
}));

jest.mock("@/components/SizeVariantDropdown", () => ({
  getSizeLabel: (size: string | null | undefined, description: string | null | undefined): string => {
    if (size && String(size).trim()) return String(size).trim();
    const desc = (description ?? "").trim();
    if (!desc) return "—";
    return desc.length > 20 ? desc.slice(0, 20).trim() + "…" : desc;
  },
  SizeVariantDropdown: ({
    onSelect,
    variants,
  }: {
    onSelect: (item: InventoryItem) => void;
    variants: InventoryItem[];
  }) => {
    const { View, Text, Pressable } = require("react-native") as typeof import("react-native");
    return (
      <View testID="size-variant-dropdown">
        <Text testID="variant-count">{variants.length}</Text>
        {variants.map((v: InventoryItem) => (
          <Pressable key={v.id} testID={`select-variant-${v.id}`} onPress={() => onSelect(v)}>
            <Text>{v.catalog}</Text>
          </Pressable>
        ))}
      </View>
    );
  },
}));

let _nextId = 100;
function makeItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: _nextId++,
    catalog: "BOLT-001",
    vendor: "Acme",
    description: "Standard bolt",
    expandedDescription: null,
    binLocations: ["A1"],
    barcodes: [],
    aiKeywords: [],
    imageUrl: null,
    imageUrl2: null,
    thumbnailUrl: null,
    thumbnailUrl2: null,
    dimensions: null,
    enrichedAt: null,
    ...overrides,
  } as InventoryItem;
}

function makeVariant(catalog: string): InventoryItem {
  return makeItem({ catalog, description: `Variant ${catalog}` });
}

function makeResult(item: InventoryItem, variants: InventoryItem[] = []): SearchResult {
  return {
    item,
    confidence: 0.95,
    seriesLabel: null,
    variants,
  } as SearchResult;
}

type TestInstance = TRTestInstance;

function findAllWithTestID(root: NonNullable<RenderResult["root"]>, testID: string): TestInstance[] {
  return root.queryAll((n) => n.props.testID === testID, { includeSelf: true });
}

beforeEach(() => {
  _nextId = 100;
});

describe("ResultCard — size variant dropdown", () => {
  it("does not render dropdown when result has no variants", async () => {
    const result = makeResult(makeItem());
    const rendered = await render(<ResultCard result={result} rank={0} />);
    const dropdown = findAllWithTestID(rendered.root!, "size-variant-dropdown");
    expect(dropdown).toHaveLength(0);
  });

  it("renders dropdown on collapsed card when variants are present", async () => {
    const variants = [makeVariant("BOLT-002"), makeVariant("BOLT-003")];
    const result = makeResult(makeItem(), variants);
    const rendered = await render(<ResultCard result={result} rank={0} />);
    const dropdown = findAllWithTestID(rendered.root!, "size-variant-dropdown");
    expect(dropdown.length).toBeGreaterThan(0);
    const countEls = findAllWithTestID(rendered.root!, "variant-count");
    expect(countEls.length).toBeGreaterThan(0);
  });

  it("switches activeItem when a variant is selected", async () => {
    const original = makeItem({ catalog: "BOLT-001", vendor: "Acme" });
    const variant = makeVariant("BOLT-002");
    const result = makeResult(original, [variant]);
    const rendered = await render(<ResultCard result={result} rank={0} />);

    const selectBtns = findAllWithTestID(
      rendered.root!,
      `select-variant-${variant.id}`,
    );
    expect(selectBtns.length).toBeGreaterThan(0);
    await act(async () => {
      selectBtns[0]!.props.onPress();
    });

    const catalogTexts = rendered.root!.queryAll(
      (n) =>
        String(n.props.children) === "BOLT-002",
      { includeSelf: true },
    );
    expect(catalogTexts.length).toBeGreaterThan(0);
  });

  it("passes the selected variant's OP and OQ to PartCard", async () => {
    mockPartCard.mockClear();
    const original = makeItem({ catalog: "BOLT-001", orderPurchase: 2, orderQuantity: 8 });
    const variant = makeVariant("BOLT-002");
    Object.assign(variant, { orderPurchase: 0, orderQuantity: 16 });
    const result = makeResult(original, [variant]);
    const rendered = await render(<ResultCard result={result} rank={0} />);

    await act(async () => {
      findAllWithTestID(rendered.root!, `select-variant-${variant.id}`)[0]!.props.onPress();
    });

    const lastProps = mockPartCard.mock.lastCall?.[0] as
      | { orderPurchase?: number; orderQuantity?: number }
      | undefined;
    expect(lastProps).toEqual(expect.objectContaining({
      orderPurchase: 0,
      orderQuantity: 16,
    }));
  });

  it("shows back button after selecting a variant", async () => {
    const original = makeItem({ catalog: "BOLT-001" });
    const variant = makeVariant("BOLT-002");
    const result = makeResult(original, [variant]);
    const rendered = await render(<ResultCard result={result} rank={0} />);

    await act(async () => {
      findAllWithTestID(rendered.root!, `select-variant-${variant.id}`)[0]!.props.onPress();
    });

    const backBtns = rendered.root!.queryAll(
      (n) =>
        typeof n.props.accessibilityLabel === "string" &&
        (n.props.accessibilityLabel as string).startsWith("Back to"),
      { includeSelf: true },
    );
    expect(backBtns.length).toBeGreaterThan(0);
  });

  it("restores original item and hides back button after pressing back", async () => {
    const original = makeItem({ catalog: "BOLT-001" });
    const variant = makeVariant("BOLT-002");
    const result = makeResult(original, [variant]);
    const rendered = await render(<ResultCard result={result} rank={0} />);

    await act(async () => {
      findAllWithTestID(rendered.root!, `select-variant-${variant.id}`)[0]!.props.onPress();
    });

    const backBtn = rendered.root!.queryAll(
      (n) =>
        typeof n.props.accessibilityLabel === "string" &&
        (n.props.accessibilityLabel as string).startsWith("Back to"),
      { includeSelf: true },
    )[0];
    await act(async () => {
      backBtn!.props.onPress();
    });

    const catalogTexts = rendered.root!.queryAll(
      (n) => String(n.props.children) === "BOLT-001",
      { includeSelf: true },
    );
    expect(catalogTexts.length).toBeGreaterThan(0);

    const backBtnsAfter = rendered.root!.queryAll(
      (n) =>
        typeof n.props.accessibilityLabel === "string" &&
        (n.props.accessibilityLabel as string).startsWith("Back to"),
      { includeSelf: true },
    );
    expect(backBtnsAfter).toHaveLength(0);
  });
});
