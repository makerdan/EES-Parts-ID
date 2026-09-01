import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import { WarehouseMapViewer } from "../pages/WarehouseMapViewer";

describe("WarehouseMapViewer lifecycle cancellation", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("aborts a pending floor-plan load when the viewer unmounts", async () => {
    let resolveFloorPlan!: (value: Response) => void;
    const floorPlanResponse = new Promise<Response>((resolve) => {
      resolveFloorPlan = resolve;
    });
    const fetchMock = vi.fn((...args: [string, RequestInit?]) => {
      const url = args[0];
      if (url.includes("/floor-plan/svg")) return floorPlanResponse;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ zones: [] }),
      } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = render(<WarehouseMapViewer />);
    await act(async () => {
      await Promise.resolve();
    });
    const floorPlanCall = fetchMock.mock.calls.find(([url]) => url.includes("/floor-plan/svg"));
    expect(floorPlanCall).toBeDefined();
    const signal = floorPlanCall?.[1]?.signal;
    expect(signal).toBeDefined();

    view.unmount();
    expect(signal?.aborted).toBe(true);

    resolveFloorPlan({
      ok: true,
      status: 200,
      text: () => Promise.resolve("<svg></svg>"),
    } as Response);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  });
});