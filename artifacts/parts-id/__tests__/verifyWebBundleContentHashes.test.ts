/**
 * @jest-environment node
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const { verifyWebBundleContentHashes } = require("../scripts/build.js") as {
  verifyWebBundleContentHashes: (webOutDir: string) => void;
};

function writeBundle(webOutDir: string, filename: string, source: string): void {
  const jsDir = path.join(webOutDir, "_expo", "static", "js", "web");
  fs.mkdirSync(jsDir, { recursive: true });
  fs.writeFileSync(path.join(jsDir, filename), source);
}

function hashedFilename(prefix: string, source: string): string {
  const hash = crypto.createHash("md5").update(source).digest("hex");
  return `${prefix}-${hash}.js`;
}

describe("verifyWebBundleContentHashes", () => {
  let webOutDir: string;

  beforeEach(() => {
    webOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "parts-id-web-hash-"));
  });

  afterEach(() => {
    fs.rmSync(webOutDir, { recursive: true, force: true });
  });

  it("accepts a JavaScript bundle whose filename matches its final bytes", () => {
    const source = "const runtime = true;\n";
    writeBundle(webOutDir, hashedFilename("entry", source), source);

    expect(() => verifyWebBundleContentHashes(webOutDir)).not.toThrow();
  });

  it("rejects a JavaScript bundle whose bytes changed after hashing", () => {
    const originalSource = "const runtime = true;\n";
    writeBundle(
      webOutDir,
      hashedFilename("entry", originalSource),
      `${originalSource}const contact = "sanitized";\n`,
    );

    expect(() => verifyWebBundleContentHashes(webOutDir)).toThrow(
      /content-hash mismatch/,
    );
  });
});