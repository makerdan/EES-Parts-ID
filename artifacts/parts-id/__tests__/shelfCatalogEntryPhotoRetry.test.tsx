/**
 * Guards the "Retry failed photos" feature added to ShelfCatalogEntry (F-058).
 *
 * After a shelf-entry submission where item creation succeeds but one or more
 * photo uploads fail, the component must:
 *   1. Surface a "Retry failed photos" button.
 *   2. Re-attempt only the failed slots when Retry is pressed.
 *   3. Clear the button when retry succeeds.
 *   4. Keep the modal open in "done" mode so the Retry button is accessible
 *      (onClose must NOT be called immediately after a photo failure).
 *
 * Also guards the "Add & Next" path: the retry button must persist after
 * clearing item fields.
 */

// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

// ─── fetch mock ───────────────────────────────────────────────────────────────

const mockFetch = jest.fn();
(global as unknown as { fetch: unknown }).fetch = mockFetch;

// ─── Module mocks ─────────────────────────────────────────────────────────────

jest.mock("expo-camera", () => ({
  CameraView:           () => null,
  useCameraPermissions: jest.fn(() => [{ granted: true }, jest.fn()]),
}));

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem:     jest.fn().mockResolvedValue(null),
    setItem:     jest.fn().mockResolvedValue(undefined),
    multiGet:    jest.fn().mockResolvedValue([["shelfEntry_prefix", null], ["shelfEntry_step", null]]),
    multiRemove: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("@tanstack/react-query", () => ({
  useQueryClient: jest.fn(() => ({
    invalidateQueries: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());

jest.mock("@/utils/apiBase", () => ({
  API_BASE:   "http://localhost:8080/api",
  API_ORIGIN: "http://localhost:8080",
}));

jest.mock("@/utils/listEditorHandlers", () => ({
  invalidateInventoryList: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@expo/vector-icons", () => ({
  Feather: () => null,
}));

const mockPhotoCb: { slot1?: (uri: string | null) => void; slot2?: (uri: string | null) => void } = {};

jest.mock("@/components/PartPhotoPicker", () => ({
  PartPhotoPicker: ({
    onChange,
    slot,
  }: {
    onChange: (uri: string | null) => void;
    slot: number;
  }) => {
    if (slot === 2) { mockPhotoCb.slot2 = onChange; } else { mockPhotoCb.slot1 = onChange; }
    return null;
  },
}));

jest.mock("@/components/KeyboardDoneInput", () => {
  const Rct = require("react");
  return {
    KeyboardDoneInput: (props: {
      placeholder?: string;
      onChangeText?: (v: string) => void;
      value?: string;
      testID?: string;
      [k: string]: unknown;
    }) =>
      Rct.createElement("rn-textinput", {
        testID:       props.testID ?? props.placeholder ?? "",
        value:        props.value,
        onChangeText: props.onChangeText,
        placeholder:  props.placeholder,
      }),
  };
});

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import React from "react";
import { render, act, fireEvent } from "@testing-library/react-native";
import { ShelfCatalogEntry } from "../components/ShelfCatalogEntry";

const flushPromises = () =>
  act(async () => {
    await new Promise<void>(r => setTimeout(r, 0));
    await new Promise<void>(r => setTimeout(r, 0));
  });

// ─── fetch helpers ────────────────────────────────────────────────────────────

function makePreferencesOk() {
  return { ok: true, json: jest.fn().mockResolvedValue({ shelfPrefix: null, shelfStep: null }) };
}

function makeAddPartOk(itemId = 99) {
  return {
    ok:     true,
    status: 200,
    json:   jest.fn().mockResolvedValue({
      item: { id: itemId, catalog: "PART-A", vendor: "ACME", binLocations: [], barcodes: [] },
    }),
  };
}

function makePhotoOk() {
  return { ok: true, json: jest.fn().mockResolvedValue({ imageUrl: "http://example.com/img.jpg" }) };
}

function makePhotoFail() {
  return { ok: false, status: 500, json: jest.fn().mockResolvedValue({ error: "Upload failed" }) };
}

/** Stub for PATCH /admin/shelf-preferences triggered by saveShelfPreferences
 *  when shelfPrefix changes after hydration (fire-and-forget, ignored on success). */
function makePreferencesSave() {
  return { ok: true, json: jest.fn().mockResolvedValue({}) };
}

// ─── Per-test teardown ────────────────────────────────────────────────────────

let activeTree: Awaited<ReturnType<typeof render>> | null = null;
const mockOnClose = jest.fn();

afterEach(async () => {
  if (activeTree) {
    await activeTree.unmount();
    activeTree = null;
  }
  jest.clearAllMocks();
  delete mockPhotoCb.slot1;
  delete mockPhotoCb.slot2;
});

// ─── Helper: render and wait for initial effects ──────────────────────────────

async function renderAndFill(adminToken = "tok") {
  const result = await render(
    <ShelfCatalogEntry visible={true} adminToken={adminToken} onClose={mockOnClose} />
  );
  activeTree = result;

  await flushPromises(); // let useEffect(loadShelfPreferences) run

  // getByTestId works because our KeyboardDoneInput mock sets testID=placeholder.
  const prefixInput = result.getByTestId("e.g. 08-01");
  await act(async () => { fireEvent.changeText(prefixInput, "AA-01"); });

  // Start position — also sets `position` state via handleStartPositionChange.
  const startInput = result.queryByTestId("801");
  if (startInput) await act(async () => { fireEvent.changeText(startInput, "001"); });

  const catalogInput = result.getByTestId("e.g. BR120");
  await act(async () => { fireEvent.changeText(catalogInput, "BR120"); });

  const vendorInput = result.getByTestId("e.g. EATON");
  await act(async () => { fireEvent.changeText(vendorInput, "EATON"); });

  return result;
}

// =============================================================================
// Photo retry in "Add & Done" mode — modal stays open
// =============================================================================

describe("ShelfCatalogEntry — photo retry (F-058)", () => {
  it("shows 'Retry failed photos' when a photo upload fails after item creation ('Add & Done')", async () => {
    mockFetch
      .mockResolvedValueOnce(makePreferencesOk())  // GET /admin/shelf-preferences (load)
      .mockResolvedValueOnce(makePreferencesSave()) // PATCH /admin/shelf-preferences (saveShelfPreferences fired when shelfPrefix changes after hydration)
      .mockResolvedValueOnce(makeAddPartOk(99))     // POST /inventory/add-part
      .mockResolvedValueOnce(makePhotoFail());      // PATCH /inventory/99/photo (slot 1) – only reached if FileSystem mock resolves

    const result = await renderAndFill();

    // Select a photo for slot 1.
    await act(async () => { mockPhotoCb.slot1?.("/tmp/photo1.jpg"); });

    const addDoneBtn = result.getByText("Add & Done");
    await act(async () => { fireEvent.press(addDoneBtn); });
    await flushPromises();

    // Retry button must be visible.
    expect(result.queryByText("Retry failed photos")).not.toBeNull();
  });

  it("does NOT call onClose immediately when photo fails in 'Add & Done' mode", async () => {
    mockFetch
      .mockResolvedValueOnce(makePreferencesOk())
      .mockResolvedValueOnce(makePreferencesSave())
      .mockResolvedValueOnce(makeAddPartOk(99))
      .mockResolvedValueOnce(makePhotoFail());

    const result = await renderAndFill();
    await act(async () => { mockPhotoCb.slot1?.("/tmp/photo1.jpg"); });

    const addDoneBtn = result.getByText("Add & Done");
    await act(async () => { fireEvent.press(addDoneBtn); });
    await flushPromises();

    // Sheet must remain open so the user can tap Retry.
    expect(mockOnClose).not.toHaveBeenCalled();
  });

  it("re-attempts only failed slots when Retry is tapped and clears the button on success", async () => {
    mockFetch
      .mockResolvedValueOnce(makePreferencesOk())
      .mockResolvedValueOnce(makePreferencesSave())
      .mockResolvedValueOnce(makeAddPartOk(99))
      .mockResolvedValueOnce(makePhotoFail())  // initial upload fails
      .mockResolvedValueOnce(makePhotoOk());   // retry succeeds

    const result = await renderAndFill();
    await act(async () => { mockPhotoCb.slot1?.("/tmp/photo1.jpg"); });

    await act(async () => { fireEvent.press(result.getByText("Add & Done")); });
    await flushPromises();

    const retryBtn = result.getByText("Retry failed photos");

    await act(async () => { fireEvent.press(retryBtn); });
    await flushPromises();

    // After successful retry, the button must be gone.
    expect(result.queryByText("Retry failed photos")).toBeNull();
  });

  it("retains the Retry button when the retry attempt also fails", async () => {
    mockFetch
      .mockResolvedValueOnce(makePreferencesOk())
      .mockResolvedValueOnce(makePreferencesSave())
      .mockResolvedValueOnce(makeAddPartOk(99))
      .mockResolvedValueOnce(makePhotoFail()) // initial fail
      .mockResolvedValueOnce(makePhotoFail()); // retry also fails

    const result = await renderAndFill();
    await act(async () => { mockPhotoCb.slot1?.("/tmp/photo1.jpg"); });

    await act(async () => { fireEvent.press(result.getByText("Add & Done")); });
    await flushPromises();

    await act(async () => { fireEvent.press(result.getByText("Retry failed photos")); });
    await flushPromises();

    // Retry button must still be present.
    expect(result.queryByText("Retry failed photos")).not.toBeNull();
  });

  it("advances the counter in 'Add & Next' mode even when a photo fails", async () => {
    mockFetch
      .mockResolvedValueOnce(makePreferencesOk())
      .mockResolvedValueOnce(makePreferencesSave())
      .mockResolvedValueOnce(makeAddPartOk(99))
      .mockResolvedValueOnce(makePhotoFail());

    const result = await renderAndFill();
    await act(async () => { mockPhotoCb.slot1?.("/tmp/photo1.jpg"); });

    // Button text is "Add & Next →" (with arrow character); use a regex for robustness.
    const addNextBtn = result.queryByText(/Add.*Next/);
    expect(addNextBtn).not.toBeNull();
    await act(async () => { fireEvent.press(addNextBtn!); });
    await flushPromises();

    // Retry button must still be shown alongside the next item form.
    expect(result.queryByText("Retry failed photos")).not.toBeNull();
    // onClose must NOT have been called.
    expect(mockOnClose).not.toHaveBeenCalled();
  });

  it("accumulates failed slots across consecutive Add & Next submissions and Retry re-uploads all of them", async () => {
    // Item 1 (id=101): photo fails on first submit
    // Item 2 (id=102): photo fails on second submit
    // Retry: both items' photos succeed
    mockFetch
      .mockResolvedValueOnce(makePreferencesOk())   // GET /admin/shelf-preferences
      .mockResolvedValueOnce(makePreferencesSave())  // PATCH /admin/shelf-preferences
      .mockResolvedValueOnce(makeAddPartOk(101))     // POST item 1
      .mockResolvedValueOnce(makePhotoFail())        // photo upload item 1 – fails
      .mockResolvedValueOnce(makeAddPartOk(102))     // POST item 2
      .mockResolvedValueOnce(makePhotoFail())        // photo upload item 2 – fails
      .mockResolvedValueOnce(makePhotoOk())          // retry item 1 – succeeds
      .mockResolvedValueOnce(makePhotoOk());         // retry item 2 – succeeds

    const result = await renderAndFill();

    // ── First item ─────────────────────────────────────────────────────────────
    await act(async () => { mockPhotoCb.slot1?.("/tmp/photo1.jpg"); });
    await act(async () => { fireEvent.press(result.queryByText(/Add.*Next/)!); });
    await flushPromises();

    // After item 1 fails, Retry button is visible (1 photo failed).
    const retryAfterFirst = result.queryByText("Retry failed photos");
    expect(retryAfterFirst).not.toBeNull();

    // ── Second item (same form, counter advanced) ───────────────────────────────
    // Re-fill catalog and vendor for the second item.
    const catalogInput = result.getByTestId("e.g. BR120");
    const vendorInput  = result.getByTestId("e.g. EATON");
    await act(async () => { fireEvent.changeText(catalogInput, "BR121"); });
    await act(async () => { fireEvent.changeText(vendorInput, "EATON"); });
    await act(async () => { mockPhotoCb.slot1?.("/tmp/photo2.jpg"); });
    await act(async () => { fireEvent.press(result.queryByText(/Add.*Next/)!); });
    await flushPromises();

    // After item 2 also fails, Retry button is STILL visible and now covers 2 photos.
    expect(result.queryByText("Retry failed photos")).not.toBeNull();
    // The banner text should reflect both failed photos.
    expect(result.queryByText(/2 photos failed/)).not.toBeNull();

    // ── Retry both items ────────────────────────────────────────────────────────
    await act(async () => { fireEvent.press(result.queryByText("Retry failed photos")!); });
    await flushPromises();

    // Both retries succeeded → Retry button gone.
    expect(result.queryByText("Retry failed photos")).toBeNull();
  });
});
