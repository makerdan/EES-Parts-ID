/**
 * @jest-environment node
 *
 * Regression guard: scroll-blocking overlays on the Search screen.
 *
 * Background: The `filterOverlayWrapper` View is positioned absolutely above
 * the search-results FlatList with a non-zero zIndex.  Without
 * `pointerEvents="box-none"` the View intercepts all touch/scroll events that
 * land within its bounds, silently swallowing vertical scroll gestures for
 * the list underneath.
 *
 * This test reads the raw source of the Search screen and asserts that every
 * View whose `style` prop references a style name containing "overlay" (case-
 * insensitive) AND whose corresponding StyleSheet entry has both
 * `position: "absolute"` and a non-zero `zIndex` carries either
 * `pointerEvents="box-none"` or `pointerEvents="none"` on the same JSX tag.
 *
 * Additionally it explicitly checks the known-bad case: the
 * `filterOverlayWrapper` tag must have the prop.  That way the test fails
 * immediately if someone removes the prop from that specific element.
 */

import * as fs from "fs";
import * as path from "path";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SOURCE_FILE = path.resolve(
  __dirname,
  "../app/(tabs)/index.tsx",
);

/** Return the raw source text of the Search screen. */
function readSource(): string {
  return fs.readFileSync(SOURCE_FILE, "utf-8");
}

/**
 * Extract the text of a JSX opening tag starting at `startIdx` in `src`.
 * Handles multi-line tags by walking forward until the first `>` that is not
 * inside a JSX expression `{…}`.
 */
function extractOpeningTag(src: string, startIdx: number): string {
  let i = startIdx;
  let depth = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ">" && depth === 0) {
      return src.slice(startIdx, i + 1);
    }
    i++;
  }
  return src.slice(startIdx, i);
}

/**
 * Return the value of a StyleSheet property for a given style name.
 * e.g. getStyleProp(src, "filterOverlayWrapper", "zIndex") → "20"
 */
