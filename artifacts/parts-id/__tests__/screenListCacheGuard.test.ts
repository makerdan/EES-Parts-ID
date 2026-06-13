/**
 * @jest-environment node
 *
 * Guards the post-save list-cache invalidation contract for the five screens
 * (BarcodeScreen, BarcodeScanModal, BarcodeAddPart, CatalogPickerModal,
 * PartDetailsEditor) that previously inlined their own predicate via
 * `getListInventoryQueryKey()[0]`.
 *
 * After migration each screen must:
 *   1. Import `invalidateListCache` from `@/utils/editItemCache` (the shared
 *      utility) — not re-derive the predicate inline.
 *   2. Call `invalidateListCache(` somewhere in the file body — the symbol is
 *      used, not just imported.
 *
 * These two static checks catch the class of regression where a future refactor
 * accidentally reverts back to an inline predicate or drops the call entirely.
 * They complement the runtime contract tests in `listCacheSaveGuard.test.ts`.
 */

import * as fs from "fs";
import * as path from "path";

const COMPONENTS_DIR = path.join(__dirname, "..", "components");

function readSrc(filename: string): string {
  return fs.readFileSync(path.join(COMPONENTS_DIR, filename), "utf-8");
}

const SCREENS: ReadonlyArray<string> = [
  "BarcodeScreen.tsx",
  "BarcodeScanModal.tsx",
  "BarcodeAddPart.tsx",
  "CatalogPickerModal.tsx",
  "PartDetailsEditor.tsx",
];

describe("Screen list-cache invalidation — static source guards", () => {
  for (const screen of SCREENS) {
    describe(screen, () => {
      let src: string;

      beforeAll(() => {
        src = readSrc(screen);
      });

      it("imports invalidateListCache from @/utils/editItemCache (shared utility, not inline predicate)", () => {
        expect(src).toContain("invalidateListCache");
        expect(src).toContain("@/utils/editItemCache");
      });

      it("calls invalidateListCache at least once in the component body", () => {
        const nonImportLines = src
          .split("\n")
          .filter((line) => !line.trimStart().startsWith("import "))
          .join("\n");
        expect(nonImportLines).toContain("invalidateListCache(");
      });

      it("does NOT contain an inlined getListInventoryQueryKey()[0] invalidateQueries predicate", () => {
        // Any remaining use of getListInventoryQueryKey()[0] should be in a
        // setQueriesData call (PartDetailsEditor) — never in invalidateQueries.
        // We detect a regression by searching for the specific pair that the
        // inline pattern always produces.
        const hasInlinePredicate = (
          /getListInventoryQueryKey\(\)\[0\][\s\S]{0,300}invalidateQueries/.test(src) ||
          /invalidateQueries[\s\S]{0,300}getListInventoryQueryKey\(\)\[0\]/.test(src)
        );
        expect(hasInlinePredicate).toBe(false);
      });
    });
  }
});
