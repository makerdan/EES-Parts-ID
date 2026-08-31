import {
  createWebSvgScene,
  normalizeSvgViewBoxOrigin,
  sizeSvgRoot,
} from "@/utils/webSvgScene";

describe("web SVG scene contract", () => {
  it("keeps a zero-origin viewBox and exposes the shared frame", () => {
    const scene = createWebSvgScene(
      '<svg viewBox="0 0 6000 4000"><rect id="valid-floor" x="10" y="20" width="30" height="40"/></svg>',
      390,
      260,
    );

    expect(scene.contentViewBox).toEqual({ x: 0, y: 0, w: 6000, h: 4000 });
    expect(scene.normalizedViewBox).toEqual({ x: 0, y: 0, w: 6000, h: 4000 });
    expect(scene.viewBox).toBe("0 0 6000 4000");
    expect(scene.renderWidth).toBe(390);
    expect(scene.renderHeight).toBe(260);
    expect(scene.svgMarkup).toContain('viewBox="0 0 6000 4000"');
    expect(scene.svgMarkup).toContain('id="valid-floor"');
  });

  it("normalizes a non-zero origin without changing artwork coordinates", () => {
    const source =
      '<svg viewBox="100 200 5000 3000"><path id="warehouse-outline" d="M100 200H5100V3200Z"/></svg>';
    const normalized = normalizeSvgViewBoxOrigin(source);

    expect(normalized).toContain('viewBox="0 0 5000 3000"');
    expect(normalized).toContain('d="M100 200H5100V3200Z"');
    expect(normalized).not.toContain('viewBox="100 200 5000 3000"');

    const scene = createWebSvgScene(source, 500, 300);
    expect(scene.viewBox).toBe("0 0 5000 3000");
    expect(scene.contentViewBox).toEqual({ x: 100, y: 200, w: 5000, h: 3000 });
    expect(scene.normalizedViewBox).toEqual({ x: 0, y: 0, w: 5000, h: 3000 });
    expect(scene.svgMarkup).toContain('viewBox="0 0 5000 3000"');
  });

  it("rewrites existing dimensions and adds missing dimensions", () => {
    expect(
      sizeSvgRoot(
        '<svg viewBox="0 0 100 50" width="100%" height="50"><rect/></svg>',
        800,
        400,
      ),
    ).toContain('<svg viewBox="0 0 100 50" width="800" height="400">');

    expect(
      sizeSvgRoot('<svg viewBox="0 0 100 50"><rect/></svg>', 800, 400),
    ).toContain('<svg viewBox="0 0 100 50" width="800" height="400">');
  });

  it("removes unsafe markup and URI values while preserving valid SVG", () => {
    const unsafe =
      '<svg viewBox="0 0 100 50" onload="alert(1)">' +
      '<script>alert(2)</script>' +
      '<foreignObject><div>bad</div></foreignObject>' +
      '<rect id="valid-rect" width="10" height="10" onclick="alert(3)"/>' +
      '<a href="javascript:alert(4)"><path id="valid-path" d="M0 0"/></a>' +
      '<image href="data:text/html,bad"/>' +
      '</svg>';

    const safe = createWebSvgScene(unsafe, 200, 100).svgMarkup;

    expect(safe).toContain('id="valid-rect"');
    expect(safe).toContain('id="valid-path"');
    expect(safe).not.toMatch(/<script\b/i);
    expect(safe).not.toMatch(/foreignObject/i);
    expect(safe).not.toMatch(/\bonload\s*=/i);
    expect(safe).not.toMatch(/\bonclick\s*=/i);
    expect(safe).not.toMatch(/javascript:/i);
    expect(safe).not.toMatch(/data:text\/html/i);
  });
});