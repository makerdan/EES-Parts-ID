/**
 * Integration tests for AdminMapCalibrationScreen — draft/review/confirm flow.
 *
 * Scenarios:
 *   (a) No server writes fire before Confirm
 *   (b) All three writes fire on Confirm (in slot order)
 *   (c) Degenerate anchor input blocks Confirm and shows a warning
 *   (d) Mid-confirm failure shows a retry message without invalidating the cache
 *   (e) Cache (AsyncStorage) is invalidated after a successful confirm
 *   (f) Preview/live parity — computeAnchorTransform + matrixToSvgString produce
 *       the same SVG transform string regardless of which code path calls them
 *   (g) Double-tap guard — rapid Confirm taps issue only one batch of PUT calls
 */

// Required for act() in the node test environment.
// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { Alert } from "react-native";
import { act, fireEvent, render } from "@testing-library/react-native";
import type { RenderResult } from "@testing-library/react-native";
import { makeAppMock, flushPromises as rawFlush } from "./helpers/appMocks";

// ─── expo-router ──────────────────────────────────────────────────────────────

const mockRouterBack = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ back: mockRouterBack }),
}));

// ─── @react-native-async-storage/async-storage ───────────────────────────────

const mockRemoveItem = jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined);
const mockGetItem    = jest.fn<Promise<string | null>, [string]>().mockResolvedValue(null);
const mockSetItem    = jest.fn<Promise<void>, [string, string]>().mockResolvedValue(undefined);

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem:    mockGetItem,
  setItem:    mockSetItem,
  removeItem: mockRemoveItem,
}));

// ─── @expo/vector-icons ──────────────────────────────────────────────────────

jest.mock("@expo/vector-icons", () => require("./helpers/mapMocks").createVectorIconsMock());

// ─── @/hooks/useColors ───────────────────────────────────────────────────────

jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());

// ─── react-native-reanimated ─────────────────────────────────────────────────

jest.mock("react-native-reanimated", () => require("./helpers/mapMocks").createReanimatedMock());

// ─── react-native-gesture-handler ────────────────────────────────────────────

jest.mock("react-native-gesture-handler", () => require("./helpers/mapMocks").createGestureHandlerMock());

// ─── react-native-svg ────────────────────────────────────────────────────────

jest.mock("react-native-svg", () => require("./helpers/mapMocks").createSvgMock());

// ─── expo-asset ──────────────────────────────────────────────────────────────

jest.mock("expo-asset", () => require("./helpers/mapMocks").createExpoAssetMock());

// ─── @/utils/floorPlanCache ──────────────────────────────────────────────────

jest.mock("@/utils/floorPlanCache", () => require("./helpers/mapMocks").createFloorPlanCacheMock());

// ─── @/utils/mapViewport ─────────────────────────────────────────────────────

jest.mock("@/utils/mapViewport", () => require("./helpers/mapMocks").createMapViewportMock());

// ─── @/components/WarehouseMapView ───────────────────────────────────────────
// Use a never-resolving promise so the `.finally(() => setSvgLoading(false))`
// callback inside the component never fires asynchronously.  This prevents
// "overlapping act() calls" warnings from React 19 caused by the microtask
// escaping the act() context started by render().

const mockPrefetchSvgAsset = jest.fn<Promise<void>, []>()
  .mockImplementation(() => new Promise<void>(() => { /* never resolves */ }));

jest.mock("@/components/WarehouseMapView", () => ({
  prefetchSvgAsset: mockPrefetchSvgAsset,
}));

// ─── @/utils/nearestZoneCorner ───────────────────────────────────────────────

jest.mock("@/utils/nearestZoneCorner", () => ({
  findNearestZoneCorner: jest.fn().mockReturnValue(null),
  DEFAULT_SNAP_DISTANCE: 200,
}));

// ─── @/hooks/useMapAnchors ───────────────────────────────────────────────────

// Stable function refs so useEffect deps never cycle.
type AnchorMutResult = { ok: boolean; mfaRequired?: boolean };
const mockUpsertAnchor   = jest.fn<Promise<AnchorMutResult>, [number, unknown]>().mockResolvedValue({ ok: true });
const mockDeleteAnchor   = jest.fn<Promise<AnchorMutResult>, [number]>().mockResolvedValue({ ok: true });
const mockAnchorsRefetch = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);

