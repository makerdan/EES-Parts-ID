/**
 * @jest-environment node
 *
 * Unit tests for verifyNativeBundleDomain() in scripts/build.js.
 *
 * Background: the post-build bundle scan previously only covered the web bundle
 * under static-build/web/. Native bundles (iOS/Android) downloaded by Metro
 * were not checked, so a stale *.replit.dev URL could silently ship in a
 * native build. verifyNativeBundleDomain() closes that gap by scanning both
 * platform bundles with the same logic as verifyBundleDomain().
 *
 * These tests write fixtures into artifacts/parts-id/static-build/ under
 * uniquely named timestamps so they never conflict with real build artefacts,
 * and clean up afterwards — no filesystem mocking is used.
 */
import * as fs from "fs";
import * as path from "path";

const { verifyNativeBundleDomain } = require("../scripts/build.js") as {
  verifyNativeBundleDomain: (domain: string, timestamp: string) => void;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Lay out the directory structure that verifyNativeBundleDomain() expects:
 *   <root>/static-build/<timestamp>/_expo/static/js/<platform>/bundle.js
 *
 * Returns the project root and timestamp so callers can drive the function.
 */
function scaffoldBundles(
  root: string,
  timestamp: string,
  contents: { ios: string; android: string },
): void {
  for (const platform of ["ios", "android"] as const) {
    const dir = path.join(
      root,
      "static-build",
      timestamp,
      "_expo",
      "static",
      "js",
      platform,
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "bundle.js"), contents[platform]);
  }
}

// ---------------------------------------------------------------------------
// Override projectRoot inside build.js
// ---------------------------------------------------------------------------
// build.js derives its staticBuild path from its own projectRoot (the
// artifacts/parts-id directory). We cannot change that at runtime. Instead,
// the tests create bundles inside the real project tree under a uniquely named
// timestamp so they never conflict with real build artefacts, and clean up
// afterwards.

const PARTS_ID_ROOT = path.resolve(__dirname, "..");

function scaffoldInProject(
  timestamp: string,
  contents: { ios: string; android: string },
): void {
  scaffoldBundles(PARTS_ID_ROOT, timestamp, contents);
}

