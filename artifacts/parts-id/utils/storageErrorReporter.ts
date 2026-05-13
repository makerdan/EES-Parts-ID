/**
 * Centralized reporter for AsyncStorage / SecureStore write failures.
 *
 * Modules that write to local storage can call `reportStorageError(label, err)`
 * instead of swallowing failures with `.catch(() => {})`. The default handler
 * logs to the console; `AppProvider` overrides it on mount with one that
 * surfaces a non-blocking toast so the user sees that a setting was not saved.
 */
export type StorageErrorHandler = (label: string, err: unknown) => void;

const defaultHandler: StorageErrorHandler = (label, err) => {
  // eslint-disable-next-line no-console
  console.warn(`[storage] ${label}:`, err);
};

let handler: StorageErrorHandler = defaultHandler;

export function setStorageErrorHandler(h: StorageErrorHandler | null): void {
  handler = h ?? defaultHandler;
}

export function reportStorageError(label: string, err: unknown): void {
  try {
    handler(label, err);
  } catch {
    // never let a misbehaving handler crash the caller
  }
}
