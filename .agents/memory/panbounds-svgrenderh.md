---
name: panBounds 4th-param svgRenderH
description: mapViewport.panBounds() requires explicit svgRenderH as 4th argument; removed internal SVG_ASPECT hardcode.
---

## Rule
`panBounds(containerW, containerH, scale, svgRenderH)` — the 4th argument is required. Do not call it with 3 arguments.

**Why:** The function used to derive `svgRenderH = containerW / SVG_ASPECT` internally, coupling it to the compile-time constant. Now that each floor plan can have its own viewBox aspect ratio, callers must pass the actual computed value.

**How to apply:** At every `panBounds` call site, pass `containerW / svgAspectRef.current` (for async JS callbacks) or `svgRenderH` (the render-time derived variable) as the 4th argument. `svgAspectRef` is kept in sync with the current contentVB-derived aspect via a useEffect.
