/**
 * Shared affine calibration helpers for warehouse zone overlays.
 *
 * The matrix maps stored/world zone coordinates to floor-plan SVG coordinates:
 *
 *   x' = a * x + c * y + e
 *   y' = b * x + d * y + f
 *
 * Zone editors use the safe inverse helper to turn floor-plan pointer
 * coordinates back into the stored/world coordinate space before editing.
 */

export interface AnchorPoint {
  id: number | string;
  name: string;
  svgX: number;
  svgY: number;
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

export interface AffinePoint {
  x: number;
  y: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Normalize the public anchor response without allowing malformed values into
 * the matrix solver. Invalid entries are discarded; if that leaves fewer than
 * three usable anchors, computeAnchorTransform safely falls back to identity.
 */
export function normalizeAnchorPoints(raw: unknown): Array<AnchorPoint> {
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((value, index): Array<AnchorPoint> => {
    if (!value || typeof value !== "object") return [];
    const record = value as Record<string, unknown>;
    if (
      !isFiniteNumber(record.svgX) ||
      !isFiniteNumber(record.svgY) ||
      !isFiniteNumber(record.worldX) ||
      !isFiniteNumber(record.worldY)
    ) {
      return [];
    }

    return [{
      id:
        typeof record.id === "number" || typeof record.id === "string"
          ? record.id
          : index + 1,
      name: typeof record.name === "string" ? record.name : "",
      svgX: record.svgX,
      svgY: record.svgY,
      worldX: record.worldX,
      worldY: record.worldY,
    }];
  });
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

  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return null;

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

  const result: [number, number, number] = [detX / det, detY / det, detZ / det];
  return result.every(Number.isFinite) ? result : null;
}

/**
 * Compute the affine matrix from the first three anchor pairs.
 *
 * Returns null when fewer than three anchors are supplied, an anchor contains
 * a non-finite coordinate, the source points are degenerate, or the resulting
 * SVG transform has no safe inverse.
 */
export function computeAnchorTransform(anchors: Array<AnchorPoint>): AffineMatrix | null {
  if (anchors.length < 3) return null;

  const [p1, p2, p3] = anchors;
  if (p1 === undefined || p2 === undefined || p3 === undefined) return null;
  const points = [p1, p2, p3];
  if (
    points.some((point) =>
      ![
        point.svgX,
        point.svgY,
        point.worldX,
        point.worldY,
      ].every(Number.isFinite),
    )
  ) {
    return null;
  }

  const M: [[number, number, number], [number, number, number], [number, number, number]] = [
    [p1.worldX, p1.worldY, 1],
    [p2.worldX, p2.worldY, 1],
    [p3.worldX, p3.worldY, 1],
  ];

  const row1 = solveLinear3(M, [p1.svgX, p2.svgX, p3.svgX]);
  if (row1 === null) return null;
  const row2 = solveLinear3(M, [p1.svgY, p2.svgY, p3.svgY]);
  if (row2 === null) return null;

  const matrix: AffineMatrix = {
    a: row1[0],
    c: row1[1],
    e: row1[2],
    b: row2[0],
    d: row2[1],
    f: row2[2],
  };
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-9) return null;
  return matrix;
}

/**
 * Convert a floor-plan SVG point back into stored/world coordinates.
 * Returns null for a non-invertible or otherwise unsafe matrix.
 */
export function inverseAnchorPoint(
  matrix: AffineMatrix | null | undefined,
  point: AffinePoint,
): AffinePoint | null {
  if (!matrix || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return matrix ? null : point;
  }
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-9) return null;

  const dx = point.x - matrix.e;
  const dy = point.y - matrix.f;
  const result = {
    x: (matrix.d * dx - matrix.c * dy) / determinant,
    y: (-matrix.b * dx + matrix.a * dy) / determinant,
  };
  return Number.isFinite(result.x) && Number.isFinite(result.y) ? result : null;
}

/**
 * Format an AffineMatrix as an SVG matrix(a,b,c,d,e,f) transform string.
 */
export function matrixToSvgString(matrix: AffineMatrix): string {
  const format = (value: number) => parseFloat(value.toFixed(6));
  return `matrix(${format(matrix.a)},${format(matrix.b)},${format(matrix.c)},${format(matrix.d)},${format(matrix.e)},${format(matrix.f)})`;
}