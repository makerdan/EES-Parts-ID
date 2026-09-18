import { execFileSync } from "child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { declarationInventoryFailures } from "../check-dist-declarations-helpers";

type OutputManifest = {
  sourceFiles: string[];
  requiredFiles: string[];
  nonEmptyDirectories: string[];
};

const API_SPEC_ROOT = resolve(__dirname, "../..");
const CHECKER = resolve(API_SPEC_ROOT, "scripts/check-generated-output.mjs");
const manifest = JSON.parse(
  readFileSync(resolve(API_SPEC_ROOT, "generated-output-manifest.json"), "utf8"),
) as OutputManifest;

function makeCompleteOutput(): string {
  const root = mkdtempSync(join(tmpdir(), "generated-output-test-"));
  for (const path of new Set([...manifest.sourceFiles, ...manifest.requiredFiles])) {
    const absolutePath = join(root, path);
    mkdirSync(resolve(absolutePath, ".."), { recursive: true });
    writeFileSync(absolutePath, "export const generated = true;\n");
  }
  for (const path of manifest.nonEmptyDirectories) {
    mkdirSync(join(root, path), { recursive: true });
  }
  return root;
}

function runChecker(root: string, ...args: string[]): string {
  try {
    return execFileSync(process.execPath, [CHECKER, ...args], {
      cwd: root,
      env: { ...process.env, GENERATED_OUTPUT_ROOT: root },
      encoding: "utf8",
    });
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string };
    return `${result.stdout ?? ""}${result.stderr ?? ""}`;
  }
}

afterEach(() => {
  for (const root of activeRoots) rmSync(root, { recursive: true, force: true });
  activeRoots.length = 0;
});

const activeRoots: string[] = [];

describe("generated output inventory", () => {
  it("accepts a complete output tree", () => {
    const root = makeCompleteOutput();
    activeRoots.push(root);

    expect(runChecker(root)).toContain("inventory is complete");
  });

  it("rejects a missing schema and an empty Zod types directory", () => {
    const root = makeCompleteOutput();
    activeRoots.push(root);
    rmSync(join(root, "lib/api-client-react/src/generated/api.schemas.ts"));
    for (const path of manifest.sourceFiles.filter((entry) =>
      entry.startsWith("lib/api-zod/src/generated/types/"),
    )) {
      rmSync(join(root, path));
    }

    const output = runChecker(root);
    expect(output).toContain("MISSING generated output");
    expect(output).toContain("EMPTY generated directory");
  });

  it("rejects unexpected generated files", () => {
    const root = makeCompleteOutput();
    activeRoots.push(root);
    const extra = join(root, "lib/api-zod/src/generated/types/stale.ts");
    writeFileSync(extra, "export const stale = true;\n");

    expect(runChecker(root)).toContain(
      "UNEXPECTED generated output: lib/api-zod/src/generated/types/stale.ts",
    );
  });

  it("rejects an expected generated file that is untracked", () => {
    const root = makeCompleteOutput();
    activeRoots.push(root);
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    const untracked = "lib/api-zod/src/generated/api.ts";
    execFileSync("git", ["rm", "--cached", "-q", "--", untracked], { cwd: root });

    expect(runChecker(root)).toContain(`UNTRACKED generated output: ${untracked}`);
  });
});

describe("declaration inventory", () => {
  it("rejects obsolete declarations instead of ignoring them", () => {
    const failures = declarationInventoryFailures(
      new Set(["index.d.ts", "generated/api.d.ts"]),
      new Set(["index.d.ts", "generated/api.d.ts"]),
      new Set([
        "index.d.ts",
        "generated/api.d.ts",
        "generated/obsolete.d.ts",
      ]),
    );

    expect(failures).toEqual([
      "  generated/obsolete.d.ts: obsolete declaration remains in dist/",
    ]);
  });
});