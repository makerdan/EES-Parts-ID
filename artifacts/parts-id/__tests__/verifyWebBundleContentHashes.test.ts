/**
 * @jest-environment node
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const mockOriginalSerializer = jest.fn();

jest.mock("expo/metro-config", () => ({
  getDefaultConfig: () => ({
    resolver: {
      assetExts: ["png"],
      sourceExts: ["js"],
    },
    serializer: {
      customSerializer: (...args: unknown[]) => mockOriginalSerializer(...args),
    },
  }),
}));

const { verifyWebBundleContentHashes } = require("../scripts/build.js") as {
  verifyWebBundleContentHashes: (webOutDir: string) => void;
};
const { customSerializer } = require("../metro.config.js").serializer as {
  customSerializer: (...args: unknown[]) => Promise<unknown>;
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

  it("rewrites split-bundle and HTML references when sanitizing multiple JS artifacts", async () => {
    const oldEntryFilename = "static/js/web/entry-" + "a".repeat(32) + ".js";
    const oldChunkFilename = "static/js/web/chunk-" + "b".repeat(32) + ".js";
    const oldEntryMapFilename = `${oldEntryFilename}.map`;
    const oldChunkMapFilename = `${oldChunkFilename}.map`;
    const supportContact = ["support@", "clerk.com"].join("");
    const namedContact = [
      "Nicolas Charpentier <",
      ["nicolas.charpentier079@", "gmail.com"].join(""),
      ">",
    ].join("");
    const entrySource = [
      `const splitChunk = "${oldChunkFilename}";`,
      `const contact = "${supportContact}";`,
      `//# sourceMappingURL=${oldEntryMapFilename}`,
    ].join("\n");
    const chunkSource = [
      `const contact = "${namedContact}";`,
      `//# sourceMappingURL=${oldChunkMapFilename}`,
    ].join("\n");
    const sanitizedEntrySource = entrySource.replace(supportContact, "support");
    const sanitizedChunkSource = chunkSource.replace(namedContact, "");
    const expectedEntryFilename = `static/js/web/entry-${crypto
      .createHash("md5")
      .update(sanitizedEntrySource)
      .digest("hex")}.js`;
    const expectedChunkFilename = `static/js/web/chunk-${crypto
      .createHash("md5")
      .update(sanitizedChunkSource)
      .digest("hex")}.js`;
    const bundle = {
      artifacts: [
        {
          type: "js",
          filename: oldEntryFilename,
          source: entrySource,
        },
        {
          type: "js",
          filename: oldChunkFilename,
          source: chunkSource,
        },
        {
          type: "map",
          filename: oldEntryMapFilename,
          source: JSON.stringify({ file: oldEntryFilename }),
        },
        {
          type: "map",
          filename: oldChunkMapFilename,
          source: JSON.stringify({ file: oldChunkFilename }),
        },
        {
          type: "html",
          filename: "index.html",
          source: [
            `<script src="/_${oldEntryFilename}"></script>`,
            `<script src="/_${oldChunkFilename}"></script>`,
          ].join("\n"),
        },
      ],
    };
    mockOriginalSerializer.mockResolvedValueOnce(bundle);

    const result = (await customSerializer("fixture", { platform: "web" })) as {
      artifacts: Array<{ filename: string; source?: string }>;
    };
    const artifactsByFilename = new Map(
      result.artifacts.map((artifact) => [artifact.filename, artifact]),
    );
    const entryArtifact = artifactsByFilename.get(expectedEntryFilename);
    const chunkArtifact = artifactsByFilename.get(expectedChunkFilename);
    const htmlArtifact = artifactsByFilename.get("index.html");

    expect(entryArtifact?.source).toContain(
      `sourceMappingURL=${expectedEntryFilename}.map`,
    );
    expect(chunkArtifact?.source).toContain(
      `sourceMappingURL=${expectedChunkFilename}.map`,
    );
    expect(artifactsByFilename.has(`${expectedEntryFilename}.map`)).toBe(true);
    expect(artifactsByFilename.has(`${expectedChunkFilename}.map`)).toBe(true);
    expect(htmlArtifact?.source).toContain(`/_${expectedEntryFilename}`);
    expect(htmlArtifact?.source).toContain(`/_${expectedChunkFilename}`);
    expect(JSON.stringify(result)).not.toContain(oldEntryFilename);
    expect(JSON.stringify(result)).not.toContain(oldChunkFilename);
  });
});
