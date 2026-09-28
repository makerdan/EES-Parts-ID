/**
 * Pure SVG source-coordinate helpers shared by the native/web Map and the
 * browser-only Zone Editor.  No DOM or renderer dependencies belong here.
 */

export interface ContentViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Parse the outer SVG viewBox attribute from an SVG/XML string.
 * Returns null when the attribute is absent or malformed.
 */
export function parseContentViewBox(xml: string): ContentViewBox | null {
  const match = xml.match(/viewBox=(["'])([^"']+)\1/i);
  if (!match || match[2] === undefined) return null;
  const parts = match[2].trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) return null;
  return { x: parts[0]!, y: parts[1]!, w: parts[2]!, h: parts[3]! };
}

/**
 * Rewrite the outer SVG viewBox to an origin-zero frame while leaving artwork
 * coordinates untouched. This keeps vector artwork, raster output, and zone
 * overlays in the same user-coordinate frame.
 *
 * Invalid or missing viewBox values are returned unchanged so callers can
 * retain their existing fallback handling.
 */
export function normalizeSvgViewBoxOrigin(svg: string): string {
  const rootMatch = /<svg\b[^>]*>/i.exec(svg);
  if (!rootMatch) return svg;

  const root = rootMatch[0];
  const contentViewBox = parseContentViewBox(root);
  if (contentViewBox === null || (contentViewBox.x === 0 && contentViewBox.y === 0)) {
    return svg;
  }

  const normalizedRoot = root.replace(
    /\sviewBox\s*=\s*(["'])[^"']*\1/i,
    ` viewBox="0 0 ${contentViewBox.w} ${contentViewBox.h}"`,
  );
  return `${svg.slice(0, rootMatch.index)}${normalizedRoot}${svg.slice(
    rootMatch.index + root.length,
  )}`;
}