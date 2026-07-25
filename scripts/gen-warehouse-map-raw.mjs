#!/usr/bin/env node
/**
 * Shared script — generates a TypeScript module that exports the warehouse
 * floor plan SVG as a compile-time string constant.
 *
 * Optimisations applied at generation time to keep the module small:
 *   1. Strip <color-profile> elements — the base64 ICC colour-profile blob is
 *      ~937 KB and is never used by the SVG renderer.
 *   2. Strip XML/SVG comments.
 *   3. Collapse runs of whitespace between tags to a single space.
 *
 * Usage (paths are relative to the calling package root / cwd):
 *   node ../../scripts/gen-warehouse-map-raw.mjs <svgPath> <outPath>
 *
 * Example — from artifacts/api-server/:
 *   node ../../scripts/gen-warehouse-map-raw.mjs \
 *     src/assets/warehouse-map.svg src/assets/warehouse-map-raw.ts
 */
import fs from "fs";
import path from "path";

const [svgRelPath, outRelPath] = process.argv.slice(2);

if (!svgRelPath || !outRelPath) {
  console.error("Usage: gen-warehouse-map-raw.mjs <svgPath> <outPath>");
  process.exit(1);
}

const svgPath = path.resolve(process.cwd(), svgRelPath);
const outPath = path.resolve(process.cwd(), outRelPath);

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
  "// Auto-generated — do not edit. Regenerate with: pnpm gen:map",
  `export const WAREHOUSE_MAP_SVG: string = \`${escaped}\`;`,
  "",
].join("\n");

fs.writeFileSync(outPath, ts);
console.log(`[gen-warehouse-map-raw] wrote ${outPath} (${ts.length} chars, original SVG was ${fs.statSync(svgPath).size} bytes)`);
