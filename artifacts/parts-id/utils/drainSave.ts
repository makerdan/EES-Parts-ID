/**
 * Drain-loop save runner used by the KeywordEditor (and other auto-save UIs).
 *
 * Repeatedly calls `save(latest)` until the latest value matches the last
 * persisted value. This guarantees the most recent edit always lands, even
 * when the user keeps editing while a save is in flight — no edit is ever
 * silently dropped.
 *
 * Concurrency: the caller passes a shared `isRunningRef` so that a second
 * triggerSave() call entered while the loop is running becomes a no-op; the
 * already-running loop will pick up the new latest value on its next tick.
 */
export interface DrainSaveOptions<T> {
  getLatest: () => T;
  getLastSaved: () => T;
  setLastSaved: (v: T) => void;
  save: (v: T) => Promise<void>;
  equal: (a: T, b: T) => boolean;
  isRunningRef: { current: boolean };
}

export async function drainSave<T>(opts: DrainSaveOptions<T>): Promise<void> {
  const { getLatest, getLastSaved, setLastSaved, save, equal, isRunningRef } = opts;
  if (isRunningRef.current) return;
  if (equal(getLatest(), getLastSaved())) return;
  isRunningRef.current = true;
  try {
    while (!equal(getLatest(), getLastSaved())) {
      const current = getLatest();
      await save(current);
      setLastSaved(current);
    }
  } finally {
    isRunningRef.current = false;
  }
}
