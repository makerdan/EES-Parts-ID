/**
 * Regression tests for the Measure unit persistent setting.
 * Covers:
 *   - loadSettings: no stored key defaults to "mm" AND writes defaults immediately
 *   - updateSetting: AppContext provider path writes correct AsyncStorage key/value
 *   - loadSettings: reads back the persisted value after a write
 *   - fmtForUnit: correct display string for all three units
 *   - parseFieldToMm: correct mm value for all three units, round-trips cleanly
 */

// @ts-ignore — global augmentation for test environment only
global.IS_REACT_ACT_ENVIRONMENT = true;

// ── Transitive mocks for AppContext (expo-secure-store uses ESM) ──────────────

jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(() => Promise.resolve()),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
}));

jest.mock("@workspace/api-client-react", () => ({
  setAuthTokenGetter: jest.fn(),
}));

jest.mock("../utils/logoutRegistry", () => {
  const actual = jest.requireActual<typeof import("../utils/logoutRegistry")>("../utils/logoutRegistry");
  return {
    ...actual,
    LogoutRegistry: class {
      register() { return () => {}; }
      fire() {}
    },
  };
});

jest.mock("../utils/sessionStorage", () => ({
  SEARCH_CACHE_KEYS: [],
  SESSION_KEY: "parts_id_session",
  ADMIN_TOKEN_KEY: "parts_id_admin_token",
  clearSessionStorage: jest.fn(() => Promise.resolve()),
}));

jest.mock("@/constants/colors", () => ({
  __esModule: true,
  default: {
    light: { background: "#fff", foreground: "#000", card: "#fff", border: "#ccc", primary: "#3b82f6", primaryForeground: "#fff", muted: "#f1f5f9", mutedForeground: "#64748b", destructive: "#ef4444", success: "#22c55e", warning: "#f59e0b" },
    dark:  { background: "#000", foreground: "#fff", card: "#111", border: "#333", primary: "#3b82f6", primaryForeground: "#fff", muted: "#1e293b", mutedForeground: "#94a3b8", destructive: "#ef4444", success: "#22c55e", warning: "#f59e0b" },
    radius: 8,
  },
}));

// ── Transitive mocks for MeasurePartScreen ────────────────────────────────────

jest.mock("expo-camera", () => ({
  CameraView: function CameraView() { return null; },
  useCameraPermissions: jest.fn(() => [{ granted: true }, jest.fn()]),
}));

jest.mock("expo-device", () => ({ modelName: null }));

jest.mock("@expo/vector-icons", () => ({
  Feather: function Feather() { return null; },
}));

jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());

// lidar-measure is already mapped via jest.config.js moduleNameMapper → __mocks__/lidar-measure.js

// ── AsyncStorage mock ─────────────────────────────────────────────────────────

const mockGetItem = jest.fn<Promise<string | null>, [string]>();
const mockSetItem = jest.fn<Promise<void>, [string, string]>();

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: (...args: [string]) => mockGetItem(...args),
    setItem: (...args: [string, string]) => mockSetItem(...args),
    removeItem: jest.fn(() => Promise.resolve()),
    multiRemove: jest.fn(() => Promise.resolve()),
  },
}));

jest.mock("../utils/storageErrorReporter", () => ({
  reportStorageError: jest.fn(),
  setStorageErrorHandler: jest.fn(),
}));

