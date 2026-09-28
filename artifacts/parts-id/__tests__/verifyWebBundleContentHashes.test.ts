/**
 * @jest-environment node
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vm from "vm";

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
    mockOriginalSerializer.mockReset();
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

  it("returns non-web serializer output unchanged", async () => {
    const nativeContact = ["support@", "clerk.com"].join("");
    const nativeBundle = {
      artifacts: [
        {
          type: "js",
          filename: "static/js/web/entry-" + "a".repeat(32) + ".js",
          source: `const contact = "${nativeContact}";`,
        },
      ],
    };
    mockOriginalSerializer.mockResolvedValueOnce(nativeBundle);

    const result = await customSerializer("fixture", { platform: "ios" });

    expect(result).toBe(nativeBundle);
    expect(result).toEqual(nativeBundle);
  });

  it.each(["ios", "android"])(
    "returns serialized %s output byte-for-byte unchanged",
    async (platform) => {
      const nativeSerializedOutput = JSON.stringify({
        platform,
        cleanupSensitiveText: ["support@", "clerk.com"].join(""),
        source: "<script src=\"/_expo/static/js/web/entry.js\"></script>",
      });
      mockOriginalSerializer.mockResolvedValueOnce(nativeSerializedOutput);

      const result = await customSerializer("fixture", { platform });

      expect(result).toBe(nativeSerializedOutput);
    },
  );

  it("sanitizes web artifacts when serializer arguments omit platform metadata", async () => {
    const contact = ["support@", "clerk.com"].join("");
    const oldEntry = "static/js/web/entry-" + "a".repeat(32) + ".js";
    const oldChunk = "static/js/web/chunk-" + "b".repeat(32) + ".js";
    const entrySource = `globalThis.entryContact = "${contact}";`;
    const chunkSource = `globalThis.chunkContact = "${contact}";`;
    const cleanEntrySource = entrySource.replace(contact, "support");
    const cleanChunkSource = chunkSource.replace(contact, "support");
    const newEntry = `static/js/web/${hashedFilename("entry", cleanEntrySource)}`;
    const newChunk = `static/js/web/${hashedFilename("chunk", cleanChunkSource)}`;
    const bundle = {
      artifacts: [
        { type: "js", filename: oldEntry, source: entrySource },
        { type: "js", filename: oldChunk, source: chunkSource },
        { type: "map", filename: `${oldEntry}.map`, source: JSON.stringify({ file: oldEntry }) },
        { type: "map", filename: `${oldChunk}.map`, source: JSON.stringify({ file: oldChunk }) },
        { type: "html", filename: "index.html", source: `<script src="/_expo/${oldEntry}"></script>` },
        { type: "metadata", filename: "routes.json", source: JSON.stringify({ chunk: oldChunk }) },
      ],
    };
    mockOriginalSerializer.mockResolvedValueOnce(bundle);

    const result = (await customSerializer("fixture", { dev: false })) as typeof bundle;
    const byFilename = new Map(result.artifacts.map((artifact) => [artifact.filename, artifact]));
    expect(byFilename.get(newEntry)?.source).toBe(cleanEntrySource);
    expect(byFilename.get(newChunk)?.source).toBe(cleanChunkSource);
    expect(byFilename.get(`${newEntry}.map`)?.source).toContain(newEntry);
    expect(byFilename.get(`${newChunk}.map`)?.source).toContain(newChunk);
    expect(byFilename.get("index.html")?.source).toContain(newEntry);
    expect(byFilename.get("routes.json")?.source).toContain(newChunk);
    expect(JSON.stringify(result)).not.toContain(contact);
    expect(JSON.stringify(result)).not.toContain(oldEntry);
    expect(JSON.stringify(result)).not.toContain(oldChunk);

    writeBundle(webOutDir, path.basename(newEntry), byFilename.get(newEntry)!.source);
    writeBundle(webOutDir, path.basename(newChunk), byFilename.get(newChunk)!.source);
    expect(() => verifyWebBundleContentHashes(webOutDir)).not.toThrow();
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
        {
          type: "metadata",
          filename: "metadata.json",
          source: JSON.stringify({
            entry: oldEntryFilename,
            chunks: [oldChunkFilename],
          }),
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
    expect(artifactsByFilename.get("metadata.json")?.source).toBe(
      JSON.stringify({
        entry: expectedEntryFilename,
        chunks: [expectedChunkFilename],
      }),
    );
    expect(JSON.stringify(result)).not.toContain(oldEntryFilename);
    expect(JSON.stringify(result)).not.toContain(oldChunkFilename);
  });

  it("resolves and loads a lazy route from a sanitized production export", async () => {
    const oldEntryFilename = "static/js/web/entry-" + "a".repeat(32) + ".js";
    const oldChunkFilename = "static/js/web/chunk-" + "b".repeat(32) + ".js";
    const supportContact = ["support@", "clerk.com"].join("");
    const entrySource = [
      `globalThis.lazyRoutePath = "/_expo/${oldChunkFilename}";`,
      `globalThis.entryContact = "${supportContact}";`,
    ].join("\n");
    const chunkSource = [
      `globalThis.lazyRouteLoaded = "inventory-details";`,
      `globalThis.chunkContact = "${supportContact}";`,
    ].join("\n");
    const sanitizedEntrySource = entrySource.replace(supportContact, "support");
    const sanitizedChunkSource = chunkSource.replace(supportContact, "support");
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
          type: "html",
          filename: "index.html",
          source: `<script type="module" src="/_expo/${oldEntryFilename}"></script>`,
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
    const exportRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "parts-id-web-export-"),
    );

    try {
      for (const artifact of result.artifacts) {
        if (
          typeof artifact.filename !== "string" ||
          typeof artifact.source !== "string"
        ) {
          continue;
        }
        const outputPath =
          artifact.filename === "index.html"
            ? path.join(exportRoot, artifact.filename)
            : path.join(exportRoot, "_expo", artifact.filename);
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, artifact.source);
      }

      const html = fs.readFileSync(path.join(exportRoot, "index.html"), "utf8");
      const entryScript = html.match(/src="([^"]+)"/)?.[1];
      expect(entryScript).toBe(`/_expo/${expectedEntryFilename}`);
      expect(artifactsByFilename.has(oldEntryFilename)).toBe(false);
      expect(artifactsByFilename.has(oldChunkFilename)).toBe(false);

      const runtime = { globalThis: {} as Record<string, unknown> };
      const entryPath = path.join(exportRoot, entryScript!.replace(/^\/+/, ""));
      vm.runInNewContext(fs.readFileSync(entryPath, "utf8"), runtime);

      const lazyRoutePath = runtime.globalThis.lazyRoutePath;
      expect(lazyRoutePath).toBe(`/_expo/${expectedChunkFilename}`);
      const lazyRouteFile = path.join(
        exportRoot,
        String(lazyRoutePath).replace(/^\/+/, ""),
      );
      expect(fs.existsSync(lazyRouteFile)).toBe(true);
      vm.runInNewContext(fs.readFileSync(lazyRouteFile, "utf8"), runtime);
      expect(runtime.globalThis.lazyRouteLoaded).toBe("inventory-details");
    } finally {
      fs.rmSync(exportRoot, { recursive: true, force: true });
    }
  });

  it("rejects split-bundle metadata that cannot be rewritten", async () => {
    const oldChunkFilename = "static/js/web/chunk-" + "b".repeat(32) + ".js";
    const chunkSource = `const contact = "${["support@", "clerk.com"].join("")}";`;
    const bundle = {
      artifacts: [
        {
          type: "js",
          filename: oldChunkFilename,
          source: chunkSource,
        },
        {
          type: "metadata",
          filename: "metadata.json",
          source: { chunks: [oldChunkFilename] },
        },
      ],
    };
    mockOriginalSerializer.mockResolvedValueOnce(bundle);

    await expect(
      customSerializer("fixture", { platform: "web" }),
    ).rejects.toThrow(/stale split-bundle artifact references/);
  });
});
