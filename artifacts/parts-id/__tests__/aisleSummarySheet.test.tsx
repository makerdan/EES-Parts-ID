/**
 * @jest-environment node
 *
 * Unit tests for AisleSummarySheet.
 *
 * Verifies that:
 *  - The sheet title reads "Aisle {N}" derived from zone.aisleNum (NOT from any
 *    removed `label` field on WarehouseZone).
 *  - The component renders null when zone is null or has no matching inventory.
 *  - The "Browse this aisle" CTA fires onBrowse(zone) and onClose().
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
    Modal: function Modal({ children, visible, onRequestClose }: { children?: React.ReactNode; visible: boolean; onRequestClose?: () => void }) {
      if (!visible) return null;
      return React.createElement("rn-modal", { onRequestClose }, children);
    },
    View: function View({ children, ...props }: { children?: React.ReactNode; [k: string]: unknown }) {
      return React.createElement("rn-view", props, children);
    },
    Text: function Text({ children, ...props }: { children?: React.ReactNode; [k: string]: unknown }) {
      return React.createElement("rn-text", props, children);
    },
    Pressable: function Pressable({ children, onPress, ...props }: { children?: React.ReactNode; onPress?: () => void; [k: string]: unknown }) {
      return React.createElement("rn-pressable", { onPress, ...props }, children);
    },
    StyleSheet: {
      create: (s: unknown) => s,
      flatten: (s: unknown) => s,
    },
  };
});

// ─── @/hooks/useColors ────────────────────────────────────────────────────────

jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());

// ─── Subject under test ───────────────────────────────────────────────────────

import { AisleSummarySheet } from "@/components/AisleSummarySheet";
import type { InventoryItem } from "@workspace/api-client-react";
import type { WarehouseZone } from "@/lib/aisleHierarchy";

// ─── Helpers ──────────────────────────────────────────────────────────────────

type Inst = ReturnType<typeof renderer.create>["root"];

function allText(root: Inst): string[] {
  const out: string[] = [];
  function walk(node: Inst) {
    if ((node.type as string) === "rn-text") {
      const children = (node.props as { children?: unknown }).children;
      if (typeof children === "string") out.push(children);
      if (Array.isArray(children)) {
        out.push(children.filter((c): c is string => typeof c === "string").join(""));
      }
    }
    node.children.forEach((c) => { if (typeof c !== "string") walk(c as Inst); });
  }
  walk(root);
  return out;
}

function makeItem(id: number, binLocations: string[]): InventoryItem {
  return {
    id,
    vendor: "Test",
    catalog: `CAT-${id}`,
    description: `Item ${id}`,
    binLocations,
    aiKeywords: [],
    enrichedAt: null,
  } as unknown as InventoryItem;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("AisleSummarySheet", () => {
  const onClose = jest.fn();
  const onBrowse = jest.fn();

  beforeEach(() => {
    onClose.mockReset();
    onBrowse.mockReset();
  });

  it("renders null when zone is null", () => {
    let root: renderer.ReactTestRenderer;
    act(() => {
      root = renderer.create(
        <AisleSummarySheet zone={null} inventory={[]} onClose={onClose} onBrowse={onBrowse} />,
      );
    });
    expect(root!.toJSON()).toBeNull();
  });

  it("renders null when no inventory items match the zone's aisle", () => {
    const zone: WarehouseZone = { aisleNum: 5 };
    const inventory = [makeItem(1, ["03-01-001"]), makeItem(2, ["07-02-100"])];
    let root: renderer.ReactTestRenderer;
    act(() => {
      root = renderer.create(
        <AisleSummarySheet zone={zone} inventory={inventory} onClose={onClose} onBrowse={onBrowse} />,
      );
    });
    expect(root!.toJSON()).toBeNull();
  });

  it("renders the title as 'Aisle {aisleNum}' — not from a label field", () => {
    const zone: WarehouseZone = { aisleNum: 18 };
    const inventory = [makeItem(1, ["18-02-001"]), makeItem(2, ["18-04-200"])];
    let root: renderer.ReactTestRenderer;
    act(() => {
      root = renderer.create(
        <AisleSummarySheet zone={zone} inventory={inventory} onClose={onClose} onBrowse={onBrowse} />,
      );
    });
    const texts = allText(root!.root);
    expect(texts).toContain("Aisle 18");
    expect(texts.some(t => t.toLowerCase().includes("label"))).toBe(false);
  });

  it("uses aisleNum to build the title for any aisle number", () => {
    const zone: WarehouseZone = { aisleNum: 7 };
    const inventory = [makeItem(10, ["07-01-050"])];
    let root: renderer.ReactTestRenderer;
    act(() => {
      root = renderer.create(
        <AisleSummarySheet zone={zone} inventory={inventory} onClose={onClose} onBrowse={onBrowse} />,
      );
    });
    const texts = allText(root!.root);
    expect(texts).toContain("Aisle 7");
  });

  it("shows the section hint when sectionNumbers is provided", () => {
    const zone: WarehouseZone = { aisleNum: 3, sectionNumbers: [1, 2] };
    const inventory = [makeItem(1, ["03-01-001"]), makeItem(2, ["03-02-100"])];
    let root: renderer.ReactTestRenderer;
    act(() => {
      root = renderer.create(
        <AisleSummarySheet zone={zone} inventory={inventory} onClose={onClose} onBrowse={onBrowse} />,
      );
    });
    const texts = allText(root!.root);
    expect(texts.some(t => t.includes("Section"))).toBe(true);
  });

  it("calls onBrowse(zone) and onClose() when the CTA is pressed", () => {
    const zone: WarehouseZone = { aisleNum: 9 };
    const inventory = [makeItem(5, ["09-01-001"])];
    let root: renderer.ReactTestRenderer;
    act(() => {
      root = renderer.create(
        <AisleSummarySheet zone={zone} inventory={inventory} onClose={onClose} onBrowse={onBrowse} />,
      );
    });
    function hasTextBrowse(c: unknown): boolean {
      if (!c) return false;
      if (typeof c === "string") return c.includes("Browse");
      if (Array.isArray(c)) return c.some(hasTextBrowse);
      if (typeof c === "object" && c !== null && "props" in c) {
        return hasTextBrowse((c as { props?: { children?: unknown } }).props?.children);
      }
      return false;
    }
    const allPressables = root!.root.findAll(n => (n.type as string) === "rn-pressable");
    const cta = allPressables.find(n => hasTextBrowse((n.props as { children?: unknown }).children));
    expect(cta).toBeDefined();
    act(() => {
      (cta!.props as { onPress?: () => void }).onPress?.();
    });
    expect(onBrowse).toHaveBeenCalledTimes(1);
    expect(onBrowse).toHaveBeenCalledWith(zone);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