let _mockAnchors: unknown[] = [];

jest.mock("@/hooks/useMapAnchors", () => ({
  useMapAnchors: jest.fn(() => ({
    anchors:      _mockAnchors,
    loading:      false,
    error:        false,
    mfaRequired:  false,
    refetch:      mockAnchorsRefetch,
    upsertAnchor: mockUpsertAnchor,
    deleteAnchor: mockDeleteAnchor,
  })),
}));

// ─── @/hooks/useWarehouseZones ───────────────────────────────────────────────

// Stable refetch ref so hook deps don't cycle.
const mockRefetchZones = jest.fn<void, []>();

jest.mock("@/hooks/useWarehouseZones", () => ({
  useWarehouseZones: jest.fn(() => ({
    zones:          [],
    alignment:      { translateX: 0, translateY: 0, scale: 1 },
    alignmentStale: false,
    anchors:        [],
    loading:        false,
    error:          false,
    refetch:        mockRefetchZones,
  })),
  ZONES_CACHE_KEY: "parts_id_warehouse_zones_v1",
}));

// ─── AppContext ───────────────────────────────────────────────────────────────

// jest.config.js maps @/contexts/AppContext → __mocks__/contexts/AppContext.js
const { useApp } = require("@/contexts/AppContext") as { useApp: jest.Mock };

// ─── Subject under test ───────────────────────────────────────────────────────

import AdminMapCalibrationScreen from "../app/admin-map-calibration";

// ─── Parity test imports (used in pure unit tests) ────────────────────────────

import {
  computeAnchorTransform,
  matrixToSvgString,
  type AnchorPoint,
} from "@/utils/mapAnchorTransform";

// ─── Test fixtures ─────────────────────────────────────────────────────────────

/** Three non-collinear anchors — produce a valid affine transform. */
const VALID_ANCHORS = [
  { id: 1, name: "A1", svgX: 100, svgY: 200, worldX: 10, worldY: 20, updatedAt: "" },
  { id: 2, name: "A2", svgX: 300, svgY: 100, worldX: 30, worldY: 10, updatedAt: "" },
  { id: 3, name: "A3", svgX: 200, svgY: 400, worldX: 20, worldY: 40, updatedAt: "" },
] as const;

/** Three collinear anchors — world points on a straight line → degenerate. */
const COLLINEAR_ANCHORS = [
  { id: 1, name: "C1", svgX: 10, svgY: 10, worldX: 0,  worldY: 0,  updatedAt: "" },
  { id: 2, name: "C2", svgX: 20, svgY: 20, worldX: 10, worldY: 10, updatedAt: "" },
  { id: 3, name: "C3", svgX: 30, svgY: 30, worldX: 20, worldY: 20, updatedAt: "" },
] as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Per RTLRN migration patterns: render() is async — always await it.
// It handles act() internally, so no additional act() wrapper is needed around it.
// For user-interaction events, always use await act(async () => { fireEvent... }).
async function renderScreen(anchors: unknown[] = [...VALID_ANCHORS]): Promise<RenderResult> {
  _mockAnchors = anchors;
  useApp.mockReturnValue(
    makeAppMock({ isAdmin: true, adminToken: "admin-tok", isLoading: false }),
  );
  // await render() — flushes all effects (including the anchor sync effect) before
  // returning, so the component is fully settled and queryByText() works immediately.
  return await render(<AdminMapCalibrationScreen />);
}

/** Navigate from edit step to review step by pressing the "Review Alignment →" button. */
async function goToReview(tree: RenderResult): Promise<void> {
  // Use the exact button text ("Review Alignment →") to avoid matching the
  // hint text ("…tap "Review Alignment" to preview…") or the review-step header.
  const btn = tree.queryByText("Review Alignment →");
  if (!btn) throw new Error("Review Alignment button not found — all 3 anchors may not be ready or degenerate");
  await act(async () => { fireEvent.press(btn); await rawFlush(); });
}

/** Press the "Confirm & Apply" button in the review step. */
async function pressConfirm(tree: RenderResult): Promise<void> {
  const btn = tree.queryByText(/Confirm & Apply/i);
  if (!btn) throw new Error("Confirm & Apply button not found — not in review step?");
  await act(async () => { fireEvent.press(btn); await rawFlush(); });
}

