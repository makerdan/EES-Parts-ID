jest.mock("@react-native-async-storage/async-storage", () => {
  const store: Record<string, string> = {};
  return {
    __esModule: true,
    default: {
      getItem: jest.fn(async (key: string) => store[key] ?? null),
      setItem: jest.fn(async (key: string, value: string) => { store[key] = value; }),
      removeItem: jest.fn(async (key: string) => { delete store[key]; }),
    },
  };
});

import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  HELP_GENERAL_CACHE_KEY,
  HELP_ORIENTATION_KEY,
  readCachedGeneralHelp,
  readHelpOrientationDismissed,
  saveHelpOrientationDismissed,
  writeCachedGeneralHelp,
  type HelpResponse,
} from "@/utils/helpStorage";

const USER_ID = "worker-1";

const GENERAL: HelpResponse = {
  schemaVersion: "1.0",
  contentVersion: "1.0.0",
  audience: "general",
  records: [{
    id: "help.search",
    audience: "general",
    workflow: "search",
    title: "Search",
    summary: "Find a part.",
    body: "Search the inventory.",
    prerequisites: ["An approved account"],
    steps: ["Open Search"],
    outcomes: ["Results appear"],
    recovery: ["Try again"],
    limitations: ["Offline data may be old"],
    revision: { contentVersion: "1.0.0", revisedAt: "2026-09-01", source: "verified-product-workflow" },
  }],
};

afterEach(async () => {
  await AsyncStorage.removeItem(HELP_GENERAL_CACHE_KEY);
  await AsyncStorage.removeItem(HELP_ORIENTATION_KEY);
  await AsyncStorage.removeItem(`${HELP_ORIENTATION_KEY}:${USER_ID}`);
  await AsyncStorage.removeItem(`${HELP_ORIENTATION_KEY}:worker-2`);
  jest.clearAllMocks();
});

describe("Help local storage contract", () => {
  it("round-trips bounded general content", async () => {
    await writeCachedGeneralHelp(GENERAL);
    await expect(readCachedGeneralHelp()).resolves.toEqual(GENERAL);
  });

  it("rejects privileged records instead of treating them as offline general Help", async () => {
    await AsyncStorage.setItem(
      HELP_GENERAL_CACHE_KEY,
      JSON.stringify({ ...GENERAL, audience: "admin", records: GENERAL.records.map((record) => ({ ...record, audience: "admin" })) }),
    );
    await expect(readCachedGeneralHelp()).resolves.toBeNull();
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith(HELP_GENERAL_CACHE_KEY);
  });

  it("persists dismissal while a storage failure remains non-blocking", async () => {
    await expect(readHelpOrientationDismissed(USER_ID)).resolves.toBe(false);
    await expect(saveHelpOrientationDismissed(USER_ID)).resolves.toBe(true);
    await expect(readHelpOrientationDismissed(USER_ID)).resolves.toBe(true);
  });

  it("keeps orientation preferences isolated between users", async () => {
    await saveHelpOrientationDismissed(USER_ID);

    await expect(readHelpOrientationDismissed(USER_ID)).resolves.toBe(true);
    await expect(readHelpOrientationDismissed("worker-2")).resolves.toBe(false);
  });

  it("reports when dismissal persistence fails", async () => {
    (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error("storage unavailable"));

    await expect(saveHelpOrientationDismissed(USER_ID)).resolves.toBe(false);
    await expect(readHelpOrientationDismissed(USER_ID)).resolves.toBe(false);
  });
});