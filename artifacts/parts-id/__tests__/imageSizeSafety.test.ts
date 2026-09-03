import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

type MalformedImage = {
  name: string;
  bytes: number[];
};

function runParserInChild(bytes: number[]): string {
  const script = `
    const imageSizePackage = require("image-size");
    const sizeOf =
      typeof imageSizePackage === "function"
        ? imageSizePackage
        : imageSizePackage.imageSize;
    if (typeof sizeOf !== "function") {
      throw new TypeError("image-size does not expose a CommonJS parser");
    }
    const input = Uint8Array.from(${JSON.stringify(bytes)});
    try {
      const result = sizeOf(input);
      process.stdout.write(JSON.stringify({ result }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ error: String(error && error.message) }));
    }
  `;
  return execFileSync(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 1_000,
  });
}

const malformedImages: Array<MalformedImage> = [
  {
    name: "ICNS",
    // Header + a zero-length entry. The parser must reject it rather than
    // repeatedly adding zero to the entry offset.
    bytes: [0x69, 0x63, 0x6e, 0x73, 0, 0, 0, 16, 0x69, 0x63, 0x6e, 0x73, 0, 0, 0, 0],
  },
  {
    name: "JXL",
    // A valid JXL container signature followed by a zero-sized partial box.
    bytes: [
      0, 0, 0, 12, 0x4a, 0x58, 0x4c, 0x20,
      0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x6a, 0x78, 0x6c, 0x20, 0, 0, 0, 0,
      0, 0, 0, 0, 0x6a, 0x78, 0x6c, 0x70,
    ],
  },
  {
    name: "HEIF",
    // A valid HEIF brand followed by a zero-sized box while searching for
    // the metadata dimensions.
    bytes: [
      0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0,
      0, 0, 0, 0, 0x6d, 0x65, 0x74, 0x61,
    ],
  },
];

describe("Metro image-size safety patch", () => {
  it("loads a complete CommonJS package through Metro's dependency path", () => {
    const metroPackagePath = require.resolve("metro/package.json");
    const imageSizeEntry = require.resolve("image-size", {
      paths: [path.dirname(metroPackagePath)],
    });
    const packageRoot = path.dirname(path.dirname(imageSizeEntry));
    const packageJsonPath = path.join(packageRoot, "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      main?: string;
      exports?: {
        "."?: {
          require?: {
            default?: string;
          };
        };
      };
    };
    const declaredEntries = [
      packageJson.main,
      packageJson.exports?.["."]?.require?.default,
    ].filter((entry): entry is string => typeof entry === "string");

    expect(declaredEntries.length).toBeGreaterThan(0);
    for (const entry of declaredEntries) {
      expect(existsSync(path.resolve(packageRoot, entry))).toBe(true);
    }
    expect(() => require(imageSizeEntry)).not.toThrow();
  });

  it("accepts the filename input Metro uses for image assets", () => {
    const metroPackagePath = require.resolve("metro/package.json");
    const imageSizeEntry = require.resolve("image-size", {
      paths: [path.dirname(metroPackagePath)],
    });
    const imageSizePackage = require(imageSizeEntry) as {
      default?: (input: string | Uint8Array) => { width: number; height: number };
      imageSize?: (input: string | Uint8Array) => { width: number; height: number };
    };
    const sizeOf = imageSizePackage.default ?? imageSizePackage.imageSize;
    const iconPath = path.resolve(process.cwd(), "assets/images/icon.png");

    expect(sizeOf).toEqual(expect.any(Function));
    expect(sizeOf?.(iconPath)).toMatchObject({
      width: expect.any(Number),
      height: expect.any(Number),
    });
  });

  it.each(malformedImages)("terminates deterministically for malformed $name input", ({ bytes }) => {
    const output = JSON.parse(runParserInChild(bytes)) as { result?: unknown; error?: string };
    expect(output.result).toBeUndefined();
    expect(output.error).toEqual(expect.any(String));
  });
});