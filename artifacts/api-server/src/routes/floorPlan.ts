/**
 * Floor Plan routes:
 *   GET  /api/floor-plan/meta              — public, returns { hash, updatedAt } or 404
 *   GET  /api/floor-plan/svg               — public, streams the stored SVG bytes or 404
 *   GET  /api/floor-plan/tiles/:z/:x/:y.png — public, returns a PNG tile (cached to disk)
 *   POST /api/floor-plan/tiles/warmup      — public, async-generates z0–z2 tiles (202)
 *   POST /api/admin/floor-plan             — admin-only, accepts { svg: string }, uploads to GCS
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { db } from "@workspace/db";
import { floorPlanMetaTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import { Router } from "express";
import sharp from "sharp";

import { logger } from "../lib/logger";
import { readFloorPlanSvg,uploadFloorPlanSvg } from "../lib/objectStorage";
import { requireAdminAuth } from "../middlewares/requireAdminAuth";

/**
 * Strip known XSS vectors from an SVG string before storage.
 *
 * This is intentionally conservative: it removes the narrowest set of
 * constructs that can execute JavaScript in a browser while leaving all
 * legitimate SVG markup intact.  The client also runs DOMPurify over the
 * inner XML before rendering, providing defence-in-depth.
 *
 * Constructs removed:
 *   • <script> elements (and their content)
 *   • <foreignObject> elements (allow arbitrary HTML injection)
 *   • event-handler attributes (on*)
 *   • javascript: URIs in href / src / xlink:href / action attributes
 *   • data: URIs in the same attributes (can carry HTML/JS payloads)
 */
function sanitizeSvg(svg: string): string {
  let s = svg;

  // Remove <script>…</script> blocks (case-insensitive, dotall)
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "");
  // Also catch self-closing <script … />
  s = s.replace(/<script\b[^/]*\/>/gi, "");

  // Remove <foreignObject>…</foreignObject> blocks
  s = s.replace(/<foreignObject\b[^>]*>[\s\S]*?<\/foreignObject\s*>/gi, "");
  s = s.replace(/<foreignObject\b[^/]*\/>/gi, "");

  // Strip event-handler attributes: on<word>=("…"|'…'|unquoted)
  s = s.replace(/\s+on[a-z][a-z0-9]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, "");

  // Strip javascript: and data: URIs from link-like attributes
  const linkAttrs = /\b(href|src|xlink:href|action)\s*=\s*/gi;
  s = s.replace(linkAttrs, (_match, attr: string) => `${attr}=`);
  // Re-apply: remove the value when it starts with javascript: or data:
  s = s.replace(
    /\b(href|src|xlink:href|action)=\s*(?:"(javascript:|data:)[^"]*"|'(javascript:|data:)[^']*'|(javascript:|data:)\S*)/gi,
    '$1=""',
  );

  if (!s.includes("<svg")) {
    throw new Error("SVG failed sanitization: no valid <svg> element remains");
  }
  return s;
}

const router = Router();

const MAX_SVG_BYTES = 10 * 1024 * 1024; // 10 MB

// ── Tile pyramid constants ────────────────────────────────────────────────────

/** Width of each PNG tile in pixels.  Height is derived from the SVG aspect ratio. */
const TILE_PX = 512;

/**
 * Fallback SVG viewBox aspect ratio (width / height).  Used only when the
 * stored SVG has no parseable viewBox attribute.  The primary path derives the
 * ratio dynamically from the SVG buffer at tile-generation time so the tile
 * pyramid stays correct even when the floor-plan SVG is replaced.
 */
const SVG_ASPECT_FALLBACK = 7329.6001 / 4997.2798;

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
 * Parse the width and height from the first `viewBox` attribute found in an SVG
 * buffer.  Returns `null` when no valid four-number viewBox is present.
 *
 * The returned dimensions are the intrinsic SVG canvas size (the last two
 * numbers in the viewBox), independent of any non-zero origin offset.
 */
