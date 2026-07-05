/**
 * Bundle-sync check for map viewport constants.
 *
 * The Expo static web build bundles constants from mapViewport.ts at compile
 * time. If the constants change but the bundle is not rebuilt, the deployed
 * web version silently uses stale values until the next full build.
 *
 * This test:
 *  1. Imports the current source values of the key constants.
 *  2. Reads the pre-built JS bundle from static-build/web/_expo/static/js/web/.
 *  3. Locates the module-level constant declaration block anchored on
 *     SVG_VIEWBOX_W (a highly distinctive float: 7329.6001).
 *  4. Asserts every other constant appears as an assignment within that
 *     same block, so checks are context-bound rather than a global substring
 *     search across the entire minified bundle.
 *
 * The Expo/Metro minifier serialises all module-level `const` declarations into
 * a single statement at the bottom of the module closure:
 *
 *   const t=7329.6001,n=4997.2798,c=1.466…,i=.8,o=50,u=16
 *
 * Each variable is terminated by a comma or end-of-statement, so =50 and =16
 * can only match their own assignment and not a longer number elsewhere.
 *
 * Failure mode: change any constant in mapViewport.ts without rebuilding →
 * the source import returns the new value → the new value is absent from the
 * bundled constant block → deterministic test failure with a clear message.
 *
 * Fix: run `npx expo export -p web` from artifacts/parts-id/ and commit the
 * updated bundle files under static-build/web/.
 */

import * as fs from "fs";
import * as path from "path";
import {
  SVG_VIEWBOX_W,
  SVG_VIEWBOX_H,
  MIN_SCALE,
  MAX_SCALE,
  FIT_PADDING,
  ZOOM_STOPS,
} from "@/utils/mapViewport";

const BUNDLE_DIR = path.resolve(
  __dirname,
  "../static-build/web/_expo/static/js/web",
);

const REBUILD_HINT =
  "Run `npx expo export -p web` from artifacts/parts-id/ and commit the " +
  "updated bundle files under static-build/web/.";

// ── Bundle loading ─────────────────────────────────────────────────────────────

function readBundleContent(): string {
  if (!fs.existsSync(BUNDLE_DIR)) {
    throw new Error(
      `Static web bundle directory not found: ${BUNDLE_DIR}\n${REBUILD_HINT}`,
    );
  }
  const jsFiles = fs.readdirSync(BUNDLE_DIR).filter((f) => f.endsWith(".js"));
  if (jsFiles.length === 0) {
    throw new Error(
      `No .js bundle files found in ${BUNDLE_DIR}\n${REBUILD_HINT}`,
    );
  }
  return jsFiles
    .map((f) => fs.readFileSync(path.join(BUNDLE_DIR, f), "utf8"))
    .join("\n");
}

let bundle: string;

beforeAll(() => {
  bundle = readBundleContent();
});

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Escape a string for use as a regex literal (handles the dot in floats).
 */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The minifier elides the leading zero for 0 < x < 1 (0.8 → .8).
 * Returns the string form the bundle will contain.
 */
function minifiedNumeral(value: number): string {
  const s = String(value);
  return value > 0 && value < 1 ? s.replace(/^0\./, ".") : s;
}

/**
 * Extract the module-level constant declaration block that contains
 * SVG_VIEWBOX_W.  The Expo/Metro minifier emits all numeric module constants
 * as a single comma-separated `const` statement:
 *
 *   const t=7329.6001,n=4997.2798,c=1.466…,i=.8,o=50,u=16
 *
 * We anchor on the SVG_VIEWBOX_W literal because it is highly distinctive
 * (a 4-decimal-place float not shared with any other constant in the project).
 */
function extractConstantBlock(bundleText: string, svgW: number): string {
  const wLiteral = escapeRe(String(svgW));
  // Match from `const` through the end of the comma-separated declaration.
  // The block ends at the first semicolon or function/closing-brace after it.
  const re = new RegExp(`const \\w+=${wLiteral}(?:,\\w+=[-.\\d]+)+`);
  const m = bundleText.match(re);
  if (!m) {
    throw new Error(
      `Could not locate the map-viewport constant block in the bundle.\n` +
      `Expected a pattern like "const t=${svgW},n=…" but it was absent.\n` +
      REBUILD_HINT,
    );
  }
  return m[0];
}

