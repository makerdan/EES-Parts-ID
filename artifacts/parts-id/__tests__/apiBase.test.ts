/**
 * @jest-environment node
 *
 * Unit tests for utils/apiBase.ts.
 *
 * Covered:
 *  - Returns EXPO_PUBLIC_API_BASE override when set (native and web)
 *  - Returns https://<domain>/api (API_BASE) and https://<domain> (API_ORIGIN)
 *    when EXPO_PUBLIC_DOMAIN is set
 *  - In dev mode (__DEV__=true): returns http://localhost:8080/api (API_BASE)
 *    and http://localhost:8080 (API_ORIGIN) on native when neither env var is set
 *  - In production mode (__DEV__=false): throws when neither env var is set
 *    on native (fail-loud misconfiguration guard)
 *  - Returns "" for both exports on web when neither env var is set
 *
 * Because API_BASE and API_ORIGIN are module-level constants evaluated at
 * import time, each scenario uses jest.isolateModules() so the module is
 * freshly loaded with the right env-var + Platform.OS combination.
 *
 * __DEV__ is controlled per-test via global mutation inside isolateModules;
 * the jest.config.js baseline is { __DEV__: false } (production mode).
 */

type ApiBaseModule = { API_BASE: string; API_ORIGIN: string };
type PlatformOS = "ios" | "android" | "web";

/**
 * Load apiBase in a fresh module registry with controlled env vars,
 * Platform.OS, and __DEV__.  The react-native moduleNameMapper resolves to
 * the shared __mocks__/react-native.js object, which we mutate before
 * requiring apiBase so that the constant evaluation sees the right values.
 *
 * @param devMode - value to set for global.__DEV__ during module load
 *   (default false, matching the jest.config.js baseline)
 */
