/**
 * @jest-environment jsdom
 *
 * Unit tests for the usePersistedCollapse hook.
 * Covers: default value, stored-value hydration ("1"/"0"), isLoaded
 * transitions, error-path fallback, setCollapsed persistence, and
 * toggleCollapsed flip-and-persist.
 */

import { renderHook, act } from "@testing-library/react";
import { usePersistedCollapse } from "../hooks/usePersistedCollapse";

// ---------------------------------------------------------------------------
// AsyncStorage mock
// ---------------------------------------------------------------------------
const mockGetItem = jest.fn<Promise<string | null>, [string]>();
const mockSetItem = jest.fn<Promise<void>, [string, string]>();

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: (...args: [string]) => mockGetItem(...args),
    setItem: (...args: [string, string]) => mockSetItem(...args),
    multiRemove: jest.fn(() => Promise.resolve()),
  },
}));

// Resolve all pending microtasks so that useEffect / setState chains settle.
const flushPromises = () => act(async () => {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
});

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
beforeEach(() => {
  mockGetItem.mockResolvedValue(null);  // default: key absent
  mockSetItem.mockResolvedValue(undefined);
});

afterEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers for destructuring the hook return tuple
// ---------------------------------------------------------------------------
function getState(result: { current: ReturnType<typeof usePersistedCollapse> }) {
  const [collapsed, toggleCollapsed, setCollapsed, isLoaded] = result.current;
  return { collapsed, toggleCollapsed, setCollapsed, isLoaded };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("usePersistedCollapse", () => {

  // ── Default value ──────────────────────────────────────────────────────────

  describe("default value before AsyncStorage responds", () => {
    it("returns the defaultValue (true) synchronously on first render", () => {
      // getItem never resolves during this test
      mockGetItem.mockReturnValue(new Promise(() => {}));

      const { result } = renderHook(() => usePersistedCollapse("@test/key"));

      expect(getState(result).collapsed).toBe(true);
      expect(getState(result).isLoaded).toBe(false);
    });

    it("uses a custom defaultValue (false) before AsyncStorage responds", () => {
      mockGetItem.mockReturnValue(new Promise(() => {}));

      const { result } = renderHook(() => usePersistedCollapse("@test/key2", false));

      expect(getState(result).collapsed).toBe(false);
      expect(getState(result).isLoaded).toBe(false);
    });
  });

  // ── isLoaded transitions ───────────────────────────────────────────────────

  describe("isLoaded transitions to true", () => {
    it("sets isLoaded to true when the key is found in storage", async () => {
      mockGetItem.mockResolvedValue("1");

      const { result } = renderHook(() => usePersistedCollapse("@test/found"));
      expect(getState(result).isLoaded).toBe(false);

      await flushPromises();

      expect(getState(result).isLoaded).toBe(true);
    });

    it("sets isLoaded to true when the key is absent from storage (null)", async () => {
      mockGetItem.mockResolvedValue(null);

      const { result } = renderHook(() => usePersistedCollapse("@test/absent"));
      expect(getState(result).isLoaded).toBe(false);

      await flushPromises();

      expect(getState(result).isLoaded).toBe(true);
    });

    it("sets isLoaded to true even when AsyncStorage.getItem rejects (error path)", async () => {
      mockGetItem.mockRejectedValue(new Error("Storage unavailable"));

      const { result } = renderHook(() => usePersistedCollapse("@test/error"));
      expect(getState(result).isLoaded).toBe(false);

      await flushPromises();

      expect(getState(result).isLoaded).toBe(true);
      // Collapsed should remain at its default (true) on error
      expect(getState(result).collapsed).toBe(true);
    });
  });

  // ── Stored value hydration ─────────────────────────────────────────────────

  describe("stored value hydration", () => {
    it('sets collapsed to true when stored value is "1"', async () => {
      mockGetItem.mockResolvedValue("1");

      const { result } = renderHook(() =>
        usePersistedCollapse("@test/stored-1", false), // start with false default
      );

      await flushPromises();

      expect(getState(result).collapsed).toBe(true);
      expect(getState(result).isLoaded).toBe(true);
    });

    it('sets collapsed to false when stored value is "0"', async () => {
      mockGetItem.mockResolvedValue("0");

      const { result } = renderHook(() =>
        usePersistedCollapse("@test/stored-0", true), // start with true default
      );

      await flushPromises();

      expect(getState(result).collapsed).toBe(false);
      expect(getState(result).isLoaded).toBe(true);
    });

    it("keeps the defaultValue when the key is absent (null stored value)", async () => {
      mockGetItem.mockResolvedValue(null);

      const { result } = renderHook(() =>
        usePersistedCollapse("@test/absent-keeps-default", false),
      );

      await flushPromises();

      expect(getState(result).collapsed).toBe(false); // default preserved
      expect(getState(result).isLoaded).toBe(true);
    });
  });

  // ── setCollapsed ───────────────────────────────────────────────────────────

  describe("setCollapsed", () => {
    it("updates the collapsed state immediately", async () => {
      const { result } = renderHook(() => usePersistedCollapse("@test/set"));

      await flushPromises(); // let hydration complete

      act(() => {
        getState(result).setCollapsed(false);
      });

      expect(getState(result).collapsed).toBe(false);
    });

    it('persists "1" to AsyncStorage when set to true', async () => {
      const { result } = renderHook(() =>
        usePersistedCollapse("@test/persist-true", false),
      );
      await flushPromises();

      act(() => {
        getState(result).setCollapsed(true);
      });

      expect(mockSetItem).toHaveBeenCalledWith("@test/persist-true", "1");
    });

    it('persists "0" to AsyncStorage when set to false', async () => {
      const { result } = renderHook(() =>
        usePersistedCollapse("@test/persist-false", true),
      );
      await flushPromises();

      act(() => {
        getState(result).setCollapsed(false);
      });

      expect(mockSetItem).toHaveBeenCalledWith("@test/persist-false", "0");
    });
  });

  // ── toggleCollapsed ────────────────────────────────────────────────────────

  describe("toggleCollapsed", () => {
    it("flips collapsed from true to false", async () => {
      mockGetItem.mockResolvedValue("1"); // start collapsed

      const { result } = renderHook(() => usePersistedCollapse("@test/toggle-on"));
      await flushPromises();

      expect(getState(result).collapsed).toBe(true);

      act(() => {
        getState(result).toggleCollapsed();
      });

      expect(getState(result).collapsed).toBe(false);
    });

    it("flips collapsed from false to true", async () => {
      mockGetItem.mockResolvedValue("0"); // start expanded

      const { result } = renderHook(() => usePersistedCollapse("@test/toggle-off"));
      await flushPromises();

      expect(getState(result).collapsed).toBe(false);

      act(() => {
        getState(result).toggleCollapsed();
      });

      expect(getState(result).collapsed).toBe(true);
    });

    it('persists "0" after toggling from collapsed (true → false)', async () => {
      mockGetItem.mockResolvedValue("1");

      const { result } = renderHook(() => usePersistedCollapse("@test/toggle-persist-0"));
      await flushPromises();

      act(() => {
        getState(result).toggleCollapsed();
      });

      expect(mockSetItem).toHaveBeenCalledWith("@test/toggle-persist-0", "0");
    });

    it('persists "1" after toggling from expanded (false → true)', async () => {
      mockGetItem.mockResolvedValue("0");

      const { result } = renderHook(() => usePersistedCollapse("@test/toggle-persist-1"));
      await flushPromises();

      act(() => {
        getState(result).toggleCollapsed();
      });

      expect(mockSetItem).toHaveBeenCalledWith("@test/toggle-persist-1", "1");
    });

    it("can toggle multiple times and persists each flip correctly", async () => {
      const { result } = renderHook(() => usePersistedCollapse("@test/multi-toggle"));
      await flushPromises();

      // Default is true (collapsed)
      act(() => { getState(result).toggleCollapsed(); }); // → false
      expect(getState(result).collapsed).toBe(false);
      expect(mockSetItem).toHaveBeenLastCalledWith("@test/multi-toggle", "0");

      act(() => { getState(result).toggleCollapsed(); }); // → true
      expect(getState(result).collapsed).toBe(true);
      expect(mockSetItem).toHaveBeenLastCalledWith("@test/multi-toggle", "1");

      act(() => { getState(result).toggleCollapsed(); }); // → false again
      expect(getState(result).collapsed).toBe(false);
      expect(mockSetItem).toHaveBeenLastCalledWith("@test/multi-toggle", "0");
    });
  });

  // ── Key changes ────────────────────────────────────────────────────────────

  describe("key change re-reads storage", () => {
    it("resets isLoaded to false and re-reads when the key prop changes", async () => {
      mockGetItem.mockResolvedValueOnce("1").mockResolvedValueOnce("0");

      const { result, rerender } = renderHook(
        ({ k }) => usePersistedCollapse(k),
        { initialProps: { k: "@test/key-a" } },
      );
      await flushPromises();

      expect(getState(result).collapsed).toBe(true); // from stored "1"
      expect(getState(result).isLoaded).toBe(true);

      // Change the key — isLoaded should drop to false while the new read is pending
      rerender({ k: "@test/key-b" });
      expect(getState(result).isLoaded).toBe(false);

      await flushPromises();

      expect(getState(result).collapsed).toBe(false); // from stored "0"
      expect(getState(result).isLoaded).toBe(true);
      expect(mockGetItem).toHaveBeenCalledTimes(2);
    });
  });
});
