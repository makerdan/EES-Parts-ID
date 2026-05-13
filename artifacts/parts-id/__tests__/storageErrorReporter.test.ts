/**
 * @jest-environment node
 *
 * Pins that storage-write failures route through the registered handler
 * (so the AppContext toast surfaces them) and that resetting the handler
 * restores the safe default.
 */
import {
  reportStorageError,
  setStorageErrorHandler,
} from "../utils/storageErrorReporter";

describe("storageErrorReporter", () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    setStorageErrorHandler(null); // reset to default
    warnSpy.mockRestore();
  });

  it("invokes the registered handler with label and error", () => {
    const handler = jest.fn();
    setStorageErrorHandler(handler);
    const err = new Error("disk full");
    reportStorageError("Could not save settings", err);
    expect(handler).toHaveBeenCalledWith("Could not save settings", err);
  });

  it("falls back to console.warn when no custom handler is set", () => {
    const err = new Error("oops");
    reportStorageError("Could not save settings", err);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("setStorageErrorHandler(null) restores the default handler", () => {
    const handler = jest.fn();
    setStorageErrorHandler(handler);
    setStorageErrorHandler(null);
    reportStorageError("Could not save settings", new Error("x"));
    expect(handler).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("does not throw when the handler itself throws", () => {
    setStorageErrorHandler(() => {
      throw new Error("handler exploded");
    });
    expect(() =>
      reportStorageError("Could not save settings", new Error("x")),
    ).not.toThrow();
  });
});
