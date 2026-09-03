export const SUPPORT_ANALYTICS_WINDOW_DAYS = 30;
export const SUPPORT_ANALYTICS_TIMEZONE = "UTC";
export const SUPPORT_ANALYTICS_MIN_CELL_COUNT = 5;
export const SUPPORT_ANALYTICS_MAX_SCREEN_ROWS = 20;
export const SUPPORT_ANALYTICS_MAX_FEATURE_ROWS = 20;
export const SUPPORT_ANALYTICS_MAX_DAILY_ROWS = 31;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SupportAnalyticsWindow {
  start: Date;
  end: Date;
  days: number;
  timezone: typeof SUPPORT_ANALYTICS_TIMEZONE;
}

/**
 * One shared reporting window for every telemetry metric. Calendar boundaries
 * are calculated in UTC so the label and SQL grouping mean the same thing for
 * every admin and every server instance.
 */
export function getSupportAnalyticsWindow(now = new Date()): SupportAnalyticsWindow {
  const endMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return {
    start: new Date(endMs - SUPPORT_ANALYTICS_WINDOW_DAYS * DAY_MS),
    end: new Date(endMs),
    days: SUPPORT_ANALYTICS_WINDOW_DAYS,
    timezone: SUPPORT_ANALYTICS_TIMEZONE,
  };
}

export function privacySafeCount(count: number): number | null {
  return count >= SUPPORT_ANALYTICS_MIN_CELL_COUNT ? count : null;
}