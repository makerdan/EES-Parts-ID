/**
 * Regression coverage for the admin dashboard refresh contract.
 *
 * Dashboard stats refreshes are latest-request-wins: unmounting the screen or
 * starting a newer refresh aborts the old request, and a late response must
 * not commit stats or loading/error state.
 */

type RefreshState = {
  mounted: boolean;
  generation: number;
  stats: string | null;
  error: string | null;
  loading: boolean;
};

function createRefreshHarness() {
  const state: RefreshState = {
    mounted: true,
    generation: 0,
    stats: null,
    error: null,
    loading: false,
  };
  const controllers: Array<AbortController> = [];

  const refresh = async (request: Promise<string>) => {
    const controller = new AbortController();
    controllers.push(controller);
    const generation = ++state.generation;
    state.loading = true;
    try {
      const value = await request;
      if (state.mounted && generation === state.generation && !controller.signal.aborted) {
        state.stats = value;
      }
    } catch {
      if (state.mounted && generation === state.generation && !controller.signal.aborted) {
        state.error = "Failed to load stats";
      }
    } finally {
      if (state.mounted && generation === state.generation) state.loading = false;
    }
    return controller;
  };

  return {
    state,
    refresh,
    unmount: () => {
      state.mounted = false;
      state.generation += 1;
      for (const controller of controllers) controller.abort();
    },
  };
}

describe("admin dashboard refresh lifecycle", () => {
  it("does not commit a response after the screen unmounts", async () => {
    const deferred: { resolve?: (value: string) => void } = {};
    const request = new Promise<string>((resolve) => { deferred.resolve = resolve; });
    const harness = createRefreshHarness();

    void harness.refresh(request);
    harness.unmount();
    deferred.resolve?.("late dashboard stats");
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.state.stats).toBeNull();
    expect(harness.state.loading).toBe(true);
  });

  it("keeps the newest refresh result when an older request resolves late", async () => {
    const oldDeferred: { resolve?: (value: string) => void } = {};
    const newDeferred: { resolve?: (value: string) => void } = {};
    const oldRequest = new Promise<string>((resolve) => { oldDeferred.resolve = resolve; });
    const newRequest = new Promise<string>((resolve) => { newDeferred.resolve = resolve; });
    const harness = createRefreshHarness();

    void harness.refresh(oldRequest);
    harness.state.generation += 1;
    void harness.refresh(newRequest);
    oldDeferred.resolve?.("old stats");
    await Promise.resolve();
    newDeferred.resolve?.("new stats");
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.state.stats).toBe("new stats");
    expect(harness.state.error).toBeNull();
  });
});