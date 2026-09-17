import * as SecureStore from "expo-secure-store";

import {
  clearImportDraft,
  loadImportDraft,
  saveImportDraft,
} from "@/utils/importDraftStorage";

const secureValues = new Map<string, string>();
const mockSecureGet = SecureStore.getItemAsync as jest.Mock;
const mockSecureSet = SecureStore.setItemAsync as jest.Mock;
const mockSecureDelete = SecureStore.deleteItemAsync as jest.Mock;

const draft = {
  parsedRows: [{
    vendor: "ACME",
    catalog: "XLSX-001",
    description: "20A breaker",
    binLocations: ["NEW-B2"],
    barcodes: [],
  }],
  rawCsv: "Vendor,Catalog,Description,BinLocation\nACME,XLSX-001,20A breaker,NEW-B2",
  fileName: "inventory.xlsx",
  fileType: "xlsx" as const,
  importMode: "full" as const,
  skipBinRows: [0],
  selectedUnknownRows: [],
};

beforeEach(() => {
  secureValues.clear();
  mockSecureGet.mockImplementation(async (key: string) => secureValues.get(key) ?? null);
  mockSecureSet.mockImplementation(async (key: string, value: string) => {
    secureValues.set(key, value);
  });
  mockSecureDelete.mockImplementation(async (key: string) => {
    secureValues.delete(key);
  });
  jest.spyOn(Date, "now").mockReturnValue(1_000);
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

describe("import draft storage", () => {
  it("restores only for the owning user and clears every encrypted chunk", async () => {
    await saveImportDraft("admin-user", draft);

    await expect(loadImportDraft("other-user")).resolves.toBeNull();
    await expect(loadImportDraft("admin-user")).resolves.toEqual(draft);

    await clearImportDraft("admin-user");
    await expect(loadImportDraft("admin-user")).resolves.toBeNull();
    expect([...secureValues.keys()].filter(key => key.includes("admin-user"))).toHaveLength(0);
  });

  it("expires and deletes a stale draft", async () => {
    await saveImportDraft("admin-user", draft);
    (Date.now as jest.Mock).mockReturnValue(24 * 60 * 60 * 1000 + 1_001);

    await expect(loadImportDraft("admin-user")).resolves.toBeNull();
    expect([...secureValues.keys()].filter(key => key.includes("admin-user"))).toHaveLength(0);
  });

  it("orders logout deletion after a pending save", async () => {
    let releaseFirstChunk!: () => void;
    const firstChunkBlocked = new Promise<void>(resolve => { releaseFirstChunk = resolve; });
    let blocked = false;
    mockSecureSet.mockImplementation(async (key: string, value: string) => {
      if (!blocked && key.endsWith(":0")) {
        blocked = true;
        await firstChunkBlocked;
      }
      secureValues.set(key, value);
    });

    const pendingSave = saveImportDraft("admin-user", draft);
    const pendingClear = clearImportDraft("admin-user");
    await Promise.resolve();
    releaseFirstChunk();
    await Promise.all([pendingSave, pendingClear]);

    await expect(loadImportDraft("admin-user")).resolves.toBeNull();
    expect([...secureValues.keys()].filter(key => key.includes("admin-user"))).toHaveLength(0);
  });
});