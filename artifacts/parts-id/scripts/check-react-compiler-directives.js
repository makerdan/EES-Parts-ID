/**
 * Extracted build-guard logic for React Compiler directive checking.
 * Kept as a separate module so it can be unit-tested independently of
 * the full build pipeline.
 */
const fs = require("fs");
const path = require("path");

const LINE_THRESHOLD = 400;

function* walkTsx(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      yield* walkTsx(full);
    } else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) yield full;
  }
}

/**
 * Scans each directory in `scanDirs` for .ts/.tsx files that exceed
 * LINE_THRESHOLD lines but are missing the `"use no memo"` directive.
 *
 * Returns an array of { file: string, lines: number } objects — one entry
 * per offending file.  An empty array means the check passed.
 */
function findMissingDirectives(scanDirs) {
  const missing = [];
  for (const dir of scanDirs) {
    for (const file of walkTsx(dir)) {
      const src = fs.readFileSync(file, "utf8");
      const lines = src.split("\n").length;
      if (lines < LINE_THRESHOLD) continue;
      if (!src.includes('"use no memo"')) {
        missing.push({ file, lines });
      }
    }
  }
  return missing;
}

module.exports = { findMissingDirectives, LINE_THRESHOLD };