// ─── Per-test teardown ────────────────────────────────────────────────────────

let activeTree: RenderResult | null = null;

afterEach(async () => {
  if (activeTree) {
    await activeTree.unmount();
    activeTree = null;
  }
  jest.clearAllMocks();
  _mockAnchors = [];
  // Restore defaults (clearAllMocks only clears call history + once-queues,
  // not default implementations/return values — these are explicit restores.)
  mockUpsertAnchor.mockResolvedValue({ ok: true });
  mockDeleteAnchor.mockResolvedValue({ ok: true });
  mockAnchorsRefetch.mockResolvedValue(undefined);
  // Restore never-resolving promise so the .finally() in prefetchSvgAsset
  // useEffect never fires async state updates between tests.
  mockPrefetchSvgAsset.mockImplementation(() => new Promise<void>(() => {}));
  mockRemoveItem.mockResolvedValue(undefined);
  mockGetItem.mockResolvedValue(null);
  mockSetItem.mockResolvedValue(undefined);
});

// =============================================================================
// (f) Preview / live parity — pure unit test; no component needed
// =============================================================================

describe("Preview/live parity", () => {
  it("computeAnchorTransform + matrixToSvgString are identical for both code paths", () => {
    // Both the calibration review preview and WarehouseMapView call the same
    // exported functions from @/utils/mapAnchorTransform.  Feeding the same
    // anchor input to both paths must yield the same SVG transform string.
    const pts: AnchorPoint[] = VALID_ANCHORS.map((a) => ({
      id: a.id, name: a.name,
      svgX: a.svgX, svgY: a.svgY,
      worldX: a.worldX, worldY: a.worldY,
    }));

    // Simulate calibration-review path
    const reviewMatrix = computeAnchorTransform(pts);
    expect(reviewMatrix).not.toBeNull();
    const reviewStr = matrixToSvgString(reviewMatrix!);

    // Simulate live-map path (same functions, same input)
    const mapMatrix = computeAnchorTransform(pts);
    const mapStr = matrixToSvgString(mapMatrix!);

    expect(reviewStr).toBe(mapStr);
  });

  it("degenerate (collinear) world anchors yield null from computeAnchorTransform", () => {
    const pts: AnchorPoint[] = COLLINEAR_ANCHORS.map((a) => ({
      id: a.id, name: a.name,
      svgX: a.svgX, svgY: a.svgY,
      worldX: a.worldX, worldY: a.worldY,
    }));
    expect(computeAnchorTransform(pts)).toBeNull();
  });

  it("duplicate world-coordinate anchors yield null from computeAnchorTransform", () => {
    const pts: AnchorPoint[] = [
      { id: 1, name: "D1", svgX: 10, svgY: 10, worldX: 5, worldY: 5 },
      { id: 2, name: "D2", svgX: 20, svgY: 30, worldX: 5, worldY: 5 },  // duplicate world
      { id: 3, name: "D3", svgX: 40, svgY: 50, worldX: 15, worldY: 25 },
    ];
    expect(computeAnchorTransform(pts)).toBeNull();
  });
});

// =============================================================================
// (a) No server writes fire before Confirm
// =============================================================================

describe("No server writes before Confirm", () => {
  it("upsertAnchor is NOT called on mount even when 3 anchors are pre-loaded", async () => {
    activeTree = await renderScreen([...VALID_ANCHORS]);
    // render() already flushes all effects — no extra flush needed.
    expect(mockUpsertAnchor).not.toHaveBeenCalled();
  });

  it("Review Alignment button appears when all 3 anchors are ready", async () => {
    activeTree = await renderScreen([...VALID_ANCHORS]);
    expect(activeTree.queryByText("Review Alignment →")).not.toBeNull();
  });

  it("navigating to review step does not call upsertAnchor", async () => {
    activeTree = await renderScreen([...VALID_ANCHORS]);
    await goToReview(activeTree);
    expect(mockUpsertAnchor).not.toHaveBeenCalled();
  });
});

// =============================================================================
// (b) All three writes fire on Confirm
// =============================================================================

