import {
  computeAnchorTransform,
  matrixToSvgString,
  type AnchorPoint,
  type AffineMatrix,
} from "../mapAnchorTransform";

function anchor(
  id: number,
  worldX: number,
  worldY: number,
  svgX: number,
  svgY: number,
): AnchorPoint {
  return { id, name: `A${id}`, svgX, svgY, worldX, worldY };
}

function apply(m: AffineMatrix, x: number, y: number): [number, number] {
  return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
}

function expectMatrixClose(m: AffineMatrix, expected: AffineMatrix, digits = 8) {
  expect(m.a).toBeCloseTo(expected.a, digits);
  expect(m.b).toBeCloseTo(expected.b, digits);
  expect(m.c).toBeCloseTo(expected.c, digits);
  expect(m.d).toBeCloseTo(expected.d, digits);
  expect(m.e).toBeCloseTo(expected.e, digits);
  expect(m.f).toBeCloseTo(expected.f, digits);
}

describe("computeAnchorTransform", () => {
  it("returns identity when world coords equal svg coords", () => {
    const m = computeAnchorTransform([
      anchor(1, 0, 0, 0, 0),
      anchor(2, 100, 0, 100, 0),
      anchor(3, 0, 100, 0, 100),
    ]);
    expect(m).not.toBeNull();
    expectMatrixClose(m!, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
  });

  it("recovers a pure translation", () => {
    const tx = 42.5;
    const ty = -17.25;
    const m = computeAnchorTransform([
      anchor(1, 0, 0, 0 + tx, 0 + ty),
      anchor(2, 100, 0, 100 + tx, 0 + ty),
      anchor(3, 30, 80, 30 + tx, 80 + ty),
    ]);
    expect(m).not.toBeNull();
    expectMatrixClose(m!, { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty });
  });

  it("recovers scale + rotation (+ translation)", () => {
    // Ground-truth transform: scale s, rotate theta, translate (tx, ty).
    const s = 2;
    const theta = Math.PI / 6; // 30°
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const tx = 10;
    const ty = -5;
    const truth: AffineMatrix = {
      a: s * cos,
      b: s * sin,
      c: -s * sin,
      d: s * cos,
      e: tx,
      f: ty,
    };
    const worldPts: Array<[number, number]> = [
      [0, 0],
      [50, 10],
      [-20, 70],
    ];
    const anchors = worldPts.map(([wx, wy], i) => {
      const [sx, sy] = apply(truth, wx, wy);
      return anchor(i + 1, wx, wy, sx, sy);
    });
    const m = computeAnchorTransform(anchors);
    expect(m).not.toBeNull();
    expectMatrixClose(m!, truth);
    // Sanity: matrix maps an unseen point correctly too.
    const [px, py] = apply(m!, 33, -44);
    const [ex, ey] = apply(truth, 33, -44);
    expect(px).toBeCloseTo(ex, 8);
    expect(py).toBeCloseTo(ey, 8);
  });

  it("round-trips each anchor exactly (general affine incl. shear)", () => {
    const anchors = [
      anchor(1, 12, 34, 512.5, -80.25),
      anchor(2, -56, 78, 90, 1024),
      anchor(3, 300, -120, 45.5, 66.75),
    ];
    const m = computeAnchorTransform(anchors);
    expect(m).not.toBeNull();
    for (const p of anchors) {
      const [sx, sy] = apply(m!, p.worldX, p.worldY);
      expect(sx).toBeCloseTo(p.svgX, 6);
      expect(sy).toBeCloseTo(p.svgY, 6);
    }
  });

  it("returns null for collinear world points", () => {
    const m = computeAnchorTransform([
      anchor(1, 0, 0, 5, 5),
      anchor(2, 10, 10, 20, 20),
      anchor(3, 20, 20, 35, 35),
    ]);
    expect(m).toBeNull();
  });

  it("returns null for duplicate world points", () => {
    const m = computeAnchorTransform([
      anchor(1, 10, 10, 0, 0),
      anchor(2, 10, 10, 50, 50),
      anchor(3, 20, 30, 100, 100),
    ]);
    expect(m).toBeNull();
  });

  it("returns null for fewer than 3 anchors", () => {
    expect(computeAnchorTransform([])).toBeNull();
    expect(computeAnchorTransform([anchor(1, 0, 0, 0, 0)])).toBeNull();
    expect(
      computeAnchorTransform([anchor(1, 0, 0, 0, 0), anchor(2, 10, 0, 10, 0)]),
    ).toBeNull();
  });
});

describe("matrixToSvgString", () => {
  it("emits SVG matrix(a,b,c,d,e,f) order", () => {
    const s = matrixToSvgString({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 });
    expect(s).toBe("matrix(1,2,3,4,5,6)");
  });

  it("rounds to 6 decimal places and drops trailing zeros", () => {
    const s = matrixToSvgString({
      a: 1.23456789,
      b: -0.0000004,
      c: 0.5,
      d: 2.0,
      e: 100.1000001,
      f: -3.14159265,
    });
    expect(s).toBe("matrix(1.234568,0,0.5,2,100.1,-3.141593)");
  });
});
