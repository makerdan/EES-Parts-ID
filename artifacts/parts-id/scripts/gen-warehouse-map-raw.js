#!/usr/bin/env node
/**
 * Generates assets/warehouse-map-raw.ts — a TypeScript module that exports the
 * warehouse floor plan SVG as a compile-time string constant.
 *
 * This eliminates the async fetch() call inside _loadFloorPlanFromBundle on
 * Expo Web, where Asset.loadAsync() can return a relative URI that fetch()
 * cannot resolve correctly behind a reverse proxy (e.g. the Replit preview).
 *
 * Run after updating assets/warehouse-map.svg:
 *   node scripts/gen-warehouse-map-raw.js
 */
const fs = require("fs");
const path = require("path");

const svgPath = path.resolve(__dirname, "../assets/warehouse-map.svg");
const outPath = path.resolve(__dirname, "../assets/warehouse-map-raw.ts");

const svg = fs.readFileSync(svgPath, "utf8");
// Escape backticks and template-literal interpolation markers.
const escaped = svg.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");

const ts = [
  "// Auto-generated — do not edit. Regenerate with: node scripts/gen-warehouse-map-raw.js",
  `export const WAREHOUSE_MAP_SVG: string = \`${escaped}\`;`,
  "",
].join("\n");

fs.writeFileSync(outPath, ts);
console.log(`[gen-warehouse-map-raw] wrote ${outPath} (${ts.length} chars)`);
