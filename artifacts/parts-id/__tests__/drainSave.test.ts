/**
 * @jest-environment node
 *
 * Pins the auto-save queueing contract used by KeywordEditor:
 *   - The most recent edit always lands, even if it arrives while a save is
 *     in flight (no silent drops).
 *   - A second drainSave() call entered while one is already running is a
 *     no-op; the running loop picks up the latest value.
 *   - Equal latest/lastSaved is a no-op (no spurious mutations).
 */
import { drainSave } from "../utils/drainSave";
import { arraysEqual } from "../utils/arraysEqual";

function defer<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe("drainSave", () => {
  it("is a no-op when latest equals lastSaved", async () => {
    const isRunningRef = { current: false };
    const save = jest.fn();
    let lastSaved = ["a"];
    await drainSave({
      getLatest: () => ["a"],
      getLastSaved: () => lastSaved,
      setLastSaved: v => { lastSaved = v; },
      save,
      equal: arraysEqual,
      isRunningRef,
    });
    expect(save).not.toHaveBeenCalled();
    expect(isRunningRef.current).toBe(false);
  });

  it("is a no-op when isRunningRef is already true (concurrent call)", async () => {
    const isRunningRef = { current: true };
    const save = jest.fn();
    await drainSave({
      getLatest: () => ["x"],
      getLastSaved: () => ["y"],
      setLastSaved: () => {},
      save,
      equal: arraysEqual,
      isRunningRef,
    });
    expect(save).not.toHaveBeenCalled();
    expect(isRunningRef.current).toBe(true); // unchanged
  });

  it("saves once when latest differs from lastSaved and is then steady", async () => {
    const isRunningRef = { current: false };
    let lastSaved: string[] = [];
    const save = jest.fn(async () => {});
    await drainSave({
      getLatest: () => ["a", "b"],
      getLastSaved: () => lastSaved,
      setLastSaved: v => { lastSaved = v; },
      save,
      equal: arraysEqual,
      isRunningRef,
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(["a", "b"]);
    expect(lastSaved).toEqual(["a", "b"]);
    expect(isRunningRef.current).toBe(false);
  });

  it("drains intermediate edits made while a save is in flight (no drops)", async () => {
    const isRunningRef = { current: false };
    let lastSaved: string[] = [];
    let latest: string[] = ["edit1"];

    // Each save resolves on its own deferred so we can simulate the user
    // typing while a previous save is still in flight.
    const deferreds: Array<ReturnType<typeof defer<void>>> = [];
    const save = jest.fn(async (v: string[]) => {
      const d = defer<void>();
      deferreds.push(d);
      // Simulate a user edit landing during the in-flight save.
      if (v[0] === "edit1") {
        // user keeps typing — latest moves on while we're "saving"
        setTimeout(() => { latest = ["edit2"]; d.resolve(); }, 0);
      } else if (v[0] === "edit2") {
        setTimeout(() => { latest = ["edit3"]; d.resolve(); }, 0);
      } else {
        setTimeout(() => { d.resolve(); }, 0);
      }
      await d.promise;
    });

    await drainSave({
      getLatest: () => latest,
      getLastSaved: () => lastSaved,
      setLastSaved: v => { lastSaved = v; },
      save,
      equal: arraysEqual,
      isRunningRef,
    });

    // All three edits landed in order — no drops.
    expect(save.mock.calls.map(c => c[0])).toEqual([
      ["edit1"],
      ["edit2"],
      ["edit3"],
    ]);
    expect(lastSaved).toEqual(["edit3"]);
    expect(isRunningRef.current).toBe(false);
  });

  it("releases isRunningRef even if save throws", async () => {
    const isRunningRef = { current: false };
    const save = jest.fn(async () => { throw new Error("boom"); });
    await expect(drainSave({
      getLatest: () => ["a"],
      getLastSaved: () => [],
      setLastSaved: () => {},
      save,
      equal: arraysEqual,
      isRunningRef,
    })).rejects.toThrow("boom");
    expect(isRunningRef.current).toBe(false);
  });
});