function getStyleProp(src: string, styleName: string, prop: string): string | null {
  // Find the style block: `styleName: {`
  const blockRe = new RegExp(`\\b${styleName}\\s*:\\s*\\{`, "g");
  const blockMatch = blockRe.exec(src);
  if (!blockMatch) return null;

  // Walk from the opening `{` to the matching `}` to get the block contents
  let braces = 0;
  let start = -1;
  for (let i = blockMatch.index + blockMatch[0].length - 1; i < src.length; i++) {
    if (src[i] === "{") {
      braces++;
      if (start === -1) start = i;
    } else if (src[i] === "}") {
      braces--;
      if (braces === 0) {
        const block = src.slice(start, i + 1);
        const propRe = new RegExp(`\\b${prop}\\s*:\\s*([^,\\n}]+)`);
        const m = propRe.exec(block);
        return m ? m[1].trim() : null;
      }
    }
  }
  return null;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("filterOverlayWrapper — scroll-blocking overlay guard", () => {
  let src: string;

  beforeAll(() => {
    src = readSource();
  });

  // ── 1. The outer wrapper ────────────────────────────────────────────────────

  it("filterOverlayWrapper View carries pointerEvents=\"box-none\" or \"none\"", () => {
    // Find the JSX tag that uses styles.filterOverlayWrapper
    const tagStartRe = /<View\b/g;
    let match: RegExpExecArray | null;
    let found = false;

    while ((match = tagStartRe.exec(src)) !== null) {
      const tag = extractOpeningTag(src, match.index);
      if (!tag.includes("filterOverlayWrapper")) continue;

      found = true;

      const hasPointerEvents =
        /pointerEvents\s*=\s*["'](box-none|none)["']/.test(tag);

      expect(hasPointerEvents).toBe(true);

      if (!hasPointerEvents) {
        // Emit a descriptive failure message
        throw new Error(
          `The filterOverlayWrapper <View> is missing pointerEvents="box-none".\n` +
          `Without it the overlay intercepts scroll gestures on the list beneath it.\n` +
          `Add  pointerEvents="box-none"  to the <View style={styles.filterOverlayWrapper}> tag\n` +
          `in app/(tabs)/index.tsx.`,
        );
      }
    }

    if (!found) {
      throw new Error(
        `Could not find a <View> that references styles.filterOverlayWrapper ` +
        `in app/(tabs)/index.tsx.  ` +
        `The overlay may have been renamed — update this test to match.`,
      );
    }
  });

  // ── 2. The inner child that was the actual blocker ──────────────────────────

  it("filterOverlay child View carries pointerEvents=\"box-none\" or \"none\"", () => {
    // The filterOverlay <View> is the direct child of filterOverlayWrapper that
    // spans the full overlay width.  Without pointerEvents="box-none" it swallows
    // scroll gestures even though its parent wrapper already opts out.
    const tagStartRe = /<View\b/g;
    let match: RegExpExecArray | null;
    let found = false;

    while ((match = tagStartRe.exec(src)) !== null) {
      const tag = extractOpeningTag(src, match.index);
      if (!tag.includes("filterOverlay") || tag.includes("filterOverlayWrapper")) continue;

      found = true;

      const hasPointerEvents =
        /pointerEvents\s*=\s*["'](box-none|none)["']/.test(tag);

      if (!hasPointerEvents) {
        throw new Error(
          `The filterOverlay child <View> is missing pointerEvents="box-none".\n` +
          `It spans the full overlay width and swallows scroll gestures on the FlatList beneath.\n` +
          `Add  pointerEvents="box-none"  to the <View style={[styles.filterOverlay, …]}> tag\n` +
          `in app/(tabs)/index.tsx.`,
        );
      }

      expect(hasPointerEvents).toBe(true);
    }

    if (!found) {
      throw new Error(
        `Could not find a <View> that references styles.filterOverlay ` +
        `(without "Wrapper") in app/(tabs)/index.tsx.  ` +
        `The overlay may have been renamed — update this test to match.`,
      );
    }
  });

  // ── 3. The style is actually an absolute-positioned overlay ─────────────────

  it("filterOverlayWrapper StyleSheet entry has position:absolute and non-zero zIndex", () => {
    const position = getStyleProp(src, "filterOverlayWrapper", "position");
    expect(position).toMatch(/["']absolute["']/);

    const zIndex = getStyleProp(src, "filterOverlayWrapper", "zIndex");
    expect(zIndex).not.toBeNull();
    const zIndexNum = parseInt(zIndex ?? "0", 10);
    expect(zIndexNum).toBeGreaterThan(0);
  });

  // ── 3. General rule: any absolute+zIndex overlay sibling must opt out ────────

  it("every absolute-positioned View style with non-zero zIndex has a matching pointerEvents opt-out on its JSX tag", () => {
    // Collect style names from StyleSheet.create that are absolute + non-zero zIndex
    const overlayStyleNames: string[] = [];

    // Match StyleSheet property blocks: `someName: { … }`
    const blockRe = /(\w+)\s*:\s*\{/g;
    let blockMatch: RegExpExecArray | null;

    while ((blockMatch = blockRe.exec(src)) !== null) {
      const styleName = blockMatch[1];
      // Skip non-style-block identifiers by only looking after StyleSheet.create({
      const stylesCreateIdx = src.indexOf("StyleSheet.create(");
      if (blockMatch.index < stylesCreateIdx) continue;

      const position = getStyleProp(src, styleName, "position");
      if (!position || !position.includes("absolute")) continue;

      const zIndexStr = getStyleProp(src, styleName, "zIndex");
      if (!zIndexStr) continue;
      const zIndexNum = parseInt(zIndexStr, 10);
      if (zIndexNum <= 0) continue;

      overlayStyleNames.push(styleName);
    }

    // For each overlay style name, find every JSX tag that references it
    for (const styleName of overlayStyleNames) {
      const tagStartRe2 = /<View\b/g;
      let m: RegExpExecArray | null;

      while ((m = tagStartRe2.exec(src)) !== null) {
        const tag = extractOpeningTag(src, m.index);
        if (!tag.includes(styleName)) continue;

        const hasPointerEvents =
          /pointerEvents\s*=\s*["'](box-none|none)["']/.test(tag);

        if (!hasPointerEvents) {
          throw new Error(
            `<View style={styles.${styleName}}> is position:absolute with zIndex > 0 ` +
            `but is missing pointerEvents="box-none".\n` +
            `This overlay will silently swallow scroll/touch events on views beneath it.\n` +
            `Add  pointerEvents="box-none"  (or "none") to the tag.`,
          );
        }
      }
    }

    // Sanity: we must have found at least one overlay style (filterOverlayWrapper)
    expect(overlayStyleNames.length).toBeGreaterThan(0);
  });
});
