/**
 * Canonical web SVG scene contract for the warehouse floor plan.
 *
 * The browser floor-plan layer and the zone-overlay SVG must use the same
 * coordinate frame:
 *
 *   • `viewBox` is always `0 0 W H`, where W/H come from the source SVG.
 *   • `svgMarkup` is a complete, safe SVG document, not an inner fragment.
 *   • `renderWidth` / `renderHeight` are the pixel dimensions used by both
 *     layers.
 *
 * This module is deliberately a pure web-data boundary. It does not fetch,
 * cache, choose a fallback asset, or manage loading/error state. Callers
 * should render no scene while loading, show their existing retry/error UI
 * when loading fails, and call `createWebSvgScene` again after a retry.
 */

import {
  type ContentViewBox,
  parseContentViewBox,
} from "@/utils/mapViewport";

export interface WebSvgScene {
  /** Sanitized, origin-normalized, explicitly sized complete SVG markup. */
  svgMarkup: string;
  /** Shared coordinate frame for the floor plan and zone overlay. */
  viewBox: string;
  /** Source SVG viewBox, retained for content-fit calculations and diagnostics. */
  contentViewBox: ContentViewBox;
  /** Explicit origin-zero metadata represented by `viewBox`. */
  normalizedViewBox: ContentViewBox;
  /** Pixel dimensions shared by the floor plan and zone overlay. */
  renderWidth: number;
  renderHeight: number;
}

/**
 * Rewrite the outer SVG viewBox to an origin-zero frame while leaving all
 * artwork coordinates untouched. This is the same normalization used by the
 * server tile path; it keeps vector rendering and raster tiles in one frame.
 *
 * Returns the input unchanged when the outer viewBox is already normalized or
 * cannot be parsed safely.
 */
export function normalizeSvgViewBoxOrigin(svg: string): string {
  const rootMatch = /<svg\b[^>]*>/i.exec(svg);
  if (!rootMatch) return svg;

  const root = rootMatch[0];
  const viewBoxMatch = /\sviewBox\s*=\s*(["'])([^"']*)\1/i.exec(root);
  if (!viewBoxMatch) return svg;

  const parts = viewBoxMatch[2]!.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((value) => !isFinite(value))) return svg;

  const [x, y, width, height] = parts;
  if (x === 0 && y === 0) return svg;

  const normalizedRoot = root.replace(
    /\sviewBox\s*=\s*(["'])[^"']*\1/i,
    ` viewBox="0 0 ${width} ${height}"`,
  );
  return `${svg.slice(0, rootMatch.index)}${normalizedRoot}${svg.slice(
    rootMatch.index + root.length,
  )}`;
}

/**
 * Conservative string-based SVG sanitizer for the browser injection path.
 *
 * This intentionally mirrors the API server's sanitizer. It avoids parsing
 * SVG as an HTML fragment, which can turn SVG-only elements into inert HTML
 * nodes and blank the floor plan.
 */
export function sanitizeSvgForWeb(svg: string): string {
  let safeSvg = svg;

  safeSvg = safeSvg.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "");
  safeSvg = safeSvg.replace(/<script\b[^/]*\/>/gi, "");
  safeSvg = safeSvg.replace(/<foreignObject\b[^>]*>[\s\S]*?<\/foreignObject\s*>/gi, "");
  safeSvg = safeSvg.replace(/<foreignObject\b[^/]*\/>/gi, "");
  safeSvg = safeSvg.replace(
    /\s+on[a-z][a-z0-9]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi,
    "",
  );
  safeSvg = safeSvg.replace(
    /\b(href|src|xlink:href|action)\s*=\s*/gi,
    (_match, attribute: string) => `${attribute}=`,
  );
  safeSvg = safeSvg.replace(
    /\b(href|src|xlink:href|action)=\s*(?:"(?:javascript:|data:)[^"]*"|'(?:javascript:|data:)[^']*'|(?:javascript:|data:)\S*)/gi,
    '$1=""',
  );

  return safeSvg;
}

/**
 * Rewrite the outer SVG width/height attributes to the exact render size.
 * Missing attributes are added so the contract never depends on browser
 * defaults or the source file's intrinsic dimensions.
 */
export function sizeSvgRoot(svg: string, width: number, height: number): string {
  const rootMatch = /<svg\b[^>]*>/i.exec(svg);
  if (!rootMatch) return svg;

  let root = rootMatch[0];
  root = rewriteSvgDimension(root, "width", width);
  root = rewriteSvgDimension(root, "height", height);

  return `${svg.slice(0, rootMatch.index)}${root}${svg.slice(
    rootMatch.index + rootMatch[0].length,
  )}`;
}

function rewriteSvgDimension(root: string, attribute: "width" | "height", value: number): string {
  const attributePattern = new RegExp(
    `\\s${attribute}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`,
    "i",
  );
  if (attributePattern.test(root)) {
    return root.replace(attributePattern, ` ${attribute}="${value}"`);
  }

  const closing = root.endsWith("/>") ? "/>" : ">";
  return `${root.slice(0, -closing.length)} ${attribute}="${value}"${closing}`;
}

/**
 * Build the canonical scene consumed by the future unified web renderer.
 *
 * Throws for malformed source SVG/viewBox or invalid viewport dimensions
 * rather than silently returning a partially aligned scene.
 */
export function createWebSvgScene(
  svg: string,
  renderWidth: number,
  renderHeight: number,
): WebSvgScene {
  if (!Number.isFinite(renderWidth) || renderWidth <= 0) {
    throw new Error("Web SVG render width must be a positive finite number");
  }
  if (!Number.isFinite(renderHeight) || renderHeight <= 0) {
    throw new Error("Web SVG render height must be a positive finite number");
  }

  const safeSvg = sanitizeSvgForWeb(svg);
  const rootMatch = /<svg\b[^>]*>/i.exec(safeSvg);
  const contentViewBox = rootMatch ? parseContentViewBox(rootMatch[0]) : null;
  if (
    contentViewBox === null ||
    contentViewBox.w <= 0 ||
    contentViewBox.h <= 0
  ) {
    throw new Error("Web SVG must contain a positive four-number viewBox");
  }

  const normalizedSvg = normalizeSvgViewBoxOrigin(safeSvg);
  return {
    svgMarkup: sizeSvgRoot(normalizedSvg, renderWidth, renderHeight),
    viewBox: `0 0 ${contentViewBox.w} ${contentViewBox.h}`,
    contentViewBox,
    normalizedViewBox: { x: 0, y: 0, w: contentViewBox.w, h: contentViewBox.h },
    renderWidth,
    renderHeight,
  };
}