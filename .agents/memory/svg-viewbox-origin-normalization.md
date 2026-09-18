---
name: SVG viewBox origin normalization for tile rasterization
description: Why and how to normalize a non-zero SVG viewBox origin before rasterizing tiles with sharp, and how it aligns with client zone overlays.
---

## Rule
Any code path that rasterizes an SVG with sharp (or similar) for tile generation must first normalize the outermost `viewBox` to `"0 0 W H"` when the origin `(X, Y)` is non-zero. The client zone overlay always renders in (0,0) coordinate space, so tiles must share the same frame.

## Why
`sharp` (libvips) rasterizes an SVG relative to its own viewBox origin. If the SVG has `viewBox="500 1000 7329 4997"`, the visible content starts 500 px right / 1000 px down in the rasterized bitmap. Zone overlay SVG elements are placed in 0-based coordinate space (origin is always (0,0)), so a non-zero SVG origin causes a pixel-perfect misalignment between the floor-plan tiles and the zone rectangles at every zoom level.

## How to apply
- **Server (`generateTile`)**: Call `normalizeViewBoxOrigin(svgBuffer)` before passing to `sharp()`. The function regex-replaces `viewBox="X Y W H"` → `viewBox="0 0 W H"` only when X≠0 or Y≠0; returns the original buffer cheaply when origin is already (0,0).
- **Client (`WarehouseMapView`)**: Add a `normalizedSvgXml` useMemo that does the same string rewrite before passing to `<SvgXml>`, so the SVG layer and zone overlay are aligned even for the vector render path (not just the tile path).
- **Zone overlay `<Svg>` viewBox**: Must use `contentVB.w × contentVB.h` (the floor-plan dimensions from `contentViewBox`), not hardcoded constants, so it covers exactly the same SVG coordinate space as the normalized floor-plan SVG.
