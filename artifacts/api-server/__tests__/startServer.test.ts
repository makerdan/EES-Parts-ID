/**
 * Unit tests for src/lib/startServer.ts
 *
 * Mocks app.listen and the returned Server's error callbacks to simulate
 * EADDRINUSE and other errors without binding real OS ports.
 */

jest.mock("../src/lib/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { startServer, MAX_RETRIES, RETRY_DELAY_MS } from "../src/lib/startServer";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEaddrinuse(): NodeJS.ErrnoException {
  const err = new Error("listen EADDRINUSE :::3000") as NodeJS.ErrnoException;
  err.code = "EADDRINUSE";
  return err;
}

function makeOtherError(): NodeJS.ErrnoException {
  const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
  err.code = "EACCES";
  return err;
}

type FakeServer = {
  close: jest.Mock<void, [cb?: (() => void) | undefined]>;
  on: jest.Mock;
  triggerError: (err: NodeJS.ErrnoException) => void;
};

/**
 * Builds a factory whose mock `server.close(cb)` invokes the callback via
 * setImmediate, simulating real async OS socket teardown before the retry fires.
 */
function buildServerFactory(): { listen: jest.Mock; servers: FakeServer[] } {
  const servers: FakeServer[] = [];

  const listen = jest.fn(() => {
    let errorCb: ((err: NodeJS.ErrnoException) => void) | undefined;

    const server: FakeServer = {
      close: jest.fn((cb?: () => void) => {
        if (cb) setImmediate(cb);
      }),
      on: jest.fn((event: string, cb: unknown) => {
        if (event === "error") {
          errorCb = cb as (err: NodeJS.ErrnoException) => void;
        }
      }),
      triggerError: (err) => errorCb?.(err),
    };
    servers.push(server);
    return server;
  });

  return { listen, servers };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("startServer", () => {
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    jest.useRealTimers();
  });

  it("exports MAX_RETRIES=10 and RETRY_DELAY_MS=2000", () => {
    expect(MAX_RETRIES).toBe(10);
    expect(RETRY_DELAY_MS).toBe(2000);
    // Guard: retry window must exceed the old defaults (5 retries × 1 s = 5 s)
    // so a slow OS port-reclaim during dev restarts is handled without crashing.
    expect(MAX_RETRIES).toBeGreaterThanOrEqual(8);
    expect(RETRY_DELAY_MS).toBeGreaterThanOrEqual(1500);
  });

  it("calls process.exit(1) after exhausting all retries on EADDRINUSE", () => {
    const { listen, servers } = buildServerFactory();
    const mockApp = { listen } as never;
    const RETRIES = 2;

    startServer(mockApp, 3000, RETRIES, 0);

    // retries=2 → fires, then retry
    servers[0]!.triggerError(makeEaddrinuse());
    jest.runAllTimers();

    // retries=1 → fires, then retry
    servers[1]!.triggerError(makeEaddrinuse());
    jest.runAllTimers();

    // retries=0 → no more retries, exit
    servers[2]!.triggerError(makeEaddrinuse());

    expect(listen).toHaveBeenCalledTimes(RETRIES + 1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("closes the previous server on each EADDRINUSE retry", () => {
    const { listen, servers } = buildServerFactory();
    const mockApp = { listen } as never;

    startServer(mockApp, 3000, 1, 0);
    servers[0]!.triggerError(makeEaddrinuse());
    jest.runAllTimers();

    expect(servers[0]!.close).toHaveBeenCalledTimes(1);
    expect(listen).toHaveBeenCalledTimes(2);
  });

  it("does not call process.exit when the port becomes free within the retry window", () => {
    const { listen, servers } = buildServerFactory();
    const mockApp = { listen } as never;

    startServer(mockApp, 3000, 2, 0);

    // First attempt fails with EADDRINUSE.
    servers[0]!.triggerError(makeEaddrinuse());
    jest.runAllTimers();

    // Second attempt succeeds — no error is fired on server[1].
    expect(servers[1]).toBeDefined();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(listen).toHaveBeenCalledTimes(2);
  });

  it("calls process.exit(1) immediately for a non-EADDRINUSE error, without retrying", () => {
    const { listen, servers } = buildServerFactory();
    const mockApp = { listen } as never;

    startServer(mockApp, 3000, MAX_RETRIES, 0);
    servers[0]!.triggerError(makeOtherError());

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(listen).toHaveBeenCalledTimes(1);
  });

  it("calls process.exit(1) immediately on EADDRINUSE when retries=0", () => {
    const { listen, servers } = buildServerFactory();
    const mockApp = { listen } as never;

    startServer(mockApp, 3000, 0, 0);
    servers[0]!.triggerError(makeEaddrinuse());

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(listen).toHaveBeenCalledTimes(1);
  });

  it("does not retry until the close callback fires", () => {
    let pendingCloseCb: (() => void) | undefined;

    const listen = jest.fn(() => {
      let errorCb: ((err: NodeJS.ErrnoException) => void) | undefined;
      const server: FakeServer = {
        close: jest.fn((cb?: () => void) => {
          pendingCloseCb = cb;
        }),
        on: jest.fn((event: string, cb: unknown) => {
          if (event === "error") {
            errorCb = cb as (err: NodeJS.ErrnoException) => void;
          }
        }),
        triggerError: (err) => errorCb?.(err),
      };
      return server;
    });

    const mockApp = { listen } as never;
    startServer(mockApp, 3000, 1, 0);

    const server0 = listen.mock.results[0]!.value as FakeServer;
    server0.triggerError(makeEaddrinuse());

    // close was called, but callback is pending — retry must not have fired yet
    expect(server0.close).toHaveBeenCalledTimes(1);
    expect(listen).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();

    // Now release the close callback, which schedules the setTimeout(0) retry
    pendingCloseCb!();
    jest.runAllTimers();

    // After the callback fires and timers drain, the retry should have happened
    expect(listen).toHaveBeenCalledTimes(2);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