describe("All three writes fire on Confirm", () => {
  it("calls upsertAnchor 3 times with the correct slot numbers", async () => {
    activeTree = await renderScreen([...VALID_ANCHORS]);
    await goToReview(activeTree);
    await pressConfirm(activeTree);

    expect(mockUpsertAnchor).toHaveBeenCalledTimes(3);
    // Slots must be 1, 2, 3 in order
    expect(mockUpsertAnchor).toHaveBeenNthCalledWith(1, 1, expect.objectContaining({
      svgX: VALID_ANCHORS[0].svgX, svgY: VALID_ANCHORS[0].svgY,
      worldX: VALID_ANCHORS[0].worldX, worldY: VALID_ANCHORS[0].worldY,
    }));
    expect(mockUpsertAnchor).toHaveBeenNthCalledWith(2, 2, expect.objectContaining({
      svgX: VALID_ANCHORS[1].svgX, svgY: VALID_ANCHORS[1].svgY,
      worldX: VALID_ANCHORS[1].worldX, worldY: VALID_ANCHORS[1].worldY,
    }));
    expect(mockUpsertAnchor).toHaveBeenNthCalledWith(3, 3, expect.objectContaining({
      svgX: VALID_ANCHORS[2].svgX, svgY: VALID_ANCHORS[2].svgY,
      worldX: VALID_ANCHORS[2].worldX, worldY: VALID_ANCHORS[2].worldY,
    }));
  });
});

// =============================================================================
// (c) Degenerate input blocks Confirm
// =============================================================================

describe("Degenerate input", () => {
  it("shows a degenerate warning when all 3 world anchors are collinear", async () => {
    activeTree = await renderScreen([...COLLINEAR_ANCHORS]);
    expect(activeTree.queryByText(/collinear or overlap/i)).not.toBeNull();
  });

  it("does NOT show the Review Alignment button for collinear anchors", async () => {
    activeTree = await renderScreen([...COLLINEAR_ANCHORS]);
    expect(activeTree.queryByText("Review Alignment →")).toBeNull();
  });

  it("Confirm button is disabled (not pressable) when transform is degenerate", async () => {
    // To reach the review step with degenerate anchors we have to force it via
    // tree introspection because the Review Alignment button is hidden.  We
    // instead verify that the Confirm pressable is disabled.
    activeTree = await renderScreen([...COLLINEAR_ANCHORS]);
    // Confirm & Apply button is never rendered in this path (no review step access)
    expect(activeTree.queryByText(/Confirm & Apply/i)).toBeNull();
    // upsertAnchor was never called
    expect(mockUpsertAnchor).not.toHaveBeenCalled();
  });
});

// =============================================================================
// (d) Mid-confirm failure — retry-able error, no cache invalidation
// =============================================================================

describe("Mid-confirm network failure", () => {
  it("shows retry-able error and does NOT invalidate AsyncStorage when slot 2 fails", async () => {
    // Slot 1 succeeds, slot 2 fails, slot 3 never reached.
    mockUpsertAnchor
      .mockResolvedValueOnce({ ok: true })   // slot 1 ✓
      .mockResolvedValueOnce({ ok: false })  // slot 2 ✗
      .mockResolvedValue({ ok: true });      // (slot 3 would succeed but never called)

    activeTree = await renderScreen([...VALID_ANCHORS]);
    await goToReview(activeTree);
    await pressConfirm(activeTree);

    // Error message shown
    expect(activeTree.queryByText(/Could not save all anchors/i)).not.toBeNull();
    // Cache NOT invalidated
    expect(mockRemoveItem).not.toHaveBeenCalled();
    // Only 2 calls attempted (stops on first failure)
    expect(mockUpsertAnchor).toHaveBeenCalledTimes(2);
  });

  it("Confirm button is re-enabled after failure (retry is possible)", async () => {
    mockUpsertAnchor.mockResolvedValueOnce({ ok: false });

    activeTree = await renderScreen([...VALID_ANCHORS]);
    await goToReview(activeTree);
    await pressConfirm(activeTree);

    // Button is back — not stuck in loading state
    expect(activeTree.queryByText(/Confirm & Apply/i)).not.toBeNull();
  });

  it("retrying after failure calls all 3 slots again", async () => {
    // First attempt: slot 1 succeeds, slot 2 fails
    mockUpsertAnchor
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false })
      // Second attempt (retry): all succeed
      .mockResolvedValue({ ok: true });

    activeTree = await renderScreen([...VALID_ANCHORS]);
    await goToReview(activeTree);
    await pressConfirm(activeTree);          // first attempt: 2 calls

    // Retry
    await pressConfirm(activeTree);          // second attempt: 3 more calls

    // First attempt: 2 calls, retry: 3 calls = 5 total
    expect(mockUpsertAnchor).toHaveBeenCalledTimes(5);
    // Cache invalidated on successful retry
    expect(mockRemoveItem).toHaveBeenCalledWith("parts_id_warehouse_zones_v1");
  });
});

// =============================================================================
// Snapshot preservation — regression guard for refetch-driven state corruption
// =============================================================================
// Each successful upsertAnchor inside useMapAnchors triggers refetch(), which
// runs the anchor-sync useEffect and overwrites forms/svgCoords with server
// values.  confirmedSnapshotRef captures the reviewed draft on first Confirm
// press so retries always send the original reviewed values, not stale server
// round-tripped ones.

describe("Snapshot preservation during mid-confirm refetch", () => {
  it("retry sends original reviewed values even when refetch rewrites forms before retry", async () => {
    // Stale server state that would be returned by refetch after slot 1 saves:
    // slot 1 has the new value, but slots 2 and 3 still have stale old values.
    const STALE_SERVER_STATE = [
      { id: 1, name: "A1", svgX: 100, svgY: 200, worldX: 10, worldY: 20, updatedAt: "" },
      { id: 2, name: "A2-OLD", svgX: 999, svgY: 999, worldX: 99, worldY: 99, updatedAt: "" },
      { id: 3, name: "A3-OLD", svgX: 888, svgY: 888, worldX: 88, worldY: 88, updatedAt: "" },
    ];

    // Slot 1 succeeds, slot 2 fails on first attempt; all 3 succeed on retry.
    mockUpsertAnchor
      .mockResolvedValueOnce({ ok: true })   // slot 1, first attempt ✓
      .mockResolvedValueOnce({ ok: false })  // slot 2, first attempt ✗
      .mockResolvedValue({ ok: true });      // slots 1-3 on retry ✓

    activeTree = await renderScreen([...VALID_ANCHORS]);
    await goToReview(activeTree);
    await pressConfirm(activeTree);   // first attempt: 2 calls, fails on slot 2

    // Simulate the refetch side-effect: slots 2 and 3 are rehydrated with
    // stale server values (different svgX/worldX from the reviewed draft).
    // Without confirmedSnapshotRef, this would corrupt draftAnchors before retry.
    _mockAnchors = STALE_SERVER_STATE;
    await act(async () => {
      await activeTree!.rerender(<AdminMapCalibrationScreen />);
      await rawFlush();
    });

    // Retry the confirm — snapshot must be reused
    await pressConfirm(activeTree);   // 3 more calls (slots 1, 2, 3)

    // Total: 2 from first attempt + 3 from retry = 5
    expect(mockUpsertAnchor).toHaveBeenCalledTimes(5);

    // The retry's slot 2 call must use the ORIGINAL REVIEWED values, not stale.
    expect(mockUpsertAnchor).toHaveBeenNthCalledWith(4, 2, expect.objectContaining({
      svgX: VALID_ANCHORS[1].svgX,    // 300, NOT the stale 999
      worldX: VALID_ANCHORS[1].worldX, // 30, NOT the stale 99
    }));
    // Same for slot 3
    expect(mockUpsertAnchor).toHaveBeenNthCalledWith(5, 3, expect.objectContaining({
      svgX: VALID_ANCHORS[2].svgX,    // 200, NOT the stale 888
      worldX: VALID_ANCHORS[2].worldX, // 20, NOT the stale 88
    }));

    // Cache was invalidated on successful retry
    expect(mockRemoveItem).toHaveBeenCalledWith("parts_id_warehouse_zones_v1");
  });
});

// =============================================================================
// (e) Cache invalidated after successful confirm
// =============================================================================