function loadApiBase(
  env: { EXPO_PUBLIC_API_BASE?: string; EXPO_PUBLIC_DOMAIN?: string },
  platformOS: PlatformOS,
  devMode = false,
): ApiBaseModule {
  let result!: ApiBaseModule;

  jest.isolateModules(() => {
    const savedBase = process.env.EXPO_PUBLIC_API_BASE;
    const savedDomain = process.env.EXPO_PUBLIC_DOMAIN;

    delete process.env.EXPO_PUBLIC_API_BASE;
    delete process.env.EXPO_PUBLIC_DOMAIN;
    if (env.EXPO_PUBLIC_API_BASE !== undefined) {
      process.env.EXPO_PUBLIC_API_BASE = env.EXPO_PUBLIC_API_BASE;
    }
    if (env.EXPO_PUBLIC_DOMAIN !== undefined) {
      process.env.EXPO_PUBLIC_DOMAIN = env.EXPO_PUBLIC_DOMAIN;
    }

    const rn = require("react-native") as { Platform: { OS: string } };
    const originalOS = rn.Platform.OS;
    rn.Platform.OS = platformOS;

    const savedDev = (global as Record<string, unknown>).__DEV__;
    (global as Record<string, unknown>).__DEV__ = devMode;

    result = require("../utils/apiBase") as ApiBaseModule;

    (global as Record<string, unknown>).__DEV__ = savedDev;
    rn.Platform.OS = originalOS;

    process.env.EXPO_PUBLIC_API_BASE = savedBase;
    process.env.EXPO_PUBLIC_DOMAIN = savedDomain;
    if (savedBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE;
    if (savedDomain === undefined) delete process.env.EXPO_PUBLIC_DOMAIN;
  });

  return result;
}

/**
 * Like loadApiBase but expects the module to throw at evaluation time.
 * Returns the caught error so callers can assert its message.
 */
function loadApiBaseExpectThrow(
  env: { EXPO_PUBLIC_API_BASE?: string; EXPO_PUBLIC_DOMAIN?: string },
  platformOS: PlatformOS,
  devMode = false,
): Error {
  let caughtError!: Error;

  jest.isolateModules(() => {
    const savedBase = process.env.EXPO_PUBLIC_API_BASE;
    const savedDomain = process.env.EXPO_PUBLIC_DOMAIN;

    delete process.env.EXPO_PUBLIC_API_BASE;
    delete process.env.EXPO_PUBLIC_DOMAIN;
    if (env.EXPO_PUBLIC_API_BASE !== undefined) {
      process.env.EXPO_PUBLIC_API_BASE = env.EXPO_PUBLIC_API_BASE;
    }
    if (env.EXPO_PUBLIC_DOMAIN !== undefined) {
      process.env.EXPO_PUBLIC_DOMAIN = env.EXPO_PUBLIC_DOMAIN;
    }

    const rn = require("react-native") as { Platform: { OS: string } };
    const originalOS = rn.Platform.OS;
    rn.Platform.OS = platformOS;

    const savedDev = (global as Record<string, unknown>).__DEV__;
    (global as Record<string, unknown>).__DEV__ = devMode;

    try {
      require("../utils/apiBase");
    } catch (err) {
      caughtError = err as Error;
    }

    (global as Record<string, unknown>).__DEV__ = savedDev;
    rn.Platform.OS = originalOS;

    process.env.EXPO_PUBLIC_API_BASE = savedBase;
    process.env.EXPO_PUBLIC_DOMAIN = savedDomain;
    if (savedBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE;
    if (savedDomain === undefined) delete process.env.EXPO_PUBLIC_DOMAIN;
  });

  return caughtError;
}

afterEach(() => {
  jest.resetModules();
});

describe("API_BASE", () => {
  it("returns EXPO_PUBLIC_API_BASE when set on native", () => {
    const { API_BASE } = loadApiBase(
      { EXPO_PUBLIC_API_BASE: "https://custom.example.com/api" },
      "ios",
    );
    expect(API_BASE).toBe("https://custom.example.com/api");
  });

  it("returns EXPO_PUBLIC_API_BASE when set on web", () => {
    const { API_BASE } = loadApiBase(
      { EXPO_PUBLIC_API_BASE: "https://custom.example.com/api" },
      "web",
    );
    expect(API_BASE).toBe("https://custom.example.com/api");
  });

  it("returns https://<domain>/api when EXPO_PUBLIC_DOMAIN is set", () => {
    const { API_BASE } = loadApiBase({ EXPO_PUBLIC_DOMAIN: "my.repl.co" }, "ios");
    expect(API_BASE).toBe("https://my.repl.co/api");
  });

  it("returns http://localhost:8080/api on iOS in dev mode when neither env var is set", () => {
    const { API_BASE } = loadApiBase({}, "ios", true);
    expect(API_BASE).toBe("http://localhost:8080/api");
  });

  it("returns http://localhost:8080/api on android in dev mode when neither env var is set", () => {
    const { API_BASE } = loadApiBase({}, "android", true);
    expect(API_BASE).toBe("http://localhost:8080/api");
  });

  it('returns "" on web when neither env var is set', () => {
    const { API_BASE } = loadApiBase({}, "web");
    expect(API_BASE).toBe("");
  });
});

describe("API_ORIGIN", () => {
  it("returns EXPO_PUBLIC_API_BASE with /api suffix stripped", () => {
    const { API_ORIGIN } = loadApiBase(
      { EXPO_PUBLIC_API_BASE: "https://custom.example.com/api" },
      "ios",
    );
    expect(API_ORIGIN).toBe("https://custom.example.com");
  });

  it("returns EXPO_PUBLIC_API_BASE unchanged when it does not end with /api", () => {
    const { API_ORIGIN } = loadApiBase(
      { EXPO_PUBLIC_API_BASE: "https://custom.example.com" },
      "ios",
    );
    expect(API_ORIGIN).toBe("https://custom.example.com");
  });

  it("returns https://<domain> when EXPO_PUBLIC_DOMAIN is set", () => {
    const { API_ORIGIN } = loadApiBase({ EXPO_PUBLIC_DOMAIN: "my.repl.co" }, "ios");
    expect(API_ORIGIN).toBe("https://my.repl.co");
  });

  it("returns http://localhost:8080 on native in dev mode when neither env var is set", () => {
    const { API_ORIGIN } = loadApiBase({}, "ios", true);
    expect(API_ORIGIN).toBe("http://localhost:8080");
  });

  it('returns "" on web when neither env var is set', () => {
    const { API_ORIGIN } = loadApiBase({}, "web");
    expect(API_ORIGIN).toBe("");
  });
});

describe("production misconfiguration guard", () => {
  it("throws at module load on iOS in production mode when neither env var is set", () => {
    const err = loadApiBaseExpectThrow({}, "ios", false);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/not configured for this production build/i);
  });

  it("throws at module load on android in production mode when neither env var is set", () => {
    const err = loadApiBaseExpectThrow({}, "android", false);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/not configured for this production build/i);
  });

  it("does NOT throw when EXPO_PUBLIC_API_BASE is set, even in production mode", () => {
    expect(() =>
      loadApiBase({ EXPO_PUBLIC_API_BASE: "https://custom.example.com/api" }, "ios", false),
    ).not.toThrow();
  });

  it("does NOT throw when EXPO_PUBLIC_DOMAIN is set, even in production mode", () => {
    expect(() =>
      loadApiBase({ EXPO_PUBLIC_DOMAIN: "my.repl.co" }, "ios", false),
    ).not.toThrow();
  });

  it("does NOT throw on web even in production mode when neither env var is set", () => {
    expect(() => loadApiBase({}, "web", false)).not.toThrow();
  });
});