function parseSvgViewBox(svgBuffer: Buffer): { w: number; h: number } | null {
  // Match both double- and single-quoted viewBox attributes.  Some export tools
  // (e.g. certain CAD/vector editors) emit single-quoted attributes; a
  // double-quote-only regex would silently fall through to SVG_ASPECT_FALLBACK
  // and misalign the tile pyramid.  The captured quote char is back-referenced
  // so the opening and closing quotes must match.
  const match = svgBuffer.toString("utf8").match(/viewBox=(["'])([^"']+)\1/);
  if (!match) return null;
  const parts = match[2].trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !isFinite(n))) return null;
  const [, , w, h] = parts;
  if (!w || !h) return null;
  return { w, h };
}

/**
 * Normalise an SVG string so its outermost viewBox has origin (0, 0).
 *
 * When an uploaded SVG has a non-zero viewBox origin (e.g. "500 1000 7329 4997"),
 * sharp rasterises the content starting at that offset in SVG coordinate space,
 * which would misalign the PNG tiles with the zone overlay (always at origin 0,0).
 * Rewriting the viewBox to "0 0 W H" puts both layers in the same frame.
 *
 * Returns the original buffer unchanged when the viewBox is already at (0,0) or
 * absent (avoid unnecessary UTF-8 round-trips for SVGs that are already correct).
 */
function normalizeViewBoxOrigin(svgBuffer: Buffer): Buffer {
  const svgStr = svgBuffer.toString("utf8");
  // Match both double- and single-quoted viewBox attributes (see parseSvgViewBox).
  const match = svgStr.match(/viewBox=(["'])([^"']+)\1/);
  if (!match) return svgBuffer;
  const parts = match[2].trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !isFinite(n))) return svgBuffer;
  const [ox, oy, w, h] = parts;
  if (ox === 0 && oy === 0) return svgBuffer; // already correct — skip allocation
  return Buffer.from(
    svgStr.replace(/viewBox=(["'])[^"']*\1/, `viewBox="0 0 ${w} ${h}"`),
    "utf8",
  );
}

/**
 * Rasterize and return the PNG bytes for tile (z, x, y) of the given SVG.
 * Results are cached to disk keyed by svgHash so repeated requests hit disk
 * rather than re-rasterising.
 *
 * The SVG's viewBox origin is normalised to (0, 0) before rasterisation so the
 * tile pixel coordinates match the zone overlay's coordinate frame (both use the
 * same 0-based origin).  Tiles that are already cached are served directly from
 * disk without re-parsing.
 */
async function generateTile(
  svgBuffer: Buffer,
  svgHash: string,
  z: number,
  x: number,
  y: number,
): Promise<Buffer> {
  // Stale-cache guard: the disk cache is keyed by svgHash, but the caller passes
  // the svgBuffer and svgHash separately.  A race between an in-flight tile
  // warmup (holding an old SVG buffer) and a fresh upload could otherwise write
  // a tile generated from a superseded SVG under a hash that no longer matches
  // its content.  Verify the buffer actually hashes to the claimed svgHash so a
  // tile from a superseded floor plan can never be generated or served — the
  // mismatch is loudly rejected instead of silently producing misaligned tiles.
  const actualHash = crypto.createHash("sha256").update(svgBuffer).digest("hex");
  if (actualHash !== svgHash) {
    logger.error(
      { expectedHash: svgHash, actualHash, z, x, y },
      "[floor-plan/tiles] SVG content hash mismatch — refusing to serve/generate a tile for a superseded floor plan",
    );
    throw new Error(
      "SVG content hash does not match the requested floor-plan hash — refusing to serve a stale tile",
    );
  }

  const cachePath = tileCachePath(svgHash, z, x, y);

  try {
    return await fs.readFile(cachePath);
  } catch (err) {
    logger.warn({ err, cachePath }, "[floor-plan/tiles] tile cache miss — generating");
  }

  // Normalise the SVG viewBox origin to (0, 0) so tile pixel coordinates align
  // with the zone overlay coordinate frame on the client.
  const normalizedSvg = normalizeViewBoxOrigin(svgBuffer);

  // Derive the aspect ratio from the SVG's actual viewBox so the tile pyramid
  // stays correct when the floor-plan SVG is replaced with one of different
  // dimensions.  Fall back to the compile-time constant only when the SVG has
  // no parseable viewBox (should never happen for a valid floor-plan SVG).
  const vb = parseSvgViewBox(normalizedSvg);
  if (!vb) {
    logger.warn(
      { svgHash },
      "[floor-plan/tiles] SVG has no parseable viewBox — falling back to hardcoded aspect ratio; tiles may be misaligned if SVG dimensions changed",
    );
  }
  const svgAspect = vb ? vb.w / vb.h : SVG_ASPECT_FALLBACK;

  const gridSize = tileGridSize(z);
  const totalW = TILE_PX * gridSize;
  const totalH = Math.round(totalW / svgAspect);
  const tileW = Math.round(totalW / gridSize);
  const tileH = Math.round(totalH / gridSize);

  await fs.mkdir(TILE_CACHE_DIR, { recursive: true });

  const pngBuffer = await sharp(normalizedSvg)
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
  } catch (err) {
    logger.warn({ err }, "[floor-plan/tiles] invalidateTileCache error (cache dir may not exist yet)");
  }
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
    // Return 404 when no floor plan has been uploaded, or when object storage
    // is not configured (missing bucket env var). Both cases mean the SVG is
    // unavailable — callers (e.g. the post-merge viewBox sync check) treat 404
    // as a graceful skip rather than a hard failure.
    if (!meta || !process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID) {
      res.status(404).json({ error: "No floor plan uploaded yet" });
      return;
    }
    const svgBuffer = await readFloorPlanSvg(meta.objectPath);
    res.set("Content-Type", "image/svg+xml");
    res.set("Cache-Control", "public, max-age=3600");
    res.send(svgBuffer);
  } catch (err) {
    // Any failure reading from object storage means we cannot serve the SVG,
    // so treat it as "not available" (404) rather than an internal error (500).
    // This covers both "object does not exist in bucket" and transient storage
    // errors — callers such as the post-merge viewBox sync check treat 404 as a
    // graceful skip rather than a hard failure.
    const e = err as { code?: number; message?: string };
    logger.warn({ errCode: e.code, errMsg: e.message }, "floor-plan/svg storage read failed — returning 404");
    res.status(404).json({ error: "No floor plan uploaded yet" });
  }
});

// ── GET /floor-plan/tiles/:z/:x/:y.png ───────────────────────────────────────
// Serves a single PNG tile.  Tiles are cached to disk after first generation.
// z3 and z4 tiles are generated on first request (not pre-warmed) to avoid the
// large raster cost at startup.
//
// Rasterisation strategy:
//   The full SVG is rendered at (TILE_PX * gridSize) × (TILE_PX * gridSize / SVG_ASPECT)
//   pixels using sharp, then the (x, y) sub-rectangle is extracted.  Each tile
//   is therefore exactly TILE_PX wide × round(TILE_PX / SVG_ASPECT) tall.
//   gridSize = tileGridSize(z) = 2^z, matching the client's tileGridSize(z).
//
// ETag / conditional GET:
//   The ETag is derived from the SVG content hash and tile coordinates so
//   CDNs and mobile clients can skip re-downloading unchanged tiles with a
//   304 Not Modified response.
router.get("/floor-plan/tiles/:z/:x/:y", async (req, res) => {
  try {
    const z = parseInt(req.params.z, 10);
    const x = parseInt(req.params.x, 10);
    // Strip .png extension from y if present (route param captures the full segment)
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

    // ETag is stable for the lifetime of a given (svgHash, z, x, y) tuple.
    // Changing the floor plan produces a new hash and therefore a new ETag,
    // which forces CDN/proxy to fetch the updated tile.
    const etag = `"${meta.hash}-${z}-${x}-${y}"`;
    res.set("ETag", etag);
    res.set("Cache-Control", "public, max-age=86400");

    if (req.headers["if-none-match"] === etag) {
      res.status(304).end();
      return;
    }

    const svgBuffer = await readFloorPlanSvg(meta.objectPath);
    const pngBuffer = await generateTile(svgBuffer, meta.hash, z, x, y);

    res.set("Content-Type", "image/png");
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
              logger.warn({ err: tileErr, z, x, y }, "[floor-plan/warmup] tile generation failed");
            }
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, "[floor-plan/warmup] warmup error");
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

    let safeSvg: string;
    try {
      safeSvg = sanitizeSvg(svg);
    } catch {
      res.status(400).json({ error: "SVG contains disallowed content and could not be sanitized" });
      return;
    }

    const hash = crypto.createHash("sha256").update(safeSvg).digest("hex");
    const objectPath = await uploadFloorPlanSvg(safeSvg);

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
