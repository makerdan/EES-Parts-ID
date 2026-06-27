/**
 * @jest-environment node
 *
 * Unit tests for utils/apiBase.ts.
 *
 * Covered:
 *  - Returns EXPO_PUBLIC_API_BASE override when set (native and web)
 *  - Returns https://<domain>/api (API_BASE) and https://<domain> (API_ORIGIN)
 *    when EXPO_PUBLIC_DOMAIN is set
 *  - Returns http://localhost:8080/api (API_BASE) and http://localhost:8080
 *    (API_ORIGIN) on native when neither env var is set
 *  - Returns "" for both exports on web when neither env var is set
 *
 * Because API_BASE and API_ORIGIN are module-level constants evaluated at
 * import time, each scenario uses jest.isolateModules() so the module is
 * freshly loaded with the right env-var + Platform.OS combination.
 */

type ApiBaseModule = { API_BASE: string; API_ORIGIN: string };
type PlatformOS = "ios" | "android" | "web";

/**
 * Load apiBase in a fresh module registry with controlled env vars and
 * Platform.OS.  The react-native moduleNameMapper resolves to the shared
 * __mocks__/react-native.js object, which we mutate before requiring apiBase
 * so that the constant evaluation sees the right Platform.OS value.
 */
function loadApiBase(
  env: { EXPO_PUBLIC_API_BASE?: string; EXPO_PUBLIC_DOMAIN?: string },
  platformOS: PlatformOS,
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

    result = require("../utils/apiBase") as ApiBaseModule;

    rn.Platform.OS = originalOS;

    process.env.EXPO_PUBLIC_API_BASE = savedBase;
    process.env.EXPO_PUBLIC_DOMAIN = savedDomain;
    if (savedBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE;
    if (savedDomain === undefined) delete process.env.EXPO_PUBLIC_DOMAIN;
  });

  return result;
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

  it("returns http://localhost:8080/api on iOS when neither env var is set", () => {
    const { API_BASE } = loadApiBase({}, "ios");
    expect(API_BASE).toBe("http://localhost:8080/api");
  });

  it("returns http://localhost:8080/api on android when neither env var is set", () => {
    const { API_BASE } = loadApiBase({}, "android");
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

  it("returns http://localhost:8080 on native when neither env var is set", () => {
    const { API_ORIGIN } = loadApiBase({}, "ios");
    expect(API_ORIGIN).toBe("http://localhost:8080");
  });

  it('returns "" on web when neither env var is set', () => {
    const { API_ORIGIN } = loadApiBase({}, "web");
    expect(API_ORIGIN).toBe("");
  });
});
