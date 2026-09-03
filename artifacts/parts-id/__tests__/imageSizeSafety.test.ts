import { execFileSync } from "node:child_process";

type MalformedImage = {
  name: string;
  bytes: number[];
};

function runParserInChild(bytes: number[]): string {
  const script = `
    const sizeOf = require("image-size");
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
  it.each(malformedImages)("terminates deterministically for malformed $name input", ({ bytes }) => {
    expect(() => runParserInChild(bytes)).not.toThrow();
    const output = JSON.parse(runParserInChild(bytes)) as { result?: unknown; error?: string };
    expect(output.result).toBeUndefined();
    expect(output.error).toEqual(expect.any(String));
  });
});