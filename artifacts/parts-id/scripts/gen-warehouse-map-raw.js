#!/usr/bin/env node
/**
 * Generates assets/warehouse-map-raw.ts — a TypeScript module that exports the
 * warehouse floor plan SVG as a compile-time string constant.
 *
 * This eliminates the async fetch() call inside _loadFloorPlanFromBundle on
 * Expo Web, where Asset.loadAsync() can return a relative URI that fetch()
 * cannot resolve correctly behind a reverse proxy (e.g. the Replit preview).
 *
 * Optimisations applied at generation time to keep the module small:
 *   1. Strip <color-profile> elements — the base64 ICC colour-profile blob is
 *      ~937 KB and is never used by the web SVG renderer.
 *   2. Strip XML/SVG comments.
 *   3. Collapse runs of whitespace between tags to a single space.
 *
 * Run after updating assets/warehouse-map.svg:
 *   node scripts/gen-warehouse-map-raw.js
 */
const fs = require("fs");
const path = require("path");

const svgPath = path.resolve(__dirname, "../assets/warehouse-map.svg");
const outPath = path.resolve(__dirname, "../assets/warehouse-map-raw.ts");

let svg = fs.readFileSync(svgPath, "utf8");

// 1. Strip <color-profile … /> elements (self-closing; contains the large ICC blob).
svg = svg.replace(/<color-profile\b[\s\S]*?\/>/g, "");

// 2. Strip XML/SVG comments (<!-- … -->).
svg = svg.replace(/<!--[\s\S]*?-->/g, "");

// 3. Collapse whitespace between tags: newlines/runs of spaces → single space.
//    Only collapses the inter-element gaps (> … <) so text-node content is safe.
svg = svg.replace(/>\s+</g, "><");

// Trim leading/trailing whitespace left behind.
svg = svg.trim();

// Escape backticks and template-literal interpolation markers.
const escaped = svg.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");

const ts = [
  "// Auto-generated — do not edit. Regenerate with: node scripts/gen-warehouse-map-raw.js",
  `export const WAREHOUSE_MAP_SVG: string = \`${escaped}\`;`,
  "",
].join("\n");

fs.writeFileSync(outPath, ts);
console.log(`[gen-warehouse-map-raw] wrote ${outPath} (${ts.length} chars, original SVG was ${fs.statSync(svgPath).size} bytes)`);
