#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const providerPath = new URL(
  "../../artifacts/api-server/src/lib/aiProvider.ts",
  import.meta.url,
);
const source = await readFile(providerPath, "utf8");

const exportedNames = new Set();

for (const match of source.matchAll(
  /\bexport\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g,
)) {
  exportedNames.add(match[1]);
}

for (const match of source.matchAll(/\bexport\s*\{([^}]*)\}/gs)) {
  for (const specifier of match[1].split(",")) {
    const exportedName = specifier
      .trim()
      .replace(/^type\s+/, "")
      .split(/\s+as\s+/i)
      .at(-1);
    if (exportedName) exportedNames.add(exportedName);
  }
}

const misleadingExports = [...exportedNames].filter(
  (name) => /startup/i.test(name) && /probe/i.test(name),
);

assert.deepEqual(
  misleadingExports,
  [],
  `aiProvider.ts must not export startup-named live probes: ${misleadingExports.join(", ")}`,
);

console.log("AI provider startup export contract passed.");