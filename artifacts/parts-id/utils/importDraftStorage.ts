import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

import type { ParsedRow } from "@/utils/binSkipLogic";

const DRAFT_VERSION = 1;
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const CHUNK_SIZE = 1_500;
const KEY_PREFIX = "parts_id_import_draft_v1";
const WEB_KEY_DB = "parts-id-import-draft-keys";
const WEB_KEY_STORE = "keys";
const userOperations = new Map<string, Promise<unknown>>();

export type ImportDraft = {
  parsedRows: Array<ParsedRow>;
  rawCsv: string;
  fileName: string | null;
  fileType: "csv" | "xlsx" | "ods" | null;
  importMode: "full" | "opoq";
  skipBinRows: Array<number>;
  selectedUnknownRows: Array<number>;
};

type StoredDraft = ImportDraft & {
  version: typeof DRAFT_VERSION;
  userId: string;
  expiresAt: number;
};

function userKey(userId: string): string {
  return `${KEY_PREFIX}:${userId.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function runForUser<T>(userId: string, operation: () => Promise<T>): Promise<T> {
  const previous = userOperations.get(userId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  userOperations.set(userId, next);
  void next.finally(() => {
    if (userOperations.get(userId) === next) userOperations.delete(userId);
  }).catch(() => {});
  return next;
}

function openWebKeyDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(WEB_KEY_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(WEB_KEY_STORE)) {
        request.result.createObjectStore(WEB_KEY_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open import draft key store"));
  });
}

async function readWebCryptoKey(key: string): Promise<CryptoKey | null> {
  const db = await openWebKeyDb();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(WEB_KEY_STORE, "readonly").objectStore(WEB_KEY_STORE).get(key);
      request.onsuccess = () => resolve(request.result instanceof CryptoKey ? request.result : null);
      request.onerror = () => reject(request.error ?? new Error("Could not read import draft key"));
    });
  } finally {
    db.close();
  }
}

async function writeWebCryptoKey(key: string, cryptoKey: CryptoKey): Promise<void> {
  const db = await openWebKeyDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(WEB_KEY_STORE, "readwrite");
      transaction.objectStore(WEB_KEY_STORE).put(cryptoKey, key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not save import draft key"));
    });
  } finally {
    db.close();
  }
}

async function deleteWebCryptoKey(key: string): Promise<void> {
  const db = await openWebKeyDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(WEB_KEY_STORE, "readwrite");
      transaction.objectStore(WEB_KEY_STORE).delete(key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not delete import draft key"));
    });
  } finally {
    db.close();
  }
}

async function getWebCryptoKey(key: string): Promise<CryptoKey> {
  const stored = await readWebCryptoKey(key);
  if (stored) return stored;
  const generated = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  await writeWebCryptoKey(key, generated);
  return generated;
}

async function encryptWebDraft(key: string, serialized: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await getWebCryptoKey(key);
  const plaintext = new TextEncoder().encode(serialized);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, plaintext);
  return JSON.stringify({
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
  });
}

async function decryptWebDraft(key: string, envelope: string): Promise<string> {
  const parsed = JSON.parse(envelope) as { iv?: unknown; ciphertext?: unknown };
  if (typeof parsed.iv !== "string" || typeof parsed.ciphertext !== "string") {
    throw new Error("Invalid encrypted import draft");
  }
  const cryptoKey = await getWebCryptoKey(key);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(base64ToBytes(parsed.iv)) },
    cryptoKey,
    toArrayBuffer(base64ToBytes(parsed.ciphertext)),
  );
  return new TextDecoder().decode(decrypted);
}

async function clearNativeDraft(key: string): Promise<void> {
  const countRaw = await SecureStore.getItemAsync(`${key}:count`);
  const count = Number(countRaw);
  if (Number.isInteger(count) && count > 0 && count < 10_000) {
    await Promise.all(Array.from({ length: count }, (_, index) =>
      SecureStore.deleteItemAsync(`${key}:${index}`),
    ));
  }
  await SecureStore.deleteItemAsync(`${key}:count`);
}

async function clearImportDraftNow(userId: string): Promise<void> {
  const key = userKey(userId);
  if (Platform.OS === "web") {
    await Promise.all([AsyncStorage.removeItem(key), deleteWebCryptoKey(key)]);
    return;
  }
  await clearNativeDraft(key);
}

export function clearImportDraft(userId: string): Promise<void> {
  return runForUser(userId, () => clearImportDraftNow(userId));
}

async function saveImportDraftNow(userId: string, draft: ImportDraft): Promise<void> {
  const key = userKey(userId);
  const serialized = JSON.stringify({
    ...draft,
    version: DRAFT_VERSION,
    userId,
    expiresAt: Date.now() + DRAFT_TTL_MS,
  } satisfies StoredDraft);

  if (Platform.OS === "web") {
    await AsyncStorage.setItem(key, await encryptWebDraft(key, serialized));
    return;
  }

  await clearNativeDraft(key);
  const chunks = Array.from(
    { length: Math.ceil(serialized.length / CHUNK_SIZE) },
    (_, index) => serialized.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE),
  );
  await Promise.all(chunks.map((chunk, index) =>
    SecureStore.setItemAsync(`${key}:${index}`, chunk),
  ));
  await SecureStore.setItemAsync(`${key}:count`, String(chunks.length));
}

export function saveImportDraft(userId: string, draft: ImportDraft): Promise<void> {
  return runForUser(userId, () => saveImportDraftNow(userId, draft));
}

async function loadImportDraftNow(userId: string): Promise<ImportDraft | null> {
  const key = userKey(userId);
  let serialized: string | null;
  if (Platform.OS === "web") {
    const encrypted = await AsyncStorage.getItem(key);
    if (!encrypted) return null;
    try {
      serialized = await decryptWebDraft(key, encrypted);
    } catch {
      await clearImportDraftNow(userId);
      return null;
    }
  } else {
    const countRaw = await SecureStore.getItemAsync(`${key}:count`);
    const count = Number(countRaw);
    if (!Number.isInteger(count) || count <= 0 || count >= 10_000) return null;
    const chunks = await Promise.all(Array.from({ length: count }, (_, index) =>
      SecureStore.getItemAsync(`${key}:${index}`),
    ));
    serialized = chunks.every((chunk): chunk is string => chunk !== null)
      ? chunks.join("")
      : null;
  }
  if (!serialized) return null;

  try {
    const stored = JSON.parse(serialized) as Partial<StoredDraft>;
    if (
      stored.version !== DRAFT_VERSION ||
      stored.userId !== userId ||
      typeof stored.expiresAt !== "number" ||
      stored.expiresAt <= Date.now() ||
      !Array.isArray(stored.parsedRows) ||
      stored.parsedRows.length === 0 ||
      typeof stored.rawCsv !== "string" ||
      !stored.rawCsv
    ) {
      await clearImportDraftNow(userId);
      return null;
    }
    return {
      parsedRows: stored.parsedRows,
      rawCsv: stored.rawCsv,
      fileName: typeof stored.fileName === "string" ? stored.fileName : null,
      fileType: stored.fileType === "csv" || stored.fileType === "xlsx" || stored.fileType === "ods"
        ? stored.fileType
        : null,
      importMode: stored.importMode === "opoq" ? "opoq" : "full",
      skipBinRows: Array.isArray(stored.skipBinRows)
        ? stored.skipBinRows.filter(Number.isInteger)
        : [],
      selectedUnknownRows: Array.isArray(stored.selectedUnknownRows)
        ? stored.selectedUnknownRows.filter(Number.isInteger)
        : [],
    };
  } catch {
    await clearImportDraftNow(userId);
    return null;
  }
}

export function loadImportDraft(userId: string): Promise<ImportDraft | null> {
  return runForUser(userId, () => loadImportDraftNow(userId));
}