jest.mock("react-native", () => ({
  Appearance: { setColorScheme: jest.fn() },
  Platform: { OS: "ios", select: (o: Record<string, unknown>) => o.ios ?? o.default },
  StyleSheet: {
    create: (s: unknown) => s,
    absoluteFill: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 },
  },
  Text: "Text",
  View: "View",
  useColorScheme: jest.fn(() => "light"),
  Modal: function Modal({ children, visible }: { children: unknown; visible: boolean }) {
    if (!visible) return null;
    const React = require("react");
    return React.createElement("rn-modal", {}, children);
  },
  Pressable: "Pressable",
  Alert: { alert: jest.fn() },
  AppState: { currentState: "active", addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
  Animated: {
    Value: class { constructor(_v: number) {} setValue() {} interpolate() { return this; } },
    View: "Animated.View",
    loop: () => ({ start: jest.fn(), stop: jest.fn() }),
    sequence: () => ({ start: jest.fn(), stop: jest.fn() }),
    timing: () => ({ start: jest.fn(), stop: jest.fn() }),
  },
  SafeAreaView: "SafeAreaView",
  TextInput: "TextInput",
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import React from "react";
import { render, act } from "@testing-library/react-native";

import {
  loadSettings,
  saveSettings,
  SETTINGS_KEY,
  DEFAULT_SETTINGS,
  AppProvider,
  useApp,
  type AppSettings,
  type DimensionUnit,
} from "../contexts/AppContext";
import { fmtForUnit, parseFieldToMm } from "../components/MeasurePartScreen";

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockSetItem.mockResolvedValue(undefined);
});

// ─── loadSettings: fresh install defaults ────────────────────────────────────

describe("loadSettings — no stored value", () => {
  beforeEach(() => {
    mockGetItem.mockResolvedValue(null);
  });

  it("returns mm as the default dimensionUnit when AsyncStorage is empty", async () => {
    const s = await loadSettings();
    expect(s.dimensionUnit).toBe("mm");
  });

  it("returns full DEFAULT_SETTINGS when AsyncStorage is empty", async () => {
    const s = await loadSettings();
    expect(s).toEqual(DEFAULT_SETTINGS);
  });

  it("writes DEFAULT_SETTINGS to AsyncStorage immediately on first launch", async () => {
    await loadSettings();
    expect(mockSetItem).toHaveBeenCalledTimes(1);
    const [key, value] = mockSetItem.mock.calls[0] as [string, string];
    expect(key).toBe(SETTINGS_KEY);
    expect((JSON.parse(value) as AppSettings).dimensionUnit).toBe("mm");
  });

  it("falls back to mm when stored dimensionUnit is invalid", async () => {
    mockGetItem.mockResolvedValue(JSON.stringify({ dimensionUnit: "ft" }));
    const s = await loadSettings();
    expect(s.dimensionUnit).toBe("mm");
  });
});

// ─── saveSettings writes correct AsyncStorage key/value ──────────────────────

describe("saveSettings writes the correct AsyncStorage key/value", () => {
  it("writes SETTINGS_KEY with JSON including the chosen unit (in)", async () => {
    const newSettings: AppSettings = { ...DEFAULT_SETTINGS, dimensionUnit: "in" };
    await saveSettings(newSettings);

    expect(mockSetItem).toHaveBeenCalledTimes(1);
    const [key, value] = mockSetItem.mock.calls[0] as [string, string];
    expect(key).toBe(SETTINGS_KEY);
    const parsed = JSON.parse(value) as AppSettings;
    expect(parsed.dimensionUnit).toBe("in");
  });

  it("writes SETTINGS_KEY with JSON including the chosen unit (cm)", async () => {
    const newSettings: AppSettings = { ...DEFAULT_SETTINGS, dimensionUnit: "cm" };
    await saveSettings(newSettings);
    const [key, value] = mockSetItem.mock.calls[0] as [string, string];
    expect(key).toBe(SETTINGS_KEY);
    expect((JSON.parse(value) as AppSettings).dimensionUnit).toBe("cm");
  });

  it("writes SETTINGS_KEY with JSON including the default unit (mm)", async () => {
    const newSettings: AppSettings = { ...DEFAULT_SETTINGS, dimensionUnit: "mm" };
    await saveSettings(newSettings);
    const [key, value] = mockSetItem.mock.calls[0] as [string, string];
    expect(key).toBe(SETTINGS_KEY);
    expect((JSON.parse(value) as AppSettings).dimensionUnit).toBe("mm");
  });
});

// ─── updateSetting via AppContext provider ────────────────────────────────────

describe("updateSetting via AppContext provider", () => {
  // Capture the updateSetting handle from inside the provider.
  // We render AppProvider with a consumer child, wait for the async
  // initialization to settle, then call updateSetting directly.
  async function renderAndGetUpdateSetting() {
    // Settings storage empty — provider will call loadSettings → mockGetItem(null)
    // → writes DEFAULT_SETTINGS → setItem called once during init.
    mockGetItem.mockResolvedValue(null);

    let capturedUpdateSetting: (<K extends keyof AppSettings>(k: K, v: AppSettings[K]) => void) | null = null;

    function Consumer() {
      const { updateSetting } = useApp();
      // Capture every render so the ref is always current
      capturedUpdateSetting = updateSetting;
      return null;
    }

    await act(async () => {
      render(
        <AppProvider>
          <Consumer />
        </AppProvider>,
      );
    });

    return capturedUpdateSetting!;
  }

  it("writes SETTINGS_KEY with dimensionUnit='in' when updateSetting is called", async () => {
    const updateSetting = await renderAndGetUpdateSetting();

    // Clear the setItem call made during initialization (first-launch default write)
    mockSetItem.mockClear();

    await act(async () => {
      updateSetting("dimensionUnit", "in");
    });

    expect(mockSetItem).toHaveBeenCalledTimes(1);
    const [key, value] = mockSetItem.mock.calls[0] as [string, string];
    expect(key).toBe(SETTINGS_KEY);
    const parsed = JSON.parse(value) as AppSettings;
    expect(parsed.dimensionUnit).toBe("in");
  });

  it("writes SETTINGS_KEY with dimensionUnit='cm' when updateSetting is called", async () => {
    const updateSetting = await renderAndGetUpdateSetting();
    mockSetItem.mockClear();

    await act(async () => {
      updateSetting("dimensionUnit", "cm");
    });

    expect(mockSetItem).toHaveBeenCalledTimes(1);
    const [, value] = mockSetItem.mock.calls[0] as [string, string];
    expect((JSON.parse(value) as AppSettings).dimensionUnit).toBe("cm");
  });
});

// ─── loadSettings reads back the persisted value ─────────────────────────────

describe("loadSettings reads back the persisted value", () => {
  it("returns 'in' after it was saved", async () => {
    const stored: Partial<AppSettings> = { dimensionUnit: "in" };
    mockGetItem.mockResolvedValue(JSON.stringify(stored));
    const s = await loadSettings();
    expect(s.dimensionUnit).toBe("in");
  });

  it("returns 'cm' after it was saved", async () => {
    const stored: Partial<AppSettings> = { dimensionUnit: "cm" };
    mockGetItem.mockResolvedValue(JSON.stringify(stored));
    const s = await loadSettings();
    expect(s.dimensionUnit).toBe("cm");
  });

  it("returns 'mm' after it was explicitly saved as mm", async () => {
    const stored: Partial<AppSettings> = { dimensionUnit: "mm" };
    mockGetItem.mockResolvedValue(JSON.stringify(stored));
    const s = await loadSettings();
    expect(s.dimensionUnit).toBe("mm");
  });

  it("preserves other settings fields alongside dimensionUnit", async () => {
    const stored: Partial<AppSettings> = { dimensionUnit: "in", textSize: "large" };
    mockGetItem.mockResolvedValue(JSON.stringify(stored));
    const s = await loadSettings();
    expect(s.dimensionUnit).toBe("in");
    expect(s.textSize).toBe("large");
  });
});

// ─── fmtForUnit parametrized tests ───────────────────────────────────────────

describe("fmtForUnit", () => {
  it.each<[number, DimensionUnit, string]>([
    // mm — displayed as whole-mm integer string
    [0,     "mm", "0"],
    [25.4,  "mm", "25"],
    [10,    "mm", "10"],
    [100,   "mm", "100"],
    // cm — one decimal place
    [10,    "cm", "1.0"],
    [25,    "cm", "2.5"],
    [100,   "cm", "10.0"],
    [1,     "cm", "0.1"],
    // in — two decimal places; 25.4 mm = 1.00 in
    [25.4,  "in", "1.00"],
    [50.8,  "in", "2.00"],
    [0,     "in", "0.00"],
  ])("fmtForUnit(%s mm, %s) === %s", (mm, unit, expected) => {
    expect(fmtForUnit(mm, unit)).toBe(expected);
  });

  it("returns empty string for null", () => {
    expect(fmtForUnit(null, "mm")).toBe("");
    expect(fmtForUnit(null, "cm")).toBe("");
    expect(fmtForUnit(null, "in")).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(fmtForUnit(undefined, "mm")).toBe("");
  });
});

// ─── parseFieldToMm parametrized tests ───────────────────────────────────────

describe("parseFieldToMm", () => {
  it.each<[string, DimensionUnit, number]>([
    // mm — stored as-is
    ["25",   "mm", 25],
    ["10",   "mm", 10],
    ["0",    "mm", 0],
    // cm — 1 cm = 10 mm
    ["1",    "cm", 10],
    ["2.5",  "cm", 25],
    ["10",   "cm", 100],
    // in — 1 in = 25.4 mm
    ["1",    "in", 25.4],
    ["2",    "in", 50.8],
    ["0.5",  "in", 12.7],
  ])("parseFieldToMm(%s, %s) ≈ %s mm", (input, unit, expectedMm) => {
    const result = parseFieldToMm(input, unit);
    expect(result).not.toBeNull();
    expect(result!).toBeCloseTo(expectedMm, 1);
  });

  it("returns null for empty string", () => {
    expect(parseFieldToMm("", "mm")).toBeNull();
    expect(parseFieldToMm("", "in")).toBeNull();
  });

  it("returns null for non-numeric input", () => {
    expect(parseFieldToMm("abc", "mm")).toBeNull();
  });

  it("returns null for negative values", () => {
    expect(parseFieldToMm("-1", "mm")).toBeNull();
    expect(parseFieldToMm("-5", "in")).toBeNull();
  });
});

// ─── Round-trip: fmtForUnit → parseFieldToMm → compare to original mm ────────

describe("unit round-trip (store mm, display, parse back to mm)", () => {
  const knownMmValues = [0, 1, 10, 25.4, 50.8, 100, 254];

  it.each(knownMmValues)("mm value %s survives mm round-trip", (mm) => {
    const displayed = fmtForUnit(mm, "mm");
    const back = parseFieldToMm(displayed, "mm");
    expect(back).toBeCloseTo(mm, 0);
  });

  it.each(knownMmValues)("mm value %s survives cm round-trip", (mm) => {
    const displayed = fmtForUnit(mm, "cm");
    const back = parseFieldToMm(displayed, "cm");
    expect(back).not.toBeNull();
    expect(back!).toBeCloseTo(mm, 0);
  });

  it.each(knownMmValues)("mm value %s survives in round-trip", (mm) => {
    // 2 decimal-place display means ±0.5 × 0.01 in ≈ ±0.127 mm of precision.
    // toBeCloseTo precision=0 checks within ±0.5 mm, which correctly covers that.
    const displayed = fmtForUnit(mm, "in");
    const back = parseFieldToMm(displayed, "in");
    expect(back).not.toBeNull();
    expect(back!).toBeCloseTo(mm, 0);
  });
});