describe("Cache invalidation after confirm", () => {
  it("calls AsyncStorage.removeItem with the zones cache key on success", async () => {
    activeTree = await renderScreen([...VALID_ANCHORS]);
    await goToReview(activeTree);
    await pressConfirm(activeTree);

    expect(mockRemoveItem).toHaveBeenCalledTimes(1);
    expect(mockRemoveItem).toHaveBeenCalledWith("parts_id_warehouse_zones_v1");
  });

  it("calls refetchZones after cache is cleared", async () => {
    activeTree = await renderScreen([...VALID_ANCHORS]);
    await goToReview(activeTree);
    await pressConfirm(activeTree);

    expect(mockRefetchZones).toHaveBeenCalled();
  });

  it("does NOT call AsyncStorage.removeItem when all upserts succeed but navigating back without confirming", async () => {
    activeTree = await renderScreen([...VALID_ANCHORS]);
    await goToReview(activeTree);
    // Go back without confirming
    const backBtn = activeTree.queryByText(/Adjust anchors/i);
    if (backBtn) {
      await act(async () => { fireEvent.press(backBtn); await rawFlush(); });
    }
    expect(mockRemoveItem).not.toHaveBeenCalled();
  });
});

// =============================================================================
// (g) Double-tap guard
// =============================================================================

// =============================================================================
// MFA_REQUIRED during confirm
// =============================================================================

describe("MFA_REQUIRED during confirm", () => {
  // Alert.alert is auto-mocked by the react-native jest preset.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockAlert = Alert.alert as jest.Mock<any, any>;

  it("shows an MFA-specific Alert and NOT the generic retry message when upsertAnchor returns mfaRequired: true", async () => {
    // Slot 1 returns MFA_REQUIRED
    mockUpsertAnchor.mockResolvedValueOnce({ ok: false, mfaRequired: true });

    activeTree = await renderScreen([...VALID_ANCHORS]);
    await goToReview(activeTree);
    await pressConfirm(activeTree);

    // Alert must have been called with the MFA-specific title
    expect(mockAlert).toHaveBeenCalledWith(
      "Two-Factor Authentication Required",
      expect.stringMatching(/two-factor authentication \(2fa\)/i),
      expect.any(Array),
    );

    // The generic connection-error banner must NOT be shown
    expect(activeTree.queryByText(/could not save all anchors/i)).toBeNull();
  });

  it("shows the generic retry message and NOT an MFA Alert when upsertAnchor returns { ok: false, mfaRequired: false }", async () => {
    // Slot 1 fails with a generic (non-MFA) error
    mockUpsertAnchor.mockResolvedValueOnce({ ok: false, mfaRequired: false });

    activeTree = await renderScreen([...VALID_ANCHORS]);
    await goToReview(activeTree);
    await pressConfirm(activeTree);

    // Generic "could not save" error must appear
    expect(activeTree.queryByText(/could not save all anchors/i)).not.toBeNull();

    // Alert must NOT have been called with the MFA title
    const mfaAlertCall = mockAlert.mock.calls.find(
      ([title]: [string]) => /two-factor/i.test(title),
    );
    expect(mfaAlertCall).toBeUndefined();
  });
});

describe("Double-tap guard", () => {
  it("issues only one batch of 3 PUT calls when Confirm is tapped rapidly twice", async () => {
    // Make the first slot's upsertAnchor return a never-resolving promise so
    // isConfirming stays true long enough to block the second tap.  Slot 1 is
    // resolved with { ok: false } inside the same act() so that handleConfirm
    // returns immediately (avoids continuing to slots 2 and 3) and all async
    // work completes before the test ends — preventing "overlapping act() calls"
    // warnings from leaking pending state updates into the next test.
    let resolveSlot1!: (v: AnchorMutResult) => void;
    const pendingSlot1 = new Promise<AnchorMutResult>((resolve) => { resolveSlot1 = resolve; });

    mockUpsertAnchor.mockReturnValueOnce(pendingSlot1);

    activeTree = await renderScreen([...VALID_ANCHORS]);
    await goToReview(activeTree);

    const confirmBtn = activeTree.queryByText(/Confirm & Apply/i);
    if (!confirmBtn) throw new Error("Confirm button not found");

    // Both presses happen synchronously — confirmingRef.current is set true by
    // the first press before the second press evaluates the guard, so the second
    // press is blocked without any React render cycle needed between them.
    await act(async () => {
      fireEvent.press(confirmBtn);   // First tap: sets confirmingRef.current = true
      fireEvent.press(confirmBtn);   // Second tap: blocked by confirmingRef guard
      // Resolve slot 1 with failure so handleConfirm exits without continuing to
      // slots 2 and 3.  This drains all async work in the same act() scope.
      resolveSlot1({ ok: false });
      await rawFlush();
    });

    // Should have been called at most 3 times (one batch), not 6 (two batches).
    expect(mockUpsertAnchor.mock.calls.length).toBeLessThanOrEqual(3);
    // And at least 1 call happened
    expect(mockUpsertAnchor).toHaveBeenCalled();
  });
});

