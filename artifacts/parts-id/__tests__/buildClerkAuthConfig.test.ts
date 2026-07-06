/**
 * @jest-environment node
 *
 * Guards the production Clerk auth config baked into the static build.
 *
 * Background: production once shipped a blank web app because the build ran
 * with a live Clerk key (pk_live_…) but an empty EXPO_PUBLIC_CLERK_PROXY_URL.
 * ClerkLoaded never resolved, so nothing rendered — and no test caught it.
 *
 * Two units in scripts/build.js protect against a regression:
 *   - resolveClerkProxyUrl(domain): derives the proxy URL that gets baked in.
 *   - getClerkAuthConfigError(key, proxyUrl): the build-time assertion that
 *     fails the build when a live key ships without a proxy URL.
 *
 * These tests exercise both, plus the interaction that matters: whatever
 * resolveClerkProxyUrl produces for a live key must satisfy the assertion.
 */

const {
  resolveClerkProxyUrl,
  getClerkAuthConfigError,
} = require("../scripts/build.js") as {
  resolveClerkProxyUrl: (domain: string) => string;
  getClerkAuthConfigError: (
    publishableKey: string | undefined,
    proxyUrl: string | undefined,
  ) => string | null;
};

const CLERK_ENV_KEYS = [
  "EXPO_PUBLIC_CLERK_PROXY_URL",
  "CLERK_PUBLISHABLE_KEY",
  "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY",
] as const;

const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of CLERK_ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of CLERK_ENV_KEYS) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
});

describe("resolveClerkProxyUrl", () => {
  it("derives https://<domain>/api/__clerk for a live key", () => {
    process.env.CLERK_PUBLISHABLE_KEY = "pk_live_abc123";
    expect(resolveClerkProxyUrl("app.example.com")).toBe(
      "https://app.example.com/api/__clerk",
    );
  });

  it("derives from EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY when CLERK_PUBLISHABLE_KEY is absent", () => {
    process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_live_xyz789";
    expect(resolveClerkProxyUrl("app.example.com")).toBe(
      "https://app.example.com/api/__clerk",
    );
  });

  it("strips protocol and path from the domain before deriving", () => {
    process.env.CLERK_PUBLISHABLE_KEY = "pk_live_abc123";
    expect(resolveClerkProxyUrl("https://app.example.com/some/path")).toBe(
      "https://app.example.com/api/__clerk",
    );
  });

  it("returns empty string for a test key", () => {
    process.env.CLERK_PUBLISHABLE_KEY = "pk_test_abc123";
    expect(resolveClerkProxyUrl("app.example.com")).toBe("");
  });

  it("returns empty string when no key is set", () => {
    expect(resolveClerkProxyUrl("app.example.com")).toBe("");
  });

  it("returns empty string for a live key when the domain is missing", () => {
    process.env.CLERK_PUBLISHABLE_KEY = "pk_live_abc123";
    expect(resolveClerkProxyUrl("")).toBe("");
  });

  it("preserves an explicit EXPO_PUBLIC_CLERK_PROXY_URL over derivation", () => {
    process.env.CLERK_PUBLISHABLE_KEY = "pk_live_abc123";
    process.env.EXPO_PUBLIC_CLERK_PROXY_URL = "https://custom.example.com/clerk";
    expect(resolveClerkProxyUrl("app.example.com")).toBe(
      "https://custom.example.com/clerk",
    );
  });

  it("preserves an explicit proxy URL even for a test key", () => {
    process.env.CLERK_PUBLISHABLE_KEY = "pk_test_abc123";
    process.env.EXPO_PUBLIC_CLERK_PROXY_URL = "https://custom.example.com/clerk";
    expect(resolveClerkProxyUrl("app.example.com")).toBe(
      "https://custom.example.com/clerk",
    );
  });
});

describe("getClerkAuthConfigError", () => {
  it("fails when a live key has an empty proxy URL", () => {
    const error = getClerkAuthConfigError("pk_live_abc123", "");
    expect(error).toContain("[Build Guard]");
    expect(error).toContain("blank screen");
  });

  it("fails when a live key has an undefined proxy URL", () => {
    expect(getClerkAuthConfigError("pk_live_abc123", undefined)).not.toBeNull();
  });

  it("passes when a live key has a non-empty proxy URL", () => {
    expect(
      getClerkAuthConfigError(
        "pk_live_abc123",
        "https://app.example.com/api/__clerk",
      ),
    ).toBeNull();
  });

  it("passes for a test key with no proxy URL", () => {
    expect(getClerkAuthConfigError("pk_test_abc123", "")).toBeNull();
  });

  it("fails when the publishable key is an empty string", () => {
    const error = getClerkAuthConfigError("", "");
    expect(error).toContain("[Build Guard]");
    expect(error).toContain("blank screen");
  });

  it("fails when the publishable key is undefined", () => {
    const error = getClerkAuthConfigError(undefined, undefined);
    expect(error).toContain("[Build Guard]");
    expect(error).toContain("blank screen");
  });

  it("passes for a valid test key with no proxy URL", () => {
    expect(getClerkAuthConfigError("pk_test_abc123", "")).toBeNull();
  });

  it("passes for a valid live key with a proxy URL", () => {
    expect(
      getClerkAuthConfigError(
        "pk_live_abc123",
        "https://app.example.com/api/__clerk",
      ),
    ).toBeNull();
  });

  it("fails when the key is a placeholder string", () => {
    const error = getClerkAuthConfigError("YOUR_KEY_HERE", "");
    expect(error).toContain("[Build Guard]");
    expect(error).toContain("blank screen");
  });

  it("fails when the key looks like a copy-paste typo (no valid prefix)", () => {
    const error = getClerkAuthConfigError("pk_staging_abc123", "");
    expect(error).toContain("[Build Guard]");
    expect(error).toContain("blank screen");
  });

  it("fails when the key is a generic non-Clerk string", () => {
    const error = getClerkAuthConfigError("some-random-string", "");
    expect(error).toContain("[Build Guard]");
    expect(error).toContain("blank screen");
  });

  it("fails when the key starts with pk_ but is not pk_test_ or pk_live_", () => {
    const error = getClerkAuthConfigError("pk_dev_abc123", "");
    expect(error).toContain("[Build Guard]");
    expect(error).toContain("blank screen");
  });

  it("malformed key error message mentions the valid key formats", () => {
    const error = getClerkAuthConfigError("YOUR_KEY_HERE", "");
    expect(error).toContain("pk_test_");
    expect(error).toContain("pk_live_");
  });
});

describe("resolveClerkProxyUrl + getClerkAuthConfigError (baked-in config)", () => {
  it("a live key with a valid domain always yields a config the guard accepts", () => {
    process.env.CLERK_PUBLISHABLE_KEY = "pk_live_abc123";
    const proxyUrl = resolveClerkProxyUrl("app.example.com");
    expect(
      getClerkAuthConfigError(process.env.CLERK_PUBLISHABLE_KEY, proxyUrl),
    ).toBeNull();
  });

  it("a live key with a missing domain produces a config the guard rejects", () => {
    process.env.CLERK_PUBLISHABLE_KEY = "pk_live_abc123";
    const proxyUrl = resolveClerkProxyUrl("");
    expect(
      getClerkAuthConfigError(process.env.CLERK_PUBLISHABLE_KEY, proxyUrl),
    ).not.toBeNull();
  });
});
