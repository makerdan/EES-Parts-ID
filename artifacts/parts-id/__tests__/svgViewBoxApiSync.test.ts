/**
 * @jest-environment node
 *
 * SVG viewBox ↔ source-constant sync guard.
 *
 * SVG_VIEWBOX_W and SVG_VIEWBOX_H in mapViewport.ts must match the viewBox
 * attribute of the floor-plan SVG served by GET /api/floor-plan/svg. If the
 * SVG is updated server-side without updating the source constants (or vice
 * versa), tile slicing and the zone overlay will silently misalign.
 *
 * This test fetches the live SVG from the API, parses its viewBox attribute,
 * and asserts the dimensions match the source constants.
 *
 * The test SKIPS automatically (vacuous pass) when:
 *   • Neither EXPO_PUBLIC_API_BASE nor EXPO_PUBLIC_DOMAIN is set in the
 *     environment — there is no server address to reach.
 *   • The server returns 404 — no floor plan has been uploaded yet.
 *
 * In CI, set EXPO_PUBLIC_API_BASE (or EXPO_PUBLIC_DOMAIN) to activate the
 * check. A server-side SVG viewBox change that is not reflected in the
 * source constants will then produce a deterministic failure here.
 *
 * Fix instructions (printed on failure):
 *   Update SVG_VIEWBOX_W / SVG_VIEWBOX_H in artifacts/parts-id/utils/mapViewport.ts
 *   to match the viewBox of the SVG now on the server, then rebuild the
 *   static web bundle:
 *     npx expo export -p web   (from artifacts/parts-id/)
 *   and commit both the source change and the updated bundle files.
 */

import { SVG_VIEWBOX_W, SVG_VIEWBOX_H, parseContentViewBox } from "@/utils/mapViewport";

// ── Resolve the API base URL from environment variables ────────────────────────

/**
 * Returns the API base URL (without trailing slash) when the environment is
 * configured for it, or null when the check should be skipped.
 */
function resolveApiBase(): string | null {
  const explicit = process.env.EXPO_PUBLIC_API_BASE;
  if (explicit) return explicit.replace(/\/$/, "");

  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  if (domain) return `https://${domain}/api`;

  return null;
}

const FIX_HINT =
  "Fix: update SVG_VIEWBOX_W / SVG_VIEWBOX_H in artifacts/parts-id/utils/mapViewport.ts " +
  "to match the server SVG, then rebuild (`npx expo export -p web` from artifacts/parts-id/) " +
  "and commit the updated bundle.";

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("SVG_VIEWBOX constants — live API viewBox sync", () => {
  it("fetches /api/floor-plan/svg and asserts viewBox W/H match SVG_VIEWBOX_W/H", async () => {
    const apiBase = resolveApiBase();

    if (!apiBase) {
      // No server address configured — skip silently.
      // Set EXPO_PUBLIC_API_BASE or EXPO_PUBLIC_DOMAIN to enable this check.
      console.warn(
        "[svgViewBoxApiSync] Skipped: set EXPO_PUBLIC_API_BASE or " +
          "EXPO_PUBLIC_DOMAIN to enable the live viewBox sync check.",
      );
      return;
    }

    const svgUrl = `${apiBase}/floor-plan/svg`;

    let res: Response;
    try {
      res = await fetch(svgUrl, { signal: AbortSignal.timeout(8_000) });
    } catch (err) {
      throw new Error(
        `Could not reach ${svgUrl}: ${(err as Error).message}\n` +
          `Ensure the API server is running when EXPO_PUBLIC_API_BASE / EXPO_PUBLIC_DOMAIN is set.`,
      );
    }

    if (res.status === 404) {
      // No floor plan has been uploaded yet — nothing to validate against.
      console.warn(
        `[svgViewBoxApiSync] ${svgUrl} returned 404 (no floor plan uploaded yet) — skipping viewBox check.`,
      );
      return;
    }

    if (!res.ok) {
      throw new Error(`GET ${svgUrl} returned ${res.status} ${res.statusText}`);
    }

    const svgText = await res.text();
    const contentViewBox = parseContentViewBox(svgText);

    if (contentViewBox === null) {
      throw new Error(
        `Could not parse a viewBox attribute from the SVG returned by ${svgUrl}.\n` +
          `Verify the server is returning a valid SVG with a viewBox attribute.`,
      );
    }

    // Only width and height affect tile math and the zone overlay coordinate
    // frame; the origin (x, y) is normalised server-side before rasterisation.
    expect(contentViewBox.w).toBeCloseTo(SVG_VIEWBOX_W, 2);
    expect(contentViewBox.h).toBeCloseTo(SVG_VIEWBOX_H, 2);
  });

});