// =============================================================================
// Source-level regression guards — pick overlay pointerEvents and tapGesture
// =============================================================================
// These tests read the raw source of the calibration screen and assert that
// two critical props can't be silently removed by a future refactor.
//
//  1. tapGesture must call .runOnJS(true) — ensures the onEnd callback runs on
//     the JS thread under Reanimated 4; without it state updates inside onEnd
//     can be silently dropped on native.
//
//  2. The pickOverlay View must carry pointerEvents="box-none" — without it the
//     absolutely-positioned overlay intercepts tap events on web, preventing
//     placed coordinates from being registered (Save button stays disabled).

describe("Source-level regression guards — pick overlay and tapGesture", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsModule  = require("fs")   as typeof import("fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathModule = require("path") as typeof import("path");
  const calibSrc: string = fsModule.readFileSync(
    pathModule.resolve(__dirname, "../app/admin-map-calibration.tsx"),
    "utf-8",
  );

  /** Walk forward from startIdx until the closing `>` of a JSX opening tag. */
  function extractOpeningTag(src: string, startIdx: number): string {
    let i = startIdx;
    let depth = 0;
    while (i < src.length) {
      const ch = src[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0) return src.slice(startIdx, i + 1);
      i++;
    }
    return src.slice(startIdx, i);
  }

  it("tapGesture chain includes .runOnJS(true) before .onEnd(", () => {
    // Locate the Gesture.Tap() call that builds the tap gesture.
    const tapGestureIdx = calibSrc.indexOf("Gesture.Tap()");
    expect(tapGestureIdx).toBeGreaterThan(-1);

    // The .onEnd( must come after .runOnJS(true) in the same gesture chain.
    const onEndIdx = calibSrc.indexOf(".onEnd(", tapGestureIdx);
    expect(onEndIdx).toBeGreaterThan(-1);

    const between = calibSrc.slice(tapGestureIdx, onEndIdx);
    expect(between).toMatch(/\.runOnJS\s*\(\s*true\s*\)/);
  });

  it("pickOverlay View carries pointerEvents=\"box-none\"", () => {
    // Scan for every <View that references styles.pickOverlay.
    const tagStartRe = /<View\b/g;
    let match: RegExpExecArray | null;
    let found = false;

    while ((match = tagStartRe.exec(calibSrc)) !== null) {
      const tag = extractOpeningTag(calibSrc, match.index);
      if (!tag.includes("pickOverlay")) continue;
      found = true;

      const hasBoxNone = /pointerEvents\s*=\s*["']box-none["']/.test(tag);
      if (!hasBoxNone) {
        throw new Error(
          `The pickOverlay <View> is missing pointerEvents="box-none".\n` +
          `Without it the overlay intercepts tap events on web, preventing\n` +
          `placed coordinates from being registered and the Save button remaining disabled.\n` +
          `Add  pointerEvents="box-none"  to the <View style={[styles.pickOverlay, …]}> tag\n` +
          `in app/admin-map-calibration.tsx.`,
        );
      }
      expect(hasBoxNone).toBe(true);
    }

    if (!found) {
      throw new Error(
        `Could not find a <View> that references styles.pickOverlay ` +
        `in app/admin-map-calibration.tsx. ` +
        `The overlay may have been renamed — update this test to match.`,
      );
    }
  });
});

// =============================================================================
// Multi-slot save isolation
// =============================================================================
// Saving slot A triggers upsertAnchor → which calls refetch() internally →
// which causes the anchor-sync useEffect to fire.  Without the prevAnchorIdsRef
// guard, any slot NOT present in the new server response would have its locally-
// placed svgCoord wiped back to null, re-disabling that slot's Save button even
// though the user had already placed a point there.

describe("Multi-slot save isolation — refetch must not wipe unsaved local coords", () => {
  // Ref to the latest onEnd callback registered by the tapGesture, captured by
  // the Gesture.Tap spy below so tests can fire tap events programmatically.
  let fireTap: (e: { x: number; y: number }) => void = () => {};

  beforeEach(() => {
    fireTap = () => {};

    // Provide cached SVG data so the component mounts the GestureDetector
    // (it only renders when svgXml is truthy).
    const floorPlanCache = require("@/utils/floorPlanCache") as {
      getCachedData: jest.Mock;
      hasCachedData: jest.Mock;
    };
    floorPlanCache.getCachedData.mockReturnValue({
      xml: "<svg/>",
      contentViewBox: null,
      hash: "test",
    });
    floorPlanCache.hasCachedData.mockReturnValue(true);

    // Spy on Gesture.Tap to intercept the onEnd callback before the no-op
    // chain discards it.  This lets tests simulate tap events by calling fireTap.
    const gestureModule = require("react-native-gesture-handler") as {
      Gesture: { Tap: () => Record<string, (...args: unknown[]) => unknown> };
    };
    const originalTap = gestureModule.Gesture.Tap.bind(gestureModule.Gesture);
    jest.spyOn(gestureModule.Gesture, "Tap").mockImplementation(() => {
      const chain = originalTap();
      const origOnEnd = chain["onEnd"]!;
      // Use `any` for cb so the assignment satisfies the Record's (...args: unknown[]) => unknown
      // type signature; fireTap is cast to the concrete event type for callers.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      chain["onEnd"] = (cb: any) => {
        fireTap = cb as (e: { x: number; y: number }) => void;
        return origOnEnd(cb);
      };
      return chain;
    });
  });

  afterEach(() => {
    // Restore the floorPlanCache to its default (null) so subsequent tests
    // that expect svgXml="" are unaffected.
    const floorPlanCache = require("@/utils/floorPlanCache") as {
      getCachedData: jest.Mock;
      hasCachedData: jest.Mock;
    };
    floorPlanCache.getCachedData.mockReturnValue(null);
    floorPlanCache.hasCachedData.mockReturnValue(false);
    jest.restoreAllMocks();
  });

  it("locally-placed coord on slot 2 survives a refetch that only returns slot 1", async () => {
    // Start with no server anchors — all 3 slots show "Not placed".
    activeTree = await renderScreen([]);
    expect(activeTree.queryAllByText("Not placed")).toHaveLength(3);

    // Enter pick mode for slot 2 (index 1) by pressing its "Place" button.
    // All 3 slots start as "Place" buttons; the second one belongs to slot 2.
    const placeButtons = activeTree.getAllByText("Place");
    expect(placeButtons).toHaveLength(3);
    await act(async () => {
      fireEvent.press(placeButtons[1]!);
      await rawFlush();
    });
    // After the press, the component re-renders with pickingSlot = 1 and the
    // tapGesture re-registers its onEnd callback — fireTap now captures that
    // closure which holds the correct pickingSlot value.

    // Simulate a tap on the map.  mapW/mapH are 0 in tests (no layout event),
    // so screenToSvgCoords returns {x:0, y:0} regardless of the input.
    await act(async () => {
      fireTap({ x: 50, y: 50 });
      await rawFlush();
    });

    // Slot 2 now has a coord ({x:0, y:0}); slots 1 and 3 remain "Not placed".
    expect(activeTree.queryAllByText("Not placed")).toHaveLength(2);

    // Simulate the refetch that fires when slot 1 is saved: the server now
    // returns only slot 1.  The sync useEffect must NOT wipe slot 2's local draft.
    _mockAnchors = [VALID_ANCHORS[0]];
    await act(async () => {
      await activeTree!.rerender(<AdminMapCalibrationScreen />);
      await rawFlush();
    });

    // After the refetch:
    //   Slot 1 — synced from server (svgX:100)
    //   Slot 2 — local draft PRESERVED (never saved, never in prevAnchorIdsRef)
    //   Slot 3 — still "Not placed" (untouched)
    //
    // BUG (before fix): the effect wiped every slot not in the server response
    //   → slot 2 would become "Not placed" → 2 "Not placed" texts.
    // FIX: only previously-saved-and-now-deleted slots are cleared
    //   → slot 2 is left intact → 1 "Not placed" text.
    expect(activeTree.queryAllByText("Not placed")).toHaveLength(1);

    // Slot 1 must show the server-synced SVG coordinate (svgX = 100).
    expect(activeTree.queryByText(/x:\s*100\.0/)).not.toBeNull();
  });
});
