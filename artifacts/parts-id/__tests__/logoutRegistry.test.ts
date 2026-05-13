/**
 * @jest-environment node
 *
 * Pins the logout-handler registry contract used by AppContext so the
 * SearchScreen state-reset on logout actually fires (and unsubscribes
 * cleanly when the screen unmounts).
 */
import { LogoutRegistry } from "../utils/logoutRegistry";

describe("LogoutRegistry", () => {
  let warnSpy: jest.SpyInstance;
  beforeEach(() => {
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warnSpy.mockRestore());

  it("invokes every registered handler on fire()", () => {
    const reg = new LogoutRegistry();
    const a = jest.fn();
    const b = jest.fn();
    reg.register(a);
    reg.register(b);
    reg.fire();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("returns an unsubscribe that removes the handler", () => {
    const reg = new LogoutRegistry();
    const handler = jest.fn();
    const unsubscribe = reg.register(handler);
    unsubscribe();
    reg.fire();
    expect(handler).not.toHaveBeenCalled();
    expect(reg.size()).toBe(0);
  });

  it("continues firing remaining handlers if one throws", () => {
    const reg = new LogoutRegistry();
    const ok1 = jest.fn();
    const bad = jest.fn(() => { throw new Error("boom"); });
    const ok2 = jest.fn();
    reg.register(ok1);
    reg.register(bad);
    reg.register(ok2);
    expect(() => reg.fire()).not.toThrow();
    expect(ok1).toHaveBeenCalled();
    expect(ok2).toHaveBeenCalled();
  });

  it("is a no-op when no handlers are registered", () => {
    const reg = new LogoutRegistry();
    expect(() => reg.fire()).not.toThrow();
  });

  it("calling unsubscribe twice is safe", () => {
    const reg = new LogoutRegistry();
    const handler = jest.fn();
    const unsubscribe = reg.register(handler);
    unsubscribe();
    unsubscribe();
    reg.fire();
    expect(handler).not.toHaveBeenCalled();
  });
});
