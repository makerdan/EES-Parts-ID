import { Router, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import {
  aiRequestLogTable,
  screenViewLogTable,
  inventoryTable,
  catalogPdfJobTable,
  contactMessagesTable,
} from "@workspace/db";
import { sql, count, eq } from "drizzle-orm";
import { verifyAdminToken } from "./admin";
import { logger } from "../lib/logger";

const router = Router();

// Auth gate: ADMIN_PASSWORD-based HMAC token system.
// No ADMIN_USER_ID env var is needed — this app uses a shared token, not per-user identities.
// Fails closed (503) when ADMIN_PASSWORD is not configured so an empty-secret forgery is impossible.
function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.ADMIN_PASSWORD;
  if (!secret) {
    res.status(503).json({ error: "Admin access is not configured on this server. Set ADMIN_PASSWORD." });
    return;
  }
  const auth = req.headers["authorization"] ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || !verifyAdminToken(token, secret)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
}

// GET /admin/dashboard-stats — returns aggregated analytics for the admin dashboard.
router.get("/dashboard-stats", requireAdminAuth, async (_req, res) => {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [
      aiTotalRows,
      aiMonthRows,
      aiByFeatureRows,
      screenTotalRows,
      screenTodayUniqueRows,
      screenByNameRows,
      screenDailyRows,
      inventoryCountRows,
      catalogJobsRows,
      contactCountRows,
    ] = await Promise.all([
      db.select({ total: count() }).from(aiRequestLogTable),
      db
        .select({ total: count() })
        .from(aiRequestLogTable)
        .where(sql`${aiRequestLogTable.createdAt} >= ${startOfMonth}`),
      db
        .select({ feature: aiRequestLogTable.feature, total: count() })
        .from(aiRequestLogTable)
        .groupBy(aiRequestLogTable.feature),
      db.select({ total: count() }).from(screenViewLogTable),
      db
        .select({ cnt: sql<string>`COUNT(DISTINCT ${screenViewLogTable.visitorHash})` })
        .from(screenViewLogTable)
        .where(sql`${screenViewLogTable.createdAt} >= ${startOfToday}`),
      db
        .select({ screenName: screenViewLogTable.screenName, total: count() })
        .from(screenViewLogTable)
        .groupBy(screenViewLogTable.screenName)
        .orderBy(sql`count(*) DESC`)
        .limit(20),
      db
        .select({
          date: sql<string>`DATE(${screenViewLogTable.createdAt} AT TIME ZONE 'UTC')`,
          total: count(),
        })
        .from(screenViewLogTable)
        .where(sql`${screenViewLogTable.createdAt} >= ${thirtyDaysAgo}`)
        .groupBy(sql`DATE(${screenViewLogTable.createdAt} AT TIME ZONE 'UTC')`)
        .orderBy(sql`DATE(${screenViewLogTable.createdAt} AT TIME ZONE 'UTC') ASC`),
      db.select({ total: count() }).from(inventoryTable),
      db
        .select({ total: count() })
        .from(catalogPdfJobTable)
        .where(eq(catalogPdfJobTable.status, "done")),
      db.select({ total: count() }).from(contactMessagesTable),
    ]);

    res.json({
      ai: {
        totalAllTime: aiTotalRows[0]?.total ?? 0,
        totalThisMonth: aiMonthRows[0]?.total ?? 0,
        byFeature: aiByFeatureRows,
      },
      screenViews: {
        totalAllTime: screenTotalRows[0]?.total ?? 0,
        uniqueVisitorsToday: Number(screenTodayUniqueRows[0]?.cnt ?? 0),
        byScreen: screenByNameRows,
        dailyLast30Days: screenDailyRows,
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
