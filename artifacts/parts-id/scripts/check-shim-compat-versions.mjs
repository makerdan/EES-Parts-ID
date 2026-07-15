/**
 * check-shim-compat-versions.mjs
 *
 * Compares the installed versions of libraries that have hand-written ambient
 * shims in types/third-party-compat.d.ts against the baselines recorded in
 * that file.  Exits with code 1 and a clear message when any library has
 * moved to a different major or minor version, because that is when internal
 * subpaths most commonly change.
 *
 * Run automatically as part of `pretypecheck` so the CI parts-id-typecheck
 * workflow surfaces drift before the TypeScript compiler runs.
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/**
 * Library name → version at which the shim was written.
 * Each entry also lists the internal subpaths the shim depends on so that
 * whoever updates the baseline can audit them easily.
 *
 * Keep this in sync with the SHIM VERSION BASELINE block in
 * types/third-party-compat.d.ts.
 */
const SHIM_BASELINES = [
  {
    name: "react-native-svg",
    baseline: "15.12.1",
    internalPaths: [
      "lib/typescript/elements/Circle",
      "lib/typescript/elements/ClipPath",
      "lib/typescript/elements/Defs",
      "lib/typescript/elements/Ellipse",
      "lib/typescript/elements/ForeignObject",
      "lib/typescript/elements/G",
      "lib/typescript/elements/Image",
      "lib/typescript/elements/Line",
      "lib/typescript/elements/LinearGradient",
      "lib/typescript/elements/Marker",
      "lib/typescript/elements/Mask",
      "lib/typescript/elements/Path",
      "lib/typescript/elements/Pattern",
      "lib/typescript/elements/Polygon",
      "lib/typescript/elements/Polyline",
      "lib/typescript/elements/RadialGradient",
      "lib/typescript/elements/Rect",
      "lib/typescript/elements/Shape",
      "lib/typescript/elements/Stop",
      "lib/typescript/elements/Svg",
      "lib/typescript/elements/Symbol",
      "lib/typescript/elements/Text",
      "lib/typescript/elements/TextPath",
      "lib/typescript/elements/TSpan",
      "lib/typescript/elements/Use",
      "lib/typescript/elements/filters/FeBlend",
      "lib/typescript/elements/filters/FeColorMatrix",
      "lib/typescript/elements/filters/FeComposite",
      "lib/typescript/elements/filters/FeGaussianBlur",
      "lib/typescript/elements/filters/FeMerge",
      "lib/typescript/elements/filters/FeMergeNode",
      "lib/typescript/elements/filters/FeOffset",
      "lib/typescript/elements/filters/Filter",
      "lib/typescript/elements/filters/FilterPrimitive",
      "lib/typescript/fabric",
      "lib/typescript/lib/extract/types",
      "lib/typescript/xml",
      "lib/typescript/deprecated",
    ],
  },
  {
    name: "expo-camera",
    baseline: "17.0.10",
    internalPaths: ["build/Camera.types"],
  },
  {
    name: "expo-blur",
    baseline: "15.0.8",
    internalPaths: [],
  },
  {
    name: "react-native-gesture-handler",
    baseline: "2.28.0",
    internalPaths: ["lib/typescript/index"],
  },
];

/**
 * Parse a semver string into { major, minor, patch }.
 * Non-standard versions (e.g. pre-releases) return patch = 0.
 */
function parseSemver(version) {
  const clean = version.replace(/^[^0-9]*/, "");
  const [major = 0, minor = 0, patch = 0] = clean
    .split(".")
    .map((p) => parseInt(p, 10) || 0);
  return { major, minor, patch };
}

/**
 * Return the installed version of a package, or null if not found.
 */
function installedVersion(packageName) {
  try {
    const pkgPath = require.resolve(`${packageName}/package.json`, {
      paths: [path.resolve(__dirname, "..")],
    });
    const pkg = require(pkgPath);
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

let driftCount = 0;
let missingCount = 0;

for (const { name, baseline, internalPaths } of SHIM_BASELINES) {
  const installed = installedVersion(name);

  if (installed === null) {
    console.error(
      `\n[shim-compat] MISSING  ${name}\n` +
        `  Could not resolve package.json — is the package installed?\n` +
        `  Shim baseline: ${baseline}`
    );
    missingCount++;
    continue;
  }

  const base = parseSemver(baseline);
  const inst = parseSemver(installed);

  const majorDrift = inst.major !== base.major;
  const minorDrift = inst.minor !== base.minor;

  if (majorDrift || minorDrift) {
    driftCount++;
    const severity = majorDrift ? "MAJOR" : "MINOR";
    console.error(
      `\n[shim-compat] ${severity} DRIFT  ${name}\n` +
        `  Shim written for : ${baseline}\n` +
        `  Installed version: ${installed}\n` +
        (internalPaths.length > 0
          ? `  Internal paths to re-validate:\n` +
            internalPaths.map((p) => `    ${p}`).join("\n")
          : `  No internal subpaths — re-validate inline type declarations.`) +
        `\n  ACTION: Review types/third-party-compat.d.ts, update the shim if\n` +
        `  needed, then update the baseline in both that file and in\n` +
        `  scripts/check-shim-compat-versions.mjs.`
    );
  } else {
    console.log(`[shim-compat] ok  ${name}  ${installed}`);
  }
}

if (driftCount > 0 || missingCount > 0) {
  const problems = [];
  if (driftCount > 0) problems.push(`${driftCount} drift(s)`);
  if (missingCount > 0) problems.push(`${missingCount} missing`);
  console.error(
    `\n[shim-compat] FAIL — ${problems.join(", ")} detected.\n` +
      `See messages above and update types/third-party-compat.d.ts + this script.`
  );
  process.exit(1);
}

console.log("[shim-compat] All shim baselines match installed versions.");
