#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const webOutDir = path.join(projectRoot, "static-build", "web");

if (!fs.existsSync(webOutDir)) {
  console.log(`[bundle:domain-check] static-build/web/ does not exist — skipping (no build to scan).`);
  process.exit(0);
}

function walkJs(dir, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJs(full, results);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      results.push(full);
    }
  }
  return results;
}

const jsFiles = walkJs(webOutDir);

if (jsFiles.length === 0) {
  console.log(`[bundle:domain-check] No JS files found in static-build/web/ — skipping.`);
  process.exit(0);
}

const devDomainPattern = /[a-z0-9-]+\.replit\.dev/g;
const violations = [];

for (const filePath of jsFiles) {
  const rel = path.relative(projectRoot, filePath);
  const content = fs.readFileSync(filePath, "utf-8");
  const matches = [...content.matchAll(devDomainPattern)];
  for (const m of matches) {
    const start = Math.max(0, m.index - 40);
    const end = Math.min(content.length, m.index + m[0].length + 40);
    const snippet = content.slice(start, end).replace(/\n/g, " ");
    violations.push({ file: rel, match: m[0], snippet });
  }
}

if (violations.length > 0) {
  console.error(
    `[bundle:domain-check] FAILED — ${violations.length} dev domain occurrence(s) found in web bundle.\n` +
    `  *.replit.dev URLs are access-controlled preview domains and must not ship\n` +
    `  to production. Ensure REPLIT_INTERNAL_APP_DOMAIN is set at build time.\n`
  );
  for (const v of violations) {
    console.error(`  ${v.file}`);
    console.error(`    match:   ${v.match}`);
    console.error(`    context: ...${v.snippet}...`);
  }
  process.exit(1);
}

console.log(
  `[bundle:domain-check] PASSED — scanned ${jsFiles.length} JS file(s), no .replit.dev URLs found.`
);
process.exit(0);
