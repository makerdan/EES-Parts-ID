---
name: RN tile prefetch coordinate space
description: Prefetching next-level tiles requires re-deriving range from viewport transform, not scaling current-level indices.
---

# RN tile prefetch coordinate space

## Rule
When prefetching tiles for zoom level N+1 while currently at zoom level N, **never** map current-level tile indices to next-level space by multiplying them. Always re-derive the visible range from the raw viewport transform (scale, translateX/Y, container dims) using the next level's grid size.

**Why:** Each zoom stop doubles the grid (tileGridSize = 2^stopIdx). A tile at index (c, r) in the current N-grid does NOT map cleanly to (2c, 2r) in the next grid in all cases — the visible range at one level may extend to indices that don't correspond to the visually equivalent region at the next level, especially after partial panning. The correct approach is to compute the range independently for the target grid.

**How to apply:**
```js
const nextN = tileGridSize(nextStop);
const W = svgRenderWV.value; // shared value, readable from JS thread
const H = W / SVG_ASPECT;
const Z = scale.value;
const tx = translateX.value;
const ty = translateY.value;
const cW = containerWRef.current;
const cH = containerHRef.current;
const tileW = W / nextN;
const tileH = H / nextN;
const visCX = W / 2 - tx / Z;
const visCY = H / 2 - ty / Z;
const visW = cW / Z;
const visH = cH / Z;
const nextRange = {
  c0: Math.max(0, Math.floor((visCX - visW/2) / tileW) - 1),
  c1: Math.min(nextN - 1, Math.ceil((visCX + visW/2) / tileW)),
  r0: Math.max(0, Math.floor((visCY - visH/2) / tileH) - 1),
  r1: Math.min(nextN - 1, Math.ceil((visCY + visH/2) / tileH)),
};
```
