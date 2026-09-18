/**
 * @jest-environment node
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const { verifyBundleDomain } = require("../scripts/bundle-domain-check.js") as {
  verifyBundleDomain: (options: {
    scanRoot: string;
    expectedDomain?: string;
    label?: string;
  }) => { files: string[] };
};
const { verifyBundleDomain: verifyBuildBundleDomain } = require("../scripts/build.js") as {
  verifyBundleDomain: (domain: string, webOutDir: string) => void;
};
const {
  preflightWebArtifact,
  writeWebBuildMetadata,
} = require("../scripts/web-artifact-preflight.js") as {
  preflightWebArtifact: (options: { staticRoot: string; mode?: string }) => unknown;
  writeWebBuildMetadata: (options: { staticRoot: string; buildId: string }) => void;
};

function makeArtifact(options: { source?: string } = {}): string {
  const staticRoot = fs.mkdtempSync(path.join(os.tmpdir(), "parts-id-artifact-"));
  const webJsRoot = path.join(staticRoot, "web/_expo/static/js/web");
  fs.mkdirSync(webJsRoot, { recursive: true });
  fs.mkdirSync(path.join(staticRoot, "ios"), { recursive: true });
  fs.mkdirSync(path.join(staticRoot, "android"), { recursive: true });
  fs.writeFileSync(path.join(staticRoot, "web/index.html"), "<script src=\"bundle.js\"></script>\n");
  fs.writeFileSync(path.join(staticRoot, "web/metadata.json"), "{}\n");
  fs.writeFileSync(path.join(staticRoot, "ios/manifest.json"), "{}\n");
  fs.writeFileSync(path.join(staticRoot, "android/manifest.json"), "{}\n");
  fs.writeFileSync(
    path.join(webJsRoot, "entry.js"),
    options.source ?? 'const API = "https://parts-id.replit.app";\n',
  );
  writeWebBuildMetadata({ staticRoot, buildId: "test-build" });
  return staticRoot;
}

describe("Parts ID web artifact contract", () => {
  let staticRoot: string | undefined;

  afterEach(() => {
    if (staticRoot) {
      fs.rmSync(staticRoot, { recursive: true, force: true });
      staticRoot = undefined;
    }
  });

  it("rejects a missing JavaScript scan root", () => {
    expect(() =>
      verifyBundleDomain({
        scanRoot: path.join(os.tmpdir(), "parts-id-missing-scan-root"),
      }),
    ).toThrow(/scan root not found/);
  });

  it("rejects an empty JavaScript input", () => {
    staticRoot = makeArtifact();
    const jsPath = path.join(staticRoot, "web/_expo/static/js/web/entry.js");
    fs.writeFileSync(jsPath, "");

    expect(() =>
      verifyBundleDomain({
        scanRoot: path.dirname(jsPath),
      }),
    ).toThrow(/Empty JavaScript input/);
  });

  it("accepts a non-empty bundle with the expected domain", () => {
    staticRoot = makeArtifact();
    const root = staticRoot;

    expect(() =>
      verifyBuildBundleDomain(
        "parts-id.replit.app",
        path.join(root, "web"),
      ),
    ).not.toThrow();
    expect(
      verifyBundleDomain({
        scanRoot: path.join(root, "web/_expo/static/js/web"),
        expectedDomain: "parts-id.replit.app",
      }).files,
    ).toHaveLength(1);
  });

  it("rejects a bundle containing a preview domain", () => {
    staticRoot = makeArtifact({
      source: 'const API = "https://preview-123.replit.dev";\n',
    });
    const root = staticRoot;

    expect(() =>
      verifyBuildBundleDomain("parts-id.replit.app", path.join(root, "web")),
    ).toThrow(/Forbidden dev domain/);
    expect(() =>
      verifyBundleDomain({
        scanRoot: path.join(root, "web/_expo/static/js/web"),
        expectedDomain: "parts-id.replit.app",
      }),
    ).toThrow(/Forbidden dev domain/);
  });

  it("rejects a missing web artifact before production serving", () => {
    staticRoot = fs.mkdtempSync(path.join(os.tmpdir(), "parts-id-missing-artifact-"));
    const root = staticRoot;

    expect(() =>
      preflightWebArtifact({ staticRoot: root, mode: "production" }),
    ).toThrow(/missing file\(s\)/);
  });

  it("rejects an empty required web entry", () => {
    staticRoot = makeArtifact();
    const root = staticRoot;
    fs.writeFileSync(path.join(root, "web/index.html"), "");

    expect(() =>
      preflightWebArtifact({ staticRoot: root, mode: "production" }),
    ).toThrow(/empty file\(s\)/);
  });

  it("accepts a valid, fresh production artifact", () => {
    staticRoot = makeArtifact();
    const root = staticRoot;

    expect(
      preflightWebArtifact({ staticRoot: root, mode: "production" }),
    ).toEqual(expect.objectContaining({ fallback: false }));
  });

  it("rejects an artifact whose files are newer than its freshness marker", () => {
    staticRoot = makeArtifact();
    const root = staticRoot;
    const indexPath = path.join(root, "web/index.html");
    const markerPath = path.join(root, "build-metadata.json");
    const now = new Date();
    fs.utimesSync(markerPath, now, new Date(now.getTime() - 5_000));
    fs.utimesSync(indexPath, new Date(now.getTime() + 5_000), new Date(now.getTime() + 5_000));

    expect(() =>
      preflightWebArtifact({ staticRoot: root, mode: "production" }),
    ).toThrow(/stale artifact/);
  });

  it("allows the landing page only in explicit development mode", () => {
    staticRoot = fs.mkdtempSync(path.join(os.tmpdir(), "parts-id-dev-artifact-"));

    expect(
      preflightWebArtifact({ staticRoot, mode: "development" }),
    ).toEqual({ mode: "development", fallback: true });
  });
});