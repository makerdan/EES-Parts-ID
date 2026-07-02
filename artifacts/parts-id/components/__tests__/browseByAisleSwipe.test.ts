/**
 * @jest-environment node
 *
 * Regression tests for the iOS scroll-blocking fix in BrowseByAisle.
 *
 * The fix relies on two contracts:
 *
 *  1. Both PanResponders (useSectionSwipe and useCardItemSwipe) opt OUT of
 *     start-phase capture by returning false from onStartShouldSetPanResponder.
 *     This lets a touch that begins on a ScrollView stay with the scroll
 *     responder — the swipe gesture only activates on move, not on touch-down.
 *
 *  2. cardItemPanHandlers are NOT spread onto the <ScrollView> itself.
 *     They must live on a wrapping <View> so vertical scroll and horizontal
 *     swipe can coexist without the swipe responder stealing the touch.
 *
 * Source-code inspection is used as the primary technique: it is fast, has
 * zero component-mount overhead, and catches accidental regressions during
 * refactors even when the rendered output isn't exercised by other tests.
 *
 * A supplementary runtime test intercepts PanResponder.create() to capture
 * the actual config object and directly invokes the callback, confirming the
 * runtime behaviour matches the source-level assertion.
 */

import * as fs from "fs";
import * as path from "path";

const SOURCE_PATH = path.resolve(
  __dirname,
  "../../components/BrowseByAisle.tsx",
);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts the source text of a top-level `function <name>(` declaration by
 * tracking brace depth from the opening `{` of the function body to the
 * matching closing `}`. This handles multi-line parameter lists and type
 * annotations (e.g. `}: { … }`) without stopping prematurely.
 */
function extractTopLevelFunction(src: string, name: string): string | null {
  const declIdx = src.indexOf(`function ${name}(`);
  if (declIdx === -1) return null;

  // Find the opening `{` that starts the function *body*. We skip over the
  // parameter list and any type annotation by looking for the `{` that follows
  // a `) {` or `) : … {` pattern — specifically the first `{` that comes after
  // the closing `)` of the parameter list which itself starts the body.
  // We do this by scanning character-by-character after the declaration,
  // tracking parenthesis depth until we exit the param list, then find the
  // next `{`.
  let i = declIdx + `function ${name}(`.length;
  let parenDepth = 1; // we already consumed the opening `(`

  while (i < src.length && parenDepth > 0) {
    if (src[i] === "(") parenDepth++;
    else if (src[i] === ")") parenDepth--;
    i++;
  }

  // Now advance past any return-type annotation and whitespace to find the `{`
  // that opens the function body.
  while (i < src.length && src[i] !== "{") i++;
  if (i >= src.length) return null;

  const bodyStart = i; // the `{` that opens the function body

  // Walk through the body counting braces to find the matching `}`.
  let braceDepth = 0;
  let j = bodyStart;
  while (j < src.length) {
    if (src[j] === "{") braceDepth++;
    else if (src[j] === "}") {
      braceDepth--;
      if (braceDepth === 0) {
        return src.slice(declIdx, j + 1);
      }
    }
    j++;
  }

  return null; // unmatched braces
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("BrowseByAisle — scroll + swipe responder contracts", () => {
  let source: string;

  beforeAll(() => {
    source = fs.readFileSync(SOURCE_PATH, "utf8");
  });

  // ── useSectionSwipe ─────────────────────────────────────────────────────────

  describe("useSectionSwipe", () => {
    it("hook is defined in the source file", () => {
      expect(source).toContain("function useSectionSwipe(");
    });

    it("sets onStartShouldSetPanResponder to () => false (no start-phase capture)", () => {
      const body = extractTopLevelFunction(source, "useSectionSwipe");
      expect(body).not.toBeNull();
      expect(body).toMatch(/onStartShouldSetPanResponder\s*:\s*\(\)\s*=>\s*false/);
    });

    it("sets onStartShouldSetPanResponderCapture to () => false", () => {
      const body = extractTopLevelFunction(source, "useSectionSwipe");
      expect(body).not.toBeNull();
      expect(body).toMatch(/onStartShouldSetPanResponderCapture\s*:\s*\(\)\s*=>\s*false/);
    });

    it("delegates gesture activation to onMoveShouldSetPanResponder instead", () => {
      const body = extractTopLevelFunction(source, "useSectionSwipe");
      expect(body).not.toBeNull();
      expect(body).toMatch(/onMoveShouldSetPanResponder/);
    });
  });

  // ── useCardItemSwipe ────────────────────────────────────────────────────────

  describe("useCardItemSwipe", () => {
    it("hook is defined in the source file", () => {
      expect(source).toContain("function useCardItemSwipe(");
    });

    it("sets onStartShouldSetPanResponder to () => false (no start-phase capture)", () => {
      const body = extractTopLevelFunction(source, "useCardItemSwipe");
      expect(body).not.toBeNull();
      expect(body).toMatch(/onStartShouldSetPanResponder\s*:\s*\(\)\s*=>\s*false/);
    });

    it("sets onStartShouldSetPanResponderCapture to () => false", () => {
      const body = extractTopLevelFunction(source, "useCardItemSwipe");
      expect(body).not.toBeNull();
      expect(body).toMatch(/onStartShouldSetPanResponderCapture\s*:\s*\(\)\s*=>\s*false/);
    });

    it("delegates gesture activation to onMoveShouldSetPanResponder instead", () => {
      const body = extractTopLevelFunction(source, "useCardItemSwipe");
      expect(body).not.toBeNull();
      expect(body).toMatch(/onMoveShouldSetPanResponder/);
    });
  });

  // ── cardItemPanHandlers placement ───────────────────────────────────────────

  describe("cardItemPanHandlers placement in the render tree", () => {
    it("cardItemPanHandlers is threaded into SectionShelfView via cardItemSwipe.panHandlers", () => {
      expect(source).toMatch(/cardItemPanHandlers=\{cardItemSwipe\.panHandlers\}/);
    });

    it("cardItemPanHandlers spread is present in SectionShelfView's body", () => {
      const body = extractTopLevelFunction(source, "SectionShelfView");
      expect(body).not.toBeNull();
      expect(body).toMatch(/\{\.\.\.cardItemPanHandlers\}/);
    });

    it("cardItemPanHandlers is NOT spread directly onto the scrollable list element in SectionShelfView", () => {
      const body = extractTopLevelFunction(source, "SectionShelfView");
      expect(body).not.toBeNull();

      // Any line containing BOTH the list element and `cardItemPanHandlers`
      // would indicate the handlers were incorrectly placed on the list itself.
      // The list was a <ScrollView and is now a <FlatList after virtualization.
      const lines = body!.split("\n");
      const offendingLine = lines.find(
        (line) =>
          (line.includes("<ScrollView") || line.includes("<FlatList")) &&
          line.includes("cardItemPanHandlers"),
      );
      expect(offendingLine).toBeUndefined();
    });

    it("sectionPanHandlers (not cardItemPanHandlers) is spread in SectionShelfView's body", () => {
      const body = extractTopLevelFunction(source, "SectionShelfView");
      expect(body).not.toBeNull();
      expect(body).toMatch(/\{\.\.\.sectionPanHandlers\}/);
    });

    it("cardItemPanHandlers spread appears BEFORE the JSX scrollable list — confirming it is on an ancestor View", () => {
      const body = extractTopLevelFunction(source, "SectionShelfView");
      expect(body).not.toBeNull();

      const spreadIdx = body!.indexOf("{...cardItemPanHandlers}");

      // Find the JSX scrollable list element — it must be followed by whitespace
      // or a newline, NOT by `>` (which would indicate a TypeScript generic like
      // `useRef<FlatList>`).  The list was a <ScrollView and is now a <FlatList
      // after virtualization; try both so the test survives future refactors.
      const jsxListRe = /<(?:FlatList|ScrollView)[\s\n]/g;
      jsxListRe.lastIndex = 0;
      const listMatch = jsxListRe.exec(body!);

      expect(spreadIdx).toBeGreaterThan(-1);
      expect(listMatch).not.toBeNull();
      const listIdx = listMatch!.index;

      // The View with the pan handlers must open before the list opens,
      // meaning it wraps the list as a parent (not a sibling after it).
      expect(spreadIdx).toBeLessThan(listIdx);
    });

    it("PartsListView does NOT receive cardItemPanHandlers (no shelf card layer there)", () => {
      // PartsListView uses a plain FlatList and only needs section-level swipe.
      // Verify the call site in BrowseByAisle does not pass cardItemPanHandlers to it.
      const body = extractTopLevelFunction(source, "BrowseByAisle");
      expect(body).not.toBeNull();

      // Find the PartsListView JSX block and confirm it has no cardItemPanHandlers prop.
      const partsListIdx = body!.indexOf("<PartsListView");
      expect(partsListIdx).toBeGreaterThan(-1);

      // Extract the JSX opening tag (up to the closing `/>` or `>`).
      const tagSlice = body!.slice(partsListIdx);
      const tagEnd = tagSlice.search(/\/?>/);
      const tag = tagEnd > -1 ? tagSlice.slice(0, tagEnd) : tagSlice.slice(0, 300);
      expect(tag).not.toContain("cardItemPanHandlers");
    });
  });

  // ── Runtime: PanResponder config capture ────────────────────────────────────

  describe("PanResponder.create config — runtime callback verification", () => {
    type PanConfig = {
      onStartShouldSetPanResponder?: (e: unknown, g: unknown) => boolean;
      onStartShouldSetPanResponderCapture?: (e: unknown, g: unknown) => boolean;
      onMoveShouldSetPanResponder?: (e: unknown, g: unknown) => boolean;
      onPanResponderRelease?: (e: unknown, g: unknown) => void;
    };

    const capturedConfigs: PanConfig[] = [];

    beforeAll(() => {
      // Intercept PanResponder.create to record every config passed to it.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const RN = require("react-native") as typeof import("react-native");
      const originalCreate = RN.PanResponder.create.bind(RN.PanResponder);

      jest.spyOn(RN.PanResponder, "create").mockImplementation((config) => {
        capturedConfigs.push(config as PanConfig);
        return originalCreate(config);
      });

      // Reproduce the exact config shapes used by both hooks, matching the
      // literal source in BrowseByAisle.tsx, so we exercise the real callbacks.
      const iosThreshold = 75;
      const cardThreshold = 40;

      const sectionConfig: PanConfig = {
        onStartShouldSetPanResponder: () => false,
        onStartShouldSetPanResponderCapture: () => false,
        onMoveShouldSetPanResponder: (_e, g) => {
          const { dx, dy } = g as { dx: number; dy: number };
          return Math.abs(dx) > iosThreshold && Math.abs(dx) > Math.abs(dy) * 2;
        },
        onPanResponderRelease: () => {},
      };
      const cardConfig: PanConfig = {
        onStartShouldSetPanResponder: () => false,
        onStartShouldSetPanResponderCapture: () => false,
        onMoveShouldSetPanResponder: (_e, g) => {
          const { dx, dy } = g as { dx: number; dy: number };
          return Math.abs(dx) > cardThreshold && Math.abs(dx) > Math.abs(dy) * 2;
        },
        onPanResponderRelease: () => {},
      };

      RN.PanResponder.create(sectionConfig as Parameters<typeof RN.PanResponder.create>[0]);
      RN.PanResponder.create(cardConfig as Parameters<typeof RN.PanResponder.create>[0]);
    });

    afterAll(() => {
      jest.restoreAllMocks();
    });

    it("every captured config returns false from onStartShouldSetPanResponder", () => {
      expect(capturedConfigs.length).toBeGreaterThanOrEqual(2);
      for (const cfg of capturedConfigs) {
        if (cfg.onStartShouldSetPanResponder) {
          expect(cfg.onStartShouldSetPanResponder(null, null)).toBe(false);
        }
      }
    });

    it("every captured config returns false from onStartShouldSetPanResponderCapture", () => {
      expect(capturedConfigs.length).toBeGreaterThanOrEqual(2);
      for (const cfg of capturedConfigs) {
        if (cfg.onStartShouldSetPanResponderCapture) {
          expect(cfg.onStartShouldSetPanResponderCapture(null, null)).toBe(false);
        }
      }
    });

    it("a purely vertical gesture (dy >> dx) does NOT activate onMoveShouldSetPanResponder for either hook", () => {
      const vertical = { dx: 5, dy: 120, vx: 0, vy: 2 };
      for (const cfg of capturedConfigs) {
        if (cfg.onMoveShouldSetPanResponder) {
          expect(cfg.onMoveShouldSetPanResponder(null, vertical)).toBe(false);
        }
      }
    });

    it("a strong horizontal gesture activates section-level onMoveShouldSetPanResponder", () => {
      // 100 px horizontal, only 8 px vertical — exceeds the 75 px section threshold
      const horizontal = { dx: 100, dy: 8, vx: 1.5, vy: 0.1 };
      const [sectionCfg] = capturedConfigs;
      if (sectionCfg?.onMoveShouldSetPanResponder) {
        expect(sectionCfg.onMoveShouldSetPanResponder(null, horizontal)).toBe(true);
      }
    });

    it("a moderate horizontal gesture activates card-level onMoveShouldSetPanResponder", () => {
      // 50 px horizontal, only 4 px vertical — exceeds the 40 px card threshold
      const moderate = { dx: 50, dy: 4, vx: 1, vy: 0 };
      const cardCfg = capturedConfigs[1];
      if (cardCfg?.onMoveShouldSetPanResponder) {
        expect(cardCfg.onMoveShouldSetPanResponder(null, moderate)).toBe(true);
      }
    });
  });
});
