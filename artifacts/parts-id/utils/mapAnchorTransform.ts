/**
 * Affine transform computation from 3 SVG↔world anchor pairs.
 *
 * Given 3 named anchor points (each mapping an SVG tap coordinate to a
 * zone-data coordinate), this module solves the 2×3 affine matrix that maps
 * zone-data space → SVG-viewBox space.  The result can be applied directly as
 * an SVG `<G transform="matrix(a,b,c,d,e,f)">` on the zone overlay layer.
 *
 * SVG matrix(a, b, c, d, e, f) semantics:
 *   x_out = a * x_in + c * y_in + e
 *   y_out = b * x_in + d * y_in + f
 *
 * The mapping direction is: zone coordinates (worldX, worldY) → SVG pixel
 * position (svgX, svgY).  Three non-collinear pairs fully constrain the 6
 * degrees of freedom (translation, scale, rotation, shear).
 *
 * Returns null when:
 *   • fewer than 3 anchors are supplied, or
 *   • the three anchor pairs are (near-)collinear (degenerate system).
 */

export interface AnchorPoint {
  /** Slot 1–3. */
  id: number | string;
  name: string;
  /** Point tapped on the floor-plan SVG (viewBox coordinate space). */
  svgX: number;
  svgY: number;
  /** Corresponding zone-data coordinate (the same coordinate space as zone svgX/svgY). */
  worldX: number;
  worldY: number;
}

export interface AffineMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

/**
 * Solve a 3×3 linear system A·x = b using Cramer's rule.
 * Returns null when det(A) ≈ 0 (singular / near-singular matrix).
 */
function solveLinear3(
  A: [[number, number, number], [number, number, number], [number, number, number]],
  b: [number, number, number],
): [number, number, number] | null {
  const det =
    A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) -
    A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) +
    A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);

  if (Math.abs(det) < 1e-9) return null;

  const detX =
    b[0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) -
    A[0][1] * (b[1] * A[2][2] - A[1][2] * b[2]) +
    A[0][2] * (b[1] * A[2][1] - A[1][1] * b[2]);

  const detY =
    A[0][0] * (b[1] * A[2][2] - A[1][2] * b[2]) -
    b[0] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) +
    A[0][2] * (A[1][0] * b[2] - b[1] * A[2][0]);

  const detZ =
    A[0][0] * (A[1][1] * b[2] - b[1] * A[2][1]) -
    A[0][1] * (A[1][0] * b[2] - b[1] * A[2][0]) +
    b[0] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);

  return [detX / det, detY / det, detZ / det];
}

/**
 * Compute the 2×3 affine matrix from exactly 3 anchor pairs.
 *
 * Returns null when fewer than 3 anchors are provided or the system is
 * degenerate (collinear world points, duplicate points, etc.).
 */
export function computeAnchorTransform(anchors: Array<AnchorPoint>): AffineMatrix | null {
  if (anchors.length < 3) return null;

  const [p1, p2, p3] = anchors;
  if (p1 === undefined || p2 === undefined || p3 === undefined) return null;

  // The coefficient matrix is the same for both row-solves (only rhs differs).
  const M: [[number, number, number], [number, number, number], [number, number, number]] = [
    [p1.worldX, p1.worldY, 1],
    [p2.worldX, p2.worldY, 1],
    [p3.worldX, p3.worldY, 1],
  ];

  // Solve for [a, c, e]  (x-output row): worldCoords → svgX
  const row1 = solveLinear3(M, [p1.svgX, p2.svgX, p3.svgX]);
  if (row1 === null) return null;

  // Solve for [b, d, f]  (y-output row): worldCoords → svgY
  const row2 = solveLinear3(M, [p1.svgY, p2.svgY, p3.svgY]);
  if (row2 === null) return null;

  return {
    a: row1[0],
    c: row1[1],
    e: row1[2],
    b: row2[0],
    d: row2[1],
    f: row2[2],
  };
}

/**
 * Format an AffineMatrix as an SVG `matrix(…)` transform string.
 * SVG matrix order: matrix(a, b, c, d, e, f)
 */
export function matrixToSvgString(m: AffineMatrix): string {
  // Limit to 6 decimal places to keep the string readable in the DOM inspector.
  const fmt = (n: number) => parseFloat(n.toFixed(6));
  return `matrix(${fmt(m.a)},${fmt(m.b)},${fmt(m.c)},${fmt(m.d)},${fmt(m.e)},${fmt(m.f)})`;
}
