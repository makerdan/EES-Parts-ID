/**
 * @jest-environment node
 *
 * Regression test for the React Compiler build-guard.
 *
 * Background: babel-plugin-react-compiler silently crashes the Metro Babel
 * worker thread when it tries to compile large components, causing Metro to
 * return an opaque HTTP 500 and the build to fail.  The guard requires every
 * .ts/.tsx file that meets or exceeds LINE_THRESHOLD lines to carry a
 * `"use no memo"` directive as the first statement in its component body so
 * the compiler skips it.
 *
 * This suite exercises findMissingDirectives() against a real temporary
 * directory tree so that the check behaviour is verified end-to-end without
 * mocking the filesystem.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const {
  findMissingDirectives,
  LINE_THRESHOLD,
} = require("../scripts/check-react-compiler-directives");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rdc34-build-guard-"));
}

/** Write a file whose body is exactly `lineCount` newline-separated lines. */
function writeLines(filePath: string, lineCount: number, extraContent = ""): void {
  const filler = Array.from({ length: lineCount }, (_, i) => `// line ${i + 1}`).join("\n");
  fs.writeFileSync(filePath, filler + (extraContent ? "\n" + extraContent : ""));
}

/** Write a large file that includes the "use no memo" directive. */
function writeLargeWithDirective(filePath: string): void {
  const header = `export function MyComponent() {\n  "use no memo";\n`;
  const filler = Array.from({ length: LINE_THRESHOLD }, (_, i) => `  // line ${i}`).join("\n");
  fs.writeFileSync(filePath, header + filler + "\n}\n");
}

/** Write a large file that is missing the directive. */
function writeLargeWithoutDirective(filePath: string): void {
  const header = `export function MyComponent() {\n  const x = 1;\n`;
  const filler = Array.from({ length: LINE_THRESHOLD }, (_, i) => `  // line ${i}`).join("\n");
  fs.writeFileSync(filePath, header + filler + "\n}\n");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("findMissingDirectives (React Compiler build guard)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when scan dirs do not exist", () => {
    const missing = findMissingDirectives([path.join(tmpDir, "nonexistent")]);
    expect(missing).toEqual([]);
  });

  it("returns empty array for an empty directory", () => {
    const missing = findMissingDirectives([tmpDir]);
    expect(missing).toEqual([]);
  });

  it("ignores files below the line threshold", () => {
    fs.writeFileSync(path.join(tmpDir, "Small.tsx"), "export function Small() {}\n");
    const missing = findMissingDirectives([tmpDir]);
    expect(missing).toEqual([]);
  });

  it("ignores non-.ts/.tsx files regardless of size", () => {
    writeLines(path.join(tmpDir, "bigFile.js"), LINE_THRESHOLD + 50);
    writeLines(path.join(tmpDir, "bigFile.jsx"), LINE_THRESHOLD + 50);
    const missing = findMissingDirectives([tmpDir]);
    expect(missing).toEqual([]);
  });

  it("passes a large .tsx file that has the directive", () => {
    writeLargeWithDirective(path.join(tmpDir, "BigComponent.tsx"));
    const missing = findMissingDirectives([tmpDir]);
    expect(missing).toEqual([]);
  });

  it("passes a large .ts file that has the directive", () => {
    writeLargeWithDirective(path.join(tmpDir, "bigHelper.ts"));
    const missing = findMissingDirectives([tmpDir]);
    expect(missing).toEqual([]);
  });

  it("flags a large .tsx file missing the directive", () => {
    const filePath = path.join(tmpDir, "BigComponent.tsx");
    writeLargeWithoutDirective(filePath);
    const missing = findMissingDirectives([tmpDir]);
    expect(missing).toHaveLength(1);
    expect(missing[0].file).toBe(filePath);
    expect(missing[0].lines).toBeGreaterThanOrEqual(LINE_THRESHOLD);
  });

  it("flags a large .ts file missing the directive", () => {
    const filePath = path.join(tmpDir, "bigHelper.ts");
    writeLargeWithoutDirective(filePath);
    const missing = findMissingDirectives([tmpDir]);
    expect(missing).toHaveLength(1);
    expect(missing[0].file).toBe(filePath);
  });

  it("flags multiple offending files across a directory tree", () => {
    const sub = path.join(tmpDir, "nested");
    fs.mkdirSync(sub);
    const fileA = path.join(tmpDir, "A.tsx");
    const fileB = path.join(sub, "B.tsx");
    writeLargeWithoutDirective(fileA);
    writeLargeWithoutDirective(fileB);
    const missing = findMissingDirectives([tmpDir]);
    const flagged = missing.map((m: { file: string }) => m.file).sort();
    expect(flagged).toEqual([fileA, fileB].sort());
  });

  it("does not flag a file at threshold-minus-one lines", () => {
    // LINE_THRESHOLD - 1 lines → strictly below threshold → ignored
    writeLines(path.join(tmpDir, "AlmostBig.tsx"), LINE_THRESHOLD - 1);
    const missing = findMissingDirectives([tmpDir]);
    expect(missing).toEqual([]);
  });

  it("flags a file at exactly the line threshold", () => {
    // Exactly LINE_THRESHOLD lines → at or above threshold → must have directive
    const filePath = path.join(tmpDir, "ExactThreshold.tsx");
    writeLines(filePath, LINE_THRESHOLD);
    const missing = findMissingDirectives([tmpDir]);
    expect(missing).toHaveLength(1);
    expect(missing[0].file).toBe(filePath);
  });

  it("passes when a mix of small and large files exists and all large ones have the directive", () => {
    writeLines(path.join(tmpDir, "Small.tsx"), 10);
    writeLargeWithDirective(path.join(tmpDir, "BigA.tsx"));
    writeLargeWithDirective(path.join(tmpDir, "BigB.tsx"));
    const missing = findMissingDirectives([tmpDir]);
    expect(missing).toEqual([]);
  });

  it("scans multiple separate scan directories independently", () => {
    const dirA = path.join(tmpDir, "app");
    const dirB = path.join(tmpDir, "components");
    fs.mkdirSync(dirA);
    fs.mkdirSync(dirB);

    writeLargeWithDirective(path.join(dirA, "Screen.tsx"));
    const offender = path.join(dirB, "Form.tsx");
    writeLargeWithoutDirective(offender);

    const missing = findMissingDirectives([dirA, dirB]);
    expect(missing).toHaveLength(1);
    expect(missing[0].file).toBe(offender);
  });

  it("regression: the five components fixed in the June 2026 build failure all pass today", () => {
    const projectRoot = path.resolve(__dirname, "..");
    const scanDirs = [
      path.join(projectRoot, "app"),
      path.join(projectRoot, "components"),
    ];
    const missing = findMissingDirectives(scanDirs);
    if (missing.length > 0) {
      const list = missing
        .map((m: { file: string; lines: number }) =>
          `  ${path.relative(projectRoot, m.file)} (${m.lines} lines)`)
        .join("\n");
      throw new Error(
        `Large components missing "use no memo" — add the directive to prevent ` +
        `React Compiler from crashing the Metro Babel worker:\n${list}`,
      );
    }
    expect(missing).toEqual([]);
  });
});
