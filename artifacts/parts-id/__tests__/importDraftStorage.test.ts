import { webcrypto } from "node:crypto";

const secureValues = new Map<string, string>();
const mockAsyncValues = new Map<string, string>();
const mockWebKeys = new Map<string, CryptoKey>();

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (key: string) =>
      (globalThis as typeof globalThis & { __importDraftAsyncValues: Map<string, string> })
        .__importDraftAsyncValues.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      (globalThis as typeof globalThis & { __importDraftAsyncValues: Map<string, string> })
        .__importDraftAsyncValues.set(key, value);
    }),
    removeItem: jest.fn(async (key: string) => {
      (globalThis as typeof globalThis & { __importDraftAsyncValues: Map<string, string> })
        .__importDraftAsyncValues.delete(key);
    }),
  },
}));

type StorageModule = typeof import("@/utils/importDraftStorage");

function installIndexedDb(): void {
  let opened = false;
  const db = {
    objectStoreNames: { contains: () => opened },
    createObjectStore: () => { opened = true; },
    close: jest.fn(),
    transaction: (_store: string, mode: string) => {
      const transaction: {
        error: null;
        oncomplete: null | (() => void);
        onerror: null | (() => void);
        objectStore: () => {
          get: (key: string) => {
            result: CryptoKey | undefined;
            error: null;
            onsuccess: null | (() => void);
            onerror: null | (() => void);
          };
          put: (value: CryptoKey, key: string) => void;
          delete: (key: string) => void;
        };
      } = {
        error: null,
        oncomplete: null,
        onerror: null,
        objectStore: () => ({
          get: (key: string) => {
            const request = {
              result: mockWebKeys.get(key),
              error: null,
              onsuccess: null as null | (() => void),
              onerror: null as null | (() => void),
            };
            queueMicrotask(() => request.onsuccess?.());
            return request;
          },
          put: (value: CryptoKey, key: string) => {
            mockWebKeys.set(key, value);
            queueMicrotask(() => transaction.oncomplete?.());
          },
          delete: (key: string) => {
            mockWebKeys.delete(key);
            queueMicrotask(() => transaction.oncomplete?.());
          },
        }),
      };
      expect(["readonly", "readwrite"]).toContain(mode);
      return transaction;
    },
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open: () => {
        const request = {
          result: db,
          error: null,
          onupgradeneeded: null as null | (() => void),
          onsuccess: null as null | (() => void),
          onerror: null as null | (() => void),
        };
        queueMicrotask(() => {
          if (!opened) request.onupgradeneeded?.();
          request.onsuccess?.();
        });
        return request;
      },
    },
  });
}

function loadStorage(os: "ios" | "web"): StorageModule {
  jest.resetModules();
  const reactNative = require("react-native") as { Platform: { OS: string } };
  reactNative.Platform.OS = os;
  const SecureStore = require("expo-secure-store") as typeof import("expo-secure-store");
  (SecureStore.getItemAsync as jest.Mock).mockImplementation(async (key: string) =>
    secureValues.get(key) ?? null);
  (SecureStore.setItemAsync as jest.Mock).mockImplementation(async (key: string, value: string) => {
    secureValues.set(key, value);
  });
  (SecureStore.deleteItemAsync as jest.Mock).mockImplementation(async (key: string) => {
    secureValues.delete(key);
  });
  return require("@/utils/importDraftStorage") as StorageModule;
}

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

