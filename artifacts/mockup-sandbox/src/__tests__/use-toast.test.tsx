import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useToast } from "../hooks/use-toast";

type ToastControls = ReturnType<typeof useToast>;

function ToastConsumer({
  capture,
}: {
  capture: (controls: ToastControls) => void;
}) {
  const controls = useToast();
  capture(controls);
  return <div data-testid="toast-count">{controls.toasts.length}</div>;
}

describe("useToast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("removes a toast once after repeated dismiss calls", () => {
    let controls!: ToastControls;
    render(<ToastConsumer capture={(nextControls) => { controls = nextControls; }} />);

    let createdToast!: ReturnType<ToastControls["toast"]>;
    act(() => {
      createdToast = controls.toast({ title: "Saved" });
    });
    act(() => {
      createdToast.dismiss();
      createdToast.dismiss();
    });

    expect(vi.getTimerCount()).toBe(1);
    expect(controls.toasts[0]?.open).toBe(false);

    act(() => {
      vi.advanceTimersByTime(4999);
    });
    expect(controls.toasts).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(controls.toasts).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restores the current toast state after a consumer remounts", () => {
    let firstControls!: ToastControls;
    const firstCapture = (nextControls: ToastControls) => {
      firstControls = nextControls;
    };

    const firstRender = render(<ToastConsumer capture={firstCapture} />);
    act(() => {
      firstControls.toast({ title: "Needs review" });
    });
    expect(firstControls.toasts).toHaveLength(1);

    firstRender.unmount();

    let remountedControls!: ToastControls;
    render(
      <ToastConsumer
        capture={(nextControls) => {
          remountedControls = nextControls;
        }}
      />,
    );

    expect(remountedControls.toasts).toHaveLength(1);
    act(() => {
      remountedControls.dismiss();
    });
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(remountedControls.toasts).toHaveLength(0);
  });
});