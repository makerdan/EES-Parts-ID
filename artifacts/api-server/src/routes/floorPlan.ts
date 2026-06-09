/**
 * Floor Plan routes:
 *   GET  /api/floor-plan/meta              — public, returns { hash, updatedAt } or 404
 *   GET  /api/floor-plan/svg               — public, streams the stored SVG bytes or 404
 *   GET  /api/floor-plan/tiles/:z/:x/:y.png — public, returns a PNG tile (cached to disk)
 *   POST /api/floor-plan/tiles/warmup      — public, async-generates z0–z2 tiles (202)
 *   POST /api/admin/floor-plan             — admin-only, accepts { svg: string }, uploads to GCS
 */

import { Router } from "express";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { db } from "@workspace/db";
import { floorPlanMetaTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import { verifyAdminToken } from "./admin";
import { uploadFloorPlanSvg, readFloorPlanSvg } from "../lib/objectStorage";

const router = Router();

const MAX_SVG_BYTES = 10 * 1024 * 1024; // 10 MB

// ── Tile pyramid constants ────────────────────────────────────────────────────

/** Width of each PNG tile in pixels.  Height is derived from the SVG aspect ratio. */
const TILE_PX = 512;

/** SVG viewBox aspect ratio (width / height).  Must match the floor-plan SVG. */
const SVG_ASPECT = 7329.6001 / 4997.2798;

/** Directory for on-disk tile cache.  Tiles are keyed by {svgHash}_{z}_{x}_{y}.png. */
const TILE_CACHE_DIR = path.join(os.tmpdir(), "floor-plan-tiles");

/** Number of zoom levels that are pre-warmed by the warmup endpoint (z0–z2). */
const WARMUP_MAX_Z = 2;

/** Number of discrete zoom levels (z0–z4). */
const MAX_Z = 4;

function tileGridSize(z: number): number {
  return Math.pow(2, z);
}

function tileCachePath(svgHash: string, z: number, x: number, y: number): string {
  return path.join(TILE_CACHE_DIR, `${svgHash}_${z}_${x}_${y}.png`);
}

/**
 * Rasterize and return the PNG bytes for tile (z, x, y) of the given SVG.
 * Results are cached to disk keyed by svgHash so repeated requests hit disk
 * rather than re-rasterising.
 */
async function generateTile(
  svgBuffer: Buffer,
  svgHash: string,
  z: number,
  x: number,
  y: number,
): Promise<Buffer> {
  const cachePath = tileCachePath(svgHash, z, x, y);

  try {
    return await fs.readFile(cachePath);
  } catch {
    // Not cached — generate below.
  }

  const gridSize = tileGridSize(z);
  const totalW = TILE_PX * gridSize;
  const totalH = Math.round(totalW / SVG_ASPECT);
  const tileW = Math.round(totalW / gridSize);
  const tileH = Math.round(totalH / gridSize);

  await fs.mkdir(TILE_CACHE_DIR, { recursive: true });

  const pngBuffer = await sharp(svgBuffer)
    .resize(totalW, totalH, { fit: "fill" })
    .extract({ left: x * tileW, top: y * tileH, width: tileW, height: tileH })
    .png({ compressionLevel: 6 })
    .toBuffer();

  await fs.writeFile(cachePath, pngBuffer);
  return pngBuffer;
}

/**
 * Delete all disk-cached tiles for every SVG hash except `keepHash`.
 * Called when a new floor plan is uploaded so stale tiles don't linger.
 */
async function invalidateTileCache(keepHash?: string): Promise<void> {
  try {
    const files = await fs.readdir(TILE_CACHE_DIR);
    await Promise.all(
      files
        .filter((f) => !keepHash || !f.startsWith(keepHash))
        .map((f) => fs.unlink(path.join(TILE_CACHE_DIR, f)).catch(() => {})),
    );
  } catch {
    // Cache dir may not exist yet — non-fatal.
  }
}

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

// ── GET /floor-plan/tiles/:z/:x/:y.png ───────────────────────────────────────
// Serves a single PNG tile.  Tiles are cached to disk after first generation.
// z3 and z4 tiles are generated on first request (not pre-warmed) to avoid the
// large raster cost at startup.
router.get("/floor-plan/tiles/:z/:x/:y", async (req, res) => {
  try {
    const z = parseInt(req.params.z, 10);
    const x = parseInt(req.params.x, 10);
    // Strip .png extension from y if present (route param captures it)
    const yStr = req.params.y.replace(/\.png$/, "");
    const y = parseInt(yStr, 10);

    if (!isFinite(z) || !isFinite(x) || !isFinite(y) || z < 0 || z > MAX_Z) {
      res.status(400).json({ error: "Invalid tile coordinates" });
      return;
    }

    const gridSize = tileGridSize(z);
    if (x < 0 || x >= gridSize || y < 0 || y >= gridSize) {
      res.status(400).json({ error: "Tile coordinates out of range" });
      return;
    }

    const meta = await getLatestMeta();
    if (!meta) {
      res.status(404).json({ error: "No floor plan uploaded yet" });
      return;
    }

    const svgBuffer = await readFloorPlanSvg(meta.objectPath);
    const pngBuffer = await generateTile(svgBuffer, meta.hash, z, x, y);

    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "public, max-age=86400");
    res.send(pngBuffer);
  } catch (err) {
    console.error("[floor-plan/tiles] error:", err);
    res.status(500).json({ error: "Failed to generate tile" });
  }
});

// ── POST /floor-plan/tiles/warmup ─────────────────────────────────────────────
// Asynchronously generates all tiles for z0–z2 (21 tiles total) and returns
// 202 Accepted immediately.  z3 and z4 are generated on first request.
// The app calls this once on map mount so the first few zoom levels are
// instantly available on the device.
router.post("/floor-plan/tiles/warmup", async (_req, res) => {
  res.status(202).json({ message: "Tile warmup started" });

  // Run warmup asynchronously — do not await in the request handler.
  (async () => {
    try {
      const meta = await getLatestMeta();
      if (!meta) return;

      const svgBuffer = await readFloorPlanSvg(meta.objectPath);

      for (let z = 0; z <= WARMUP_MAX_Z; z++) {
        const gridSize = tileGridSize(z);
        for (let y = 0; y < gridSize; y++) {
          for (let x = 0; x < gridSize; x++) {
            try {
              await generateTile(svgBuffer, meta.hash, z, x, y);
            } catch (tileErr) {
              console.warn(`[warmup] tile ${z}/${x}/${y} failed:`, tileErr);
            }
          }
        }
      }
    } catch (err) {
      console.warn("[warmup] error:", err);
    }
  })();
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

    // Invalidate all disk-cached tiles from the previous SVG.
    // Keep tiles for the new hash (none yet) — they'll be generated on demand
    // or via the next warmup call.
    await invalidateTileCache(hash);

    res.json({ hash, objectPath });
  } catch (err) {
    console.error("[floor-plan] upload error:", err);
    res.status(500).json({ error: "Failed to upload floor plan" });
  }
});

export default router;
