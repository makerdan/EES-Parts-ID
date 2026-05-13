/**
 * @jest-environment node
 *
 * Pins the per-item save isolation in KeywordEditor: closing item A
 * mid-save and immediately opening item B must NEVER cause B's keywords
 * to be written to A's id (or vice-versa). The fix keys all save state
 * by item id in `stateByIdRef`, so each drainSave run reads/writes only
 * its own entry.
 *
 * We model the same per-id state machine here directly against drainSave
 * to lock the contract regardless of any future React-side refactor.
 */
import { drainSave } from "../utils/drainSave";
import { arraysEqual } from "../utils/arraysEqual";

type ItemState = { latest: string[]; lastSaved: string[]; saving: boolean };

function performSaveForId(
  stateById: Record<number, ItemState>,
  id: number,
  saveImpl: (id: number, kws: string[]) => Promise<void>,
): Promise<void> {
  const s = stateById[id];
  if (!s) return Promise.resolve();
  if (s.saving) return Promise.resolve();
  if (arraysEqual(s.latest, s.lastSaved)) return Promise.resolve();
  s.saving = true;
  return drainSave({
    getLatest: () => s.latest,
    getLastSaved: () => s.lastSaved,
    setLastSaved: v => { s.lastSaved = v; },
    save: kws => saveImpl(id, kws),
    equal: arraysEqual,
    isRunningRef: { current: false },
  }).finally(() => { s.saving = false; });
}

describe("KeywordEditor cross-item save isolation", () => {
  it("does NOT write item B's keywords to item A's id when user switches mid-save", async () => {
    const stateById: Record<number, ItemState> = {
      1: { latest: ["a-edit"], lastSaved: [], saving: false },
    };
    const writes: Array<{ id: number; kws: string[] }> = [];

    let resolveFirst!: () => void;
    const firstSavePromise = new Promise<void>(r => { resolveFirst = r; });

    const saveImpl = jest.fn(async (id: number, kws: string[]) => {
      writes.push({ id, kws });
      if (writes.length === 1) {
        // First save (for id=1) is in flight — simulate the user closing
        // item A and opening item B mid-flight.
        await firstSavePromise;
      }
    });

    // Kick off save for id=1 (item A).
    const aSavePromise = performSaveForId(stateById, 1, saveImpl);

    // While A's save is in flight, open item B and edit it.
    stateById[2] = { latest: ["b-edit"], lastSaved: [], saving: false };

    // The buggy implementation (one shared ref pair) would now have B's
    // edits visible to A's running drain loop. With per-id isolation,
    // A's loop only ever sees state[1].
    resolveFirst();
    await aSavePromise;

    // Now save B independently.
    await performSaveForId(stateById, 2, saveImpl);

    // Crucial assertions: every write goes to the correct id with the
    // correct keywords. No cross-contamination.
    expect(writes).toEqual([
      { id: 1, kws: ["a-edit"] },
      { id: 2, kws: ["b-edit"] },
    ]);
    expect(writes.some(w => w.id === 1 && w.kws.includes("b-edit"))).toBe(false);
    expect(writes.some(w => w.id === 2 && w.kws.includes("a-edit"))).toBe(false);
    expect(stateById[1].lastSaved).toEqual(["a-edit"]);
    expect(stateById[2].lastSaved).toEqual(["b-edit"]);
  });

  it("close-then-reopen of the SAME item still drains pending edits made before close", async () => {
    const stateById: Record<number, ItemState> = {
      1: { latest: ["edit1"], lastSaved: [], saving: false },
    };
    const writes: Array<{ id: number; kws: string[] }> = [];

    const saveImpl = jest.fn(async (id: number, kws: string[]) => {
      writes.push({ id, kws });
      // Simulate further editing landing on the same item state mid-save.
      if (writes.length === 1) {
        stateById[1].latest = ["edit1", "edit2"];
      }
    });

    await performSaveForId(stateById, 1, saveImpl);

    expect(writes).toEqual([
      { id: 1, kws: ["edit1"] },
      { id: 1, kws: ["edit1", "edit2"] },
    ]);
    expect(stateById[1].lastSaved).toEqual(["edit1", "edit2"]);
  });

  it("a second performSaveForId(id) entered while one is running for the same id is a no-op", async () => {
    const stateById: Record<number, ItemState> = {
      1: { latest: ["x"], lastSaved: [], saving: true }, // already saving
    };
    const saveImpl = jest.fn();
    await performSaveForId(stateById, 1, saveImpl);
    expect(saveImpl).not.toHaveBeenCalled();
  });
});
