import { db } from "@workspace/db";
import {
  aiRequestLogTable,
  catalogPdfJobTable,
  contactMessagesTable,
  inventoryTable,
  screenViewLogTable,
} from "@workspace/db";
import { and, count, eq, gte, lt, sql } from "drizzle-orm";
import { Router } from "express";

import { logger } from "../lib/logger";
import { getScreenViewKeyMaterial } from "../lib/screenViewPrivacy";
import {
  getSupportAnalyticsWindow,
  privacySafeCount,
  SUPPORT_ANALYTICS_MAX_DAILY_ROWS,
  SUPPORT_ANALYTICS_MAX_FEATURE_ROWS,
  SUPPORT_ANALYTICS_MAX_SCREEN_ROWS,
  SUPPORT_ANALYTICS_MIN_CELL_COUNT,
} from "../lib/supportAnalyticsReport";
import { requireAdminAuth } from "../middlewares/requireAdminAuth";

const router = Router();

// GET /admin/dashboard-stats — returns aggregated analytics for the admin dashboard.
router.get("/dashboard-stats", requireAdminAuth, async (_req, res) => {
  try {
    const now = new Date();
    const reportingWindow = getSupportAnalyticsWindow(now);
    const windowWhere = and(
      gte(aiRequestLogTable.createdAt, reportingWindow.start),
      lt(aiRequestLogTable.createdAt, reportingWindow.end),
    );
    const screenWindowWhere = and(
      gte(screenViewLogTable.createdAt, reportingWindow.start),
      lt(screenViewLogTable.createdAt, reportingWindow.end),
    );

    const [
      aiTotalRows,
      aiByFeatureRows,
      screenTotalRows,
      screenUniqueRows,
      screenByNameRows,
      screenDailyRows,
      inventoryCountRows,
      catalogJobsRows,
      contactCountRows,
    ] = await Promise.all([
      db
        .select({ total: count() })
        .from(aiRequestLogTable)
        .where(windowWhere),
      db
        .select({ feature: aiRequestLogTable.feature, total: count() })
        .from(aiRequestLogTable)
        .where(windowWhere)
        .groupBy(aiRequestLogTable.feature)
        .limit(SUPPORT_ANALYTICS_MAX_FEATURE_ROWS),
      db
        .select({ total: count() })
        .from(screenViewLogTable)
        .where(screenWindowWhere),
      db
        .select({ cnt: sql<string>`COUNT(DISTINCT ${screenViewLogTable.visitorHash})` })
        .from(screenViewLogTable)
        .where(and(screenWindowWhere, sql`${screenViewLogTable.visitorHash} IS NOT NULL`)),
      db
        .select({ screenName: screenViewLogTable.screenName, total: count() })
        .from(screenViewLogTable)
        .where(screenWindowWhere)
        .groupBy(screenViewLogTable.screenName)
        .orderBy(sql`count(*) DESC`)
        .having(sql`count(*) >= ${SUPPORT_ANALYTICS_MIN_CELL_COUNT}`)
        .limit(SUPPORT_ANALYTICS_MAX_SCREEN_ROWS),
      db
        .select({
          date: sql<string>`DATE(${screenViewLogTable.createdAt} AT TIME ZONE 'UTC')`,
          total: count(),
        })
        .from(screenViewLogTable)
        .where(screenWindowWhere)
        .groupBy(sql`DATE(${screenViewLogTable.createdAt} AT TIME ZONE 'UTC')`)
        .having(sql`count(*) >= ${SUPPORT_ANALYTICS_MIN_CELL_COUNT}`)
        .orderBy(sql`DATE(${screenViewLogTable.createdAt} AT TIME ZONE 'UTC') ASC`)
        .limit(SUPPORT_ANALYTICS_MAX_DAILY_ROWS),
      db.select({ total: count() }).from(inventoryTable),
      db
        .select({ total: count() })
        .from(catalogPdfJobTable)
        .where(eq(catalogPdfJobTable.status, "done")),
      db.select({ total: count() }).from(contactMessagesTable),
    ]);

    const aiTotal = Number(aiTotalRows[0]?.total ?? 0);
    const screenTotal = Number(screenTotalRows[0]?.total ?? 0);
    const uniqueVisitors = Number(screenUniqueRows[0]?.cnt ?? 0);
    const uniqueVisitorsAvailable = getScreenViewKeyMaterial() !== null;

    res.json({
      generatedAt: now.toISOString(),
      window: {
        start: reportingWindow.start.toISOString(),
        end: reportingWindow.end.toISOString(),
        days: reportingWindow.days,
      },
      timezone: reportingWindow.timezone,
      privacy: {
        minimumCellCount: SUPPORT_ANALYTICS_MIN_CELL_COUNT,
        suppressedValue: "Suppressed",
        uniqueVisitorsAvailable,
        aggregateOnly: true,
      },
      ai: {
        requestsInWindow: privacySafeCount(aiTotal),
        byFeature: aiByFeatureRows.map((row) => ({
          feature: row.feature,
          total: privacySafeCount(Number(row.total)),
        })),
      },
      screenViews: {
        viewsInWindow: privacySafeCount(screenTotal),
        uniqueVisitorsInWindow: uniqueVisitorsAvailable ? privacySafeCount(uniqueVisitors) : null,
        byScreen: screenByNameRows.map((row) => ({
          screenName: row.screenName,
          total: Number(row.total),
        })),
        dailyInWindow: screenDailyRows
          .slice(0, SUPPORT_ANALYTICS_MAX_DAILY_ROWS)
          .map((row) => ({ date: row.date, total: Number(row.total) })),
      },
      summary: {
        inventoryItems: inventoryCountRows[0]?.total ?? 0,
        catalogJobsDone: catalogJobsRows[0]?.total ?? 0,
        contactMessages: contactCountRows[0]?.total ?? 0,
      },
    });
  } catch (err) {
    logger.error({ err }, "admin.dashboard-stats failed");
    res.status(500).json({ error: "Failed to load dashboard stats" });
  }
});

export default router;