function cleanupInProject(timestamp: string): void {
  const dir = path.join(PARTS_ID_ROOT, "static-build", timestamp);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Use a unique prefix so tests are identifiable.
function makeTimestamp(suffix: string): string {
  return `test-native-domain-${suffix}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("verifyNativeBundleDomain", () => {
  const PROD_DOMAIN = "my-app.replit.app";
  const DEV_DOMAIN = "abc123.replit.dev";

  it("passes when both bundles contain the production domain and no .replit.dev URL", () => {
    const ts = makeTimestamp("passes");
    scaffoldInProject(ts, {
      ios: `var API="https://${PROD_DOMAIN}/api";`,
      android: `var API="https://${PROD_DOMAIN}/api";`,
    });
    try {
      expect(() => verifyNativeBundleDomain(PROD_DOMAIN, ts)).not.toThrow();
    } finally {
      cleanupInProject(ts);
    }
  });

  it("throws when the iOS bundle contains a .replit.dev URL", () => {
    const ts = makeTimestamp("ios-dev");
    scaffoldInProject(ts, {
      ios: `var API="https://${DEV_DOMAIN}/api";`,
      android: `var API="https://${PROD_DOMAIN}/api";`,
    });
    try {
      expect(() => verifyNativeBundleDomain(PROD_DOMAIN, ts)).toThrow(
        /Dev domain found in native bundle/,
      );
    } finally {
      cleanupInProject(ts);
    }
  });

  it("throws when the Android bundle contains a .replit.dev URL", () => {
    const ts = makeTimestamp("android-dev");
    scaffoldInProject(ts, {
      ios: `var API="https://${PROD_DOMAIN}/api";`,
      android: `var API="https://${DEV_DOMAIN}/api";`,
    });
    try {
      expect(() => verifyNativeBundleDomain(PROD_DOMAIN, ts)).toThrow(
        /Dev domain found in native bundle/,
      );
    } finally {
      cleanupInProject(ts);
    }
  });

  it("throws when both bundles contain a .replit.dev URL", () => {
    const ts = makeTimestamp("both-dev");
    scaffoldInProject(ts, {
      ios: `var API="https://${DEV_DOMAIN}/api";`,
      android: `var API="https://${DEV_DOMAIN}/api";`,
    });
    try {
      expect(() => verifyNativeBundleDomain(PROD_DOMAIN, ts)).toThrow(
        /Dev domain found in native bundle/,
      );
    } finally {
      cleanupInProject(ts);
    }
  });

  it("includes the platform and matched domain in the error message", () => {
    const ts = makeTimestamp("error-detail");
    scaffoldInProject(ts, {
      ios: `var A="https://${DEV_DOMAIN}/api";`,
      android: `var B="https://${PROD_DOMAIN}/api";`,
    });
    try {
      let err: Error | null = null;
      try {
        verifyNativeBundleDomain(PROD_DOMAIN, ts);
      } catch (e) {
        err = e as Error;
      }
      expect(err).not.toBeNull();
      expect(err!.message).toContain("ios/bundle.js");
      expect(err!.message).toContain(DEV_DOMAIN);
    } finally {
      cleanupInProject(ts);
    }
  });

  it("throws when the expected domain is not found in either bundle", () => {
    const ts = makeTimestamp("missing-domain");
    scaffoldInProject(ts, {
      ios: `var API="https://other-domain.example.com/api";`,
      android: `var API="https://other-domain.example.com/api";`,
    });
    try {
      expect(() => verifyNativeBundleDomain(PROD_DOMAIN, ts)).toThrow(
        /Expected domain not found in native bundles/,
      );
    } finally {
      cleanupInProject(ts);
    }
  });

  it("passes when the domain appears only in the iOS bundle (not both)", () => {
    const ts = makeTimestamp("domain-ios-only");
    scaffoldInProject(ts, {
      ios: `var API="https://${PROD_DOMAIN}/api";`,
      android: `var OTHER="https://other.example.com/api";`,
    });
    try {
      expect(() => verifyNativeBundleDomain(PROD_DOMAIN, ts)).not.toThrow();
    } finally {
      cleanupInProject(ts);
    }
  });

  it("passes when the domain appears only in the Android bundle (not both)", () => {
    const ts = makeTimestamp("domain-android-only");
    scaffoldInProject(ts, {
      ios: `var OTHER="https://other.example.com/api";`,
      android: `var API="https://${PROD_DOMAIN}/api";`,
    });
    try {
      expect(() => verifyNativeBundleDomain(PROD_DOMAIN, ts)).not.toThrow();
    } finally {
      cleanupInProject(ts);
    }
  });

  it("skips a missing bundle file with a warning rather than crashing", () => {
    const ts = makeTimestamp("missing-ios");
    // Only scaffold Android; omit iOS bundle directory entirely.
    const dir = path.join(
      PARTS_ID_ROOT,
      "static-build",
      ts,
      "_expo",
      "static",
      "js",
      "android",
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "bundle.js"),
      `var API="https://${PROD_DOMAIN}/api";`,
    );
    try {
      expect(() => verifyNativeBundleDomain(PROD_DOMAIN, ts)).not.toThrow();
    } finally {
      cleanupInProject(ts);
    }
  });

  it("error message includes the [Build Guard] prefix", () => {
    const ts = makeTimestamp("prefix");
    scaffoldInProject(ts, {
      ios: `var API="https://${DEV_DOMAIN}/api";`,
      android: `var API="https://${PROD_DOMAIN}/api";`,
    });
    try {
      let err: Error | null = null;
      try {
        verifyNativeBundleDomain(PROD_DOMAIN, ts);
      } catch (e) {
        err = e as Error;
      }
      expect(err!.message).toContain("[Build Guard]");
    } finally {
      cleanupInProject(ts);
    }
  });
});