/**
 * Assert that `value` appears as an assigned variable (=VALUE, or =VALUE at
 * end) within the already-extracted constant block.
 *
 * The block format is:
 *   const t=W,n=H,c=ASPECT,i=MIN,o=MAX,u=PADDING
 * so `=50,` and `=16` cannot match longer numbers (e.g. 500 or 1600) because
 * the next character is always `,` or the block ends.
 */
function assertInBlock(value: number, name: string, block: string): void {
  const literal = minifiedNumeral(value);
  // Must be preceded by `=` and followed by `,` or end-of-block.
  const re = new RegExp(`=${escapeRe(literal)}(?:,|$)`);
  if (!re.test(block)) {
    throw new Error(
      `${name} (source value: ${value}, bundle literal: "${literal}") ` +
      `was NOT found in the map-viewport constant block.\n` +
      `Extracted block: ${block}\n` +
      REBUILD_HINT,
    );
  }
  expect(re.test(block)).toBe(true);
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("map constants — static web bundle sync", () => {
  let constantBlock: string;

  beforeAll(() => {
    // Extract once; all constant-value tests operate on this substring so they
    // are context-bound to the map-viewport module, not the entire 2 MB bundle.
    constantBlock = extractConstantBlock(bundle, SVG_VIEWBOX_W);
  });

  /**
   * SVG_VIEWBOX_W = 7329.6001
   *
   * This is the anchor constant used to locate the block. Its presence is
   * implicitly verified by extractConstantBlock succeeding above, but we also
   * assert it explicitly so the test failure is immediately obvious.
   */
  it("SVG_VIEWBOX_W literal is in the constant block", () => {
    // The anchor value is the one we searched for — if the block was found the
    // value is there.  Confirm it for completeness.
    expect(constantBlock).toContain(String(SVG_VIEWBOX_W));
  });

  it("SVG_VIEWBOX_H literal is in the constant block", () => {
    assertInBlock(SVG_VIEWBOX_H, "SVG_VIEWBOX_H", constantBlock);
  });

  /**
   * MIN_SCALE = 0.8  →  bundle literal: .8
   * assertInBlock handles the leading-zero elision via minifiedNumeral().
   */
  it("MIN_SCALE literal is in the constant block (as .8 in minified output)", () => {
    assertInBlock(MIN_SCALE, "MIN_SCALE", constantBlock);
  });

  it("MAX_SCALE literal is in the constant block", () => {
    assertInBlock(MAX_SCALE, "MAX_SCALE", constantBlock);
  });

  it("FIT_PADDING literal is in the constant block", () => {
    assertInBlock(FIT_PADDING, "FIT_PADDING", constantBlock);
  });

  /**
   * ZOOM_STOPS — checked against the minified ZOOM_STOPS array in the bundle.
   *
   * The Metro minifier serialises each stop as:
   *   {z:0,scale:1.5,label:"overview"}
   * so checking `scale:N,label:` is context-bound to the ZOOM_STOPS array and
   * cannot accidentally match another occurrence of the scale number elsewhere.
   */
  it("every ZOOM_STOPS entry appears in the bundle as {…scale:N,label:…}", () => {
    for (const stop of ZOOM_STOPS) {
      // Pattern: scale:VALUE,label: — anchors the scale to its stop object.
      const pattern = `scale:${stop.scale},label:`;
      if (!bundle.includes(pattern)) {
        throw new Error(
          `ZOOM_STOPS[${stop.z}] (scale=${stop.scale}) not found in the ` +
          `bundle as the pattern "${pattern}".\n` +
          REBUILD_HINT,
        );
      }
      expect(bundle).toContain(pattern);
    }
  });

  /**
   * Snapshot the ZOOM_STOPS scale array so adding, removing, or reordering
   * a stop is also caught without a rebuild.
   */
  it("ZOOM_STOPS scale set snapshot matches source", () => {
    const sourceScales = ZOOM_STOPS.map((s) => s.scale);
    expect(sourceScales).toMatchSnapshot();

    const stopsInBundle = ZOOM_STOPS.filter((stop) =>
      bundle.includes(`scale:${stop.scale},label:`),
    );
    expect(stopsInBundle.length).toBe(ZOOM_STOPS.length);
  });
});