beforeEach(async () => {
  secureValues.clear();
  mockAsyncValues.clear();
  mockWebKeys.clear();
  Object.assign(globalThis, { __importDraftAsyncValues: mockAsyncValues });
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
  const sampleKey = await webcrypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  Object.defineProperty(globalThis, "CryptoKey", {
    configurable: true,
    value: sampleKey.constructor,
  });
  installIndexedDb();
  jest.spyOn(Date, "now").mockReturnValue(1_000);
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

describe("import draft storage", () => {
  it("restores only for the owning user and clears every encrypted chunk", async () => {
    const { clearImportDraft, loadImportDraft, saveImportDraft } = loadStorage("ios");
    await saveImportDraft("admin-user", draft);

    await expect(loadImportDraft("other-user")).resolves.toBeNull();
    await expect(loadImportDraft("admin-user")).resolves.toEqual(draft);

    await clearImportDraft("admin-user");
    await expect(loadImportDraft("admin-user")).resolves.toBeNull();
    expect([...secureValues.keys()].filter(key => key.includes("admin-user"))).toHaveLength(0);
  });

  it("expires and deletes a stale draft", async () => {
    const { loadImportDraft, saveImportDraft } = loadStorage("ios");
    await saveImportDraft("admin-user", draft);
    (Date.now as jest.Mock).mockReturnValue(24 * 60 * 60 * 1000 + 1_001);

    await expect(loadImportDraft("admin-user")).resolves.toBeNull();
    expect([...secureValues.keys()].filter(key => key.includes("admin-user"))).toHaveLength(0);
  });

  it("orders logout deletion after a pending save", async () => {
    const { clearImportDraft, loadImportDraft, saveImportDraft } = loadStorage("ios");
    const SecureStore = require("expo-secure-store") as typeof import("expo-secure-store");
    let releaseFirstChunk!: () => void;
    const firstChunkBlocked = new Promise<void>(resolve => { releaseFirstChunk = resolve; });
    let blocked = false;
    (SecureStore.setItemAsync as jest.Mock).mockImplementation(async (key: string, value: string) => {
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

describe("import draft storage on web", () => {
  it("encrypts a draft and restores it after a module reload only for its owner", async () => {
    const firstLoad = loadStorage("web");
    await firstLoad.saveImportDraft("admin-user", draft);

    const encrypted = [...mockAsyncValues.values()][0];
    expect(encrypted).toBeDefined();
    expect(encrypted).not.toContain(draft.rawCsv);
    expect(encrypted).not.toContain("XLSX-001");

    const afterReload = loadStorage("web");
    await expect(afterReload.loadImportDraft("other-user")).resolves.toBeNull();
    await expect(afterReload.loadImportDraft("admin-user")).resolves.toEqual(draft);
  });

  it("expires and deletes a stale encrypted draft and its key", async () => {
    const storage = loadStorage("web");
    await storage.saveImportDraft("admin-user", draft);
    (Date.now as jest.Mock).mockReturnValue(24 * 60 * 60 * 1000 + 1_001);

    await expect(loadStorage("web").loadImportDraft("admin-user")).resolves.toBeNull();
    expect(mockAsyncValues.size).toBe(0);
    expect(mockWebKeys.size).toBe(0);
  });

  it("deletes encrypted draft bytes and the persisted key", async () => {
    const storage = loadStorage("web");
    await storage.saveImportDraft("admin-user", draft);

    await loadStorage("web").clearImportDraft("admin-user");

    await expect(loadStorage("web").loadImportDraft("admin-user")).resolves.toBeNull();
    expect(mockAsyncValues.size).toBe(0);
    expect(mockWebKeys.size).toBe(0);
  });

  it("rejects corrupt ciphertext and clears it safely", async () => {
    const storage = loadStorage("web");
    await storage.saveImportDraft("admin-user", draft);
    const entry = [...mockAsyncValues.entries()][0];
    expect(entry).toBeDefined();
    const [key, envelope] = entry!;
    const parsed = JSON.parse(envelope) as { iv: string; ciphertext: string };
    parsed.ciphertext = `${parsed.ciphertext[0] === "A" ? "B" : "A"}${parsed.ciphertext.slice(1)}`;
    mockAsyncValues.set(key, JSON.stringify(parsed));

    await expect(loadStorage("web").loadImportDraft("admin-user")).resolves.toBeNull();
    expect(mockAsyncValues.size).toBe(0);
    expect(mockWebKeys.size).toBe(0);
  });
});