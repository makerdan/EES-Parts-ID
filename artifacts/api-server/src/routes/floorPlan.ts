/**
 * Floor Plan routes:
 *   GET  /api/floor-plan/meta    — public, returns { hash, updatedAt } or 404
 *   GET  /api/floor-plan/svg     — public, streams the stored SVG bytes or 404
 *   POST /api/admin/floor-plan   — admin-only, accepts { svg: string }, uploads to GCS
 */

import { Router } from "express";
import crypto from "node:crypto";
import { db } from "@workspace/db";
import { floorPlanMetaTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import { verifyAdminToken } from "./admin";
import { uploadFloorPlanSvg, readFloorPlanSvg } from "../lib/objectStorage";

const router = Router();

const MAX_SVG_BYTES = 10 * 1024 * 1024; // 10 MB

function requireAdminAuth(
  req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction,
): void {
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    res.status(503).json({ error: "Admin access is not configured. Set ADMIN_PASSWORD." });
    return;
  }
  const authHeader = req.headers["authorization"] ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token || !verifyAdminToken(token, adminPassword)) {
    res.status(401).json({ error: "Unauthorized: valid admin token required" });
    return;
  }
  next();
}

async function getLatestMeta() {
  const rows = await db
    .select()
    .from(floorPlanMetaTable)
    .orderBy(desc(floorPlanMetaTable.uploadedAt))
    .limit(1);
  return rows[0] ?? null;
}

// ── GET /floor-plan/meta ──────────────────────────────────────────────────────
router.get("/floor-plan/meta", async (_req, res) => {
  try {
    const meta = await getLatestMeta();
    if (!meta) {
      res.status(404).json({ error: "No floor plan uploaded yet" });
      return;
    }
    res.json({ hash: meta.hash, updatedAt: meta.uploadedAt });
  } catch {
    res.status(500).json({ error: "Failed to fetch floor plan metadata" });
  }
});

// ── GET /floor-plan/svg ───────────────────────────────────────────────────────
router.get("/floor-plan/svg", async (_req, res) => {
  try {
    const meta = await getLatestMeta();
    if (!meta) {
      res.status(404).json({ error: "No floor plan uploaded yet" });
      return;
    }
    const svgBuffer = await readFloorPlanSvg(meta.objectPath);
    res.set("Content-Type", "image/svg+xml");
    res.set("Cache-Control", "public, max-age=3600");
    res.send(svgBuffer);
  } catch {
    res.status(500).json({ error: "Failed to fetch floor plan SVG" });
  }
});

// ── POST /admin/floor-plan ────────────────────────────────────────────────────
router.post("/admin/floor-plan", requireAdminAuth, async (req, res) => {
  try {
    const contentLength = Number(req.headers["content-length"] ?? 0);
    if (contentLength > MAX_SVG_BYTES) {
      res.status(413).json({ error: "SVG too large (limit 10 MB)" });
      return;
    }

    const { svg } = req.body as { svg?: string };
    if (!svg || typeof svg !== "string" || !svg.trim()) {
      res.status(400).json({ error: "Missing svg field" });
      return;
    }
    if (!svg.includes("<svg")) {
      res.status(400).json({ error: "Body does not appear to be valid SVG (no <svg> element found)" });
      return;
    }

    const hash = crypto.createHash("sha256").update(svg).digest("hex");
    const objectPath = await uploadFloorPlanSvg(svg);

    await db.insert(floorPlanMetaTable).values({ objectPath, hash });

    res.json({ hash, objectPath });
  } catch (err) {
    console.error("[floor-plan] upload error:", err);
    res.status(500).json({ error: "Failed to upload floor plan" });
  }
});

export default router;
