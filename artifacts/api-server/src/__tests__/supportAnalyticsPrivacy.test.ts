import {
  deriveRotatingVisitorHash,
  getScreenViewKeyMaterial,
  getScreenViewRateLimitKey,
} from "../lib/screenViewPrivacy";
import {
  screenViewRetentionCutoff,
  SCREEN_VIEW_RETENTION_DAYS,
} from "../lib/screenViewRetention";
import {
  getSupportAnalyticsWindow,
  privacySafeCount,
  SUPPORT_ANALYTICS_TIMEZONE,
  SUPPORT_ANALYTICS_WINDOW_DAYS,
  SUPPORT_ANALYTICS_MIN_CELL_COUNT,
} from "../lib/supportAnalyticsReport";

describe("support analytics privacy primitives", () => {
  const originalSessionSecret = process.env.SESSION_SECRET;
  const originalClerkSecret = process.env.CLERK_SECRET_KEY;

  afterEach(() => {
    if (originalSessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = originalSessionSecret;
    if (originalClerkSecret === undefined) delete process.env.CLERK_SECRET_KEY;
    else process.env.CLERK_SECRET_KEY = originalClerkSecret;
  });

  it("uses domain-separated keyed material and rotates visitor grouping daily", () => {
    process.env.SESSION_SECRET = "test-server-held-session-secret";
    delete process.env.CLERK_SECRET_KEY;
    const day = Date.UTC(2026, 0, 2, 12);

    const first = deriveRotatingVisitorHash("203.0.113.10", day);
    const sameDay = deriveRotatingVisitorHash("203.0.113.10", day + 60_000);
    const nextDay = deriveRotatingVisitorHash("203.0.113.10", day + 24 * 60 * 60 * 1000);

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(sameDay).toBe(first);
    expect(nextDay).not.toBe(first);
    expect(first).not.toContain("203.0.113.10");
  });

  it("disables unique grouping without configured server-held material", () => {
    delete process.env.SESSION_SECRET;
    delete process.env.CLERK_SECRET_KEY;

    expect(getScreenViewKeyMaterial()).toBeNull();
    expect(deriveRotatingVisitorHash("203.0.113.10")).toBeNull();
    expect(getScreenViewRateLimitKey("203.0.113.10")).toBe("privacy-disabled");
  });

  it("uses one UTC calendar window and suppresses small cells", () => {
    const window = getSupportAnalyticsWindow(new Date("2026-09-01T23:30:00.000Z"));

    expect(window.timezone).toBe(SUPPORT_ANALYTICS_TIMEZONE);
    expect(window.days).toBe(SUPPORT_ANALYTICS_WINDOW_DAYS);
    expect(window.start.toISOString()).toBe("2026-08-03T00:00:00.000Z");
    expect(window.end.toISOString()).toBe("2026-09-02T00:00:00.000Z");
    expect(privacySafeCount(SUPPORT_ANALYTICS_MIN_CELL_COUNT - 1)).toBeNull();
    expect(privacySafeCount(SUPPORT_ANALYTICS_MIN_CELL_COUNT)).toBe(
      SUPPORT_ANALYTICS_MIN_CELL_COUNT,
    );
  });

  it("has a durable retention cutoff independent of incoming writes", () => {
    const now = Date.parse("2026-09-01T12:00:00.000Z");
    expect(screenViewRetentionCutoff(now).toISOString()).toBe(
      "2026-08-02T12:00:00.000Z",
    );
    expect(SCREEN_VIEW_RETENTION_DAYS).toBe(30);
  });
});