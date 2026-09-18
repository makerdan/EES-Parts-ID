import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { FAST } from "../../scripts/validation-steps.mjs";

const candidateUrl = new URL("./SKILL.md", import.meta.url);
const candidate = await readFile(candidateUrl, "utf8");
const candidatePath = fileURLToPath(candidateUrl);
const expectedCommand =
  "node skill-previews/poe-setup/targeted-correction-contract.test.mjs";

assert.ok(
  FAST.some(
    ([name, command]) =>
      name === "poe-setup-targeted-correction-contract" &&
      command === expectedCommand,
  ),
  "Poe Setup targeted correction contract must be registered in test-fast",
);

function rawSdkModuleFrom(skill) {
  const section = skill.match(
    /## 5\. Raw SDK fallback[\s\S]*?```ts\n([\s\S]*?)\n```/,
  );
  assert.ok(section, "Raw SDK fallback must contain a TypeScript module example");
  return section[1];
}

function assertImportSafeModule(source, label) {
  const sourceFile = ts.createSourceFile(
    `${label}.ts`,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  function failUnsafe(kind, node) {
    const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    assert.fail(
      `${label}: ${kind} at ${location.line + 1}:${location.character + 1}`,
    );
  }

  function isProcessEnvPoeKey(node) {
    return (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "POE_API_KEY2" &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "env" &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "process"
    );
  }

  function visitModuleScope(node) {
    if (node !== sourceFile && ts.isFunctionLike(node)) return;
    if (isProcessEnvPoeKey(node)) failUnsafe("reads POE_API_KEY2 at module scope", node);
    if (ts.isNewExpression(node)) failUnsafe("constructs a client at module scope", node);
    if (ts.isCallExpression(node)) failUnsafe("performs a call at module scope", node);
    ts.forEachChild(node, visitModuleScope);
  }

  visitModuleScope(sourceFile);
}

function markdownSection(title) {
  const start = candidate.indexOf(title);
  assert.notEqual(start, -1, `Guide is missing ${title}`);
  const end = candidate.indexOf("\n## ", start + title.length);
  return candidate.slice(start, end === -1 ? candidate.length : end);
}

function typescriptBlocks(section, label) {
  const blocks = [...section.matchAll(/```ts\n([\s\S]*?)\n```/g)].map(
    (match) => match[1],
  );
  assert.ok(blocks.length > 0, `${label} must contain TypeScript examples`);
  return blocks;
}

function compileExample(source, label) {
  const result = ts.transpileModule(source, {
    fileName: `${label}.ts`,
    compilerOptions: {
      isolatedModules: true,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    reportDiagnostics: true,
  });
  const errors = (result.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  assert.equal(
    errors.length,
    0,
    `${label}: TypeScript compilation failed: ${errors
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
      .join("; ")}`,
  );
  return result.outputText;
}

function wrapApprovedExample(example) {
  if (
    /^\s*\{[\s\S]*\}\s*$/.test(example) &&
    !/^\s*(?:const|let|var|function|async|return|if|for|while)\b/.test(example)
  ) {
    return `const exampleValue = ${example};`;
  }
  return example;
}

async function exerciseApprovedExamples() {
  const rawSource = rawSdkModuleFrom(candidate);
  assertImportSafeModule(rawSource, "approved lazy module");

  const transportExamples = [
    ...typescriptBlocks(markdownSection("## 6. Discover live model IDs and capabilities"), "model discovery"),
    ...typescriptBlocks(markdownSection("## 7. Use the correct server-side REST endpoint"), "REST transport"),
  ];
  assert.ok(
    transportExamples.length >= 8,
    `Expected the approved REST/alternate-transport examples, found ${transportExamples.length}`,
  );

  const fixtureDir = await mkdtemp(join(tmpdir(), "poe-setup-contract-"));
  try {
    const openAiStubPath = join(fixtureDir, "openai-stub.mjs");
    const rawFixturePath = join(fixtureDir, "raw-sdk.mjs");
    const transportFixturePaths = [];

    await writeFile(
      openAiStubPath,
      `globalThis.__poeExampleSafety = { constructors: 0 };
export default class OpenAI {
  constructor() {
    globalThis.__poeExampleSafety.constructors += 1;
    throw new Error("OpenAI client construction occurred during example import");
  }
}
`,
      "utf8",
    );

    const rawFixtureSource = rawSource.replace(
      /from\s+["']openai["'];?/,
      'from "./openai-stub.mjs";',
    );
    await writeFile(
      rawFixturePath,
      compileExample(rawFixtureSource, "raw-sdk"),
      "utf8",
    );

    for (const [index, example] of transportExamples.entries()) {
      const fixturePath = join(fixtureDir, `transport-${index + 1}.mjs`);
      const fixtureSource = `export async function runExample() {
${wrapApprovedExample(example)}
}
`;
      await writeFile(
        fixturePath,
        compileExample(fixtureSource, `transport-${index + 1}`),
        "utf8",
      );
      transportFixturePaths.push(fixturePath);
    }

    const modules = [rawFixturePath, ...transportFixturePaths].map(
      (path) => new URL(`file://${path}`).href,
    );
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
delete process.env.POE_API_KEY2;
globalThis.fetch = () => {
  throw new Error("network activity occurred during Poe example import");
};
for (const moduleUrl of ${JSON.stringify(modules)}) {
  await import(moduleUrl);
}
if (globalThis.__poeExampleSafety.constructors !== 0) {
  throw new Error("an approved Poe example constructed a client during import");
}
`,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env },
      },
    );
    assert.equal(
      child.status,
      0,
      [
        "approved Poe examples must compile and import without client/network work",
        child.stdout,
        child.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

assert.match(candidate, /^---\nname: Poe-Setup\n[\s\S]*?\n---\n/);
assert.match(candidate, /process\.env\.POE_API_KEY2/);
assert.doesNotMatch(candidate, /\bPOE_API_KEY\b/);

assert.match(candidate, /function getPoeClient\(\): OpenAI/);
assert.match(candidate, /let poeClient: OpenAI \| undefined/);
assert.match(candidate, /if \(poeClient\) return poeClient/);
assert.match(candidate, /poeClient = new OpenAI\(/);
assertImportSafeModule(rawSdkModuleFrom(candidate), "approved lazy module");

assert.match(
  candidate,
  /Importing the module\s+must not read or validate optional Poe configuration/,
);
assert.match(candidate, /Fail with a clear configuration error at\s+the operation boundary/);
assert.match(candidate, /explicit startup preflight/);
assert.match(candidate, /not a module-import side effect/);

assert.match(candidate, /OpenAI-compatible `\/v1`/);
assert.match(candidate, /legacy `\/bot\/` paths use Poe's bot-server protocol/);
assert.match(candidate, /not\s+for calling Poe models through the OpenAI SDK/);
assert.doesNotMatch(
  candidate,
  /baseURL:\s*["']https:\/\/api\.poe\.com\/bot\/?["']/,
);

await exerciseApprovedExamples();

assert.match(candidate, /## 1\. Intake before model selection/);
assert.match(candidate, /### Tool calling/);
assert.match(candidate, /### Multimodal input/);
assert.match(candidate, /### Streaming and SSE/);
assert.match(candidate, /## 8\. Reconstruct context when switching models/);
assert.match(candidate, /## 9\. Reliability, privacy, and cost controls/);
assert.match(candidate, /## 12\. Generic new-route checklist/);

const rejectedMutations = [
  {
    name: "plain eager client",
    source: 'import OpenAI from "openai";\nconst client = new OpenAI({ apiKey: "x" });',
  },
  {
    name: "differently named eager client",
    source:
      'import OpenAI from "openai";\nconst alternatePoeClient = new OpenAI({ apiKey: "x" });',
  },
  {
    name: "eager secret validation",
    source:
      'const key = process.env.POE_API_KEY2;\nif (!key) {\n  throw new Error("missing");\n}',
  },
  {
    name: "import-triggered health check",
    source: "checkPoeKey(process.env.POE_API_KEY2);",
  },
  {
    name: "import-triggered catalogue request",
    source: "getPoeClient().models.list();",
  },
  {
    name: "import-triggered completion probe",
    source: "client.chat.completions.create({ model: modelId });",
  },
  {
    name: "renamed eager client helper",
    source:
      'function makeClient() { return new OpenAI({ apiKey: "x" }); }\nmakeClient();',
  },
  {
    name: "alternate fetch transport",
    source: 'fetch("https://api.poe.com/v1/models");',
  },
  {
    name: "alternate responses transport",
    source: "client.responses.create({ model: modelId });",
  },
  {
    name: "renamed secret read",
    source: "const configuredKey = process.env.POE_API_KEY2;",
  },
];

for (const mutation of rejectedMutations) {
  assert.throws(
    () => assertImportSafeModule(mutation.source, mutation.name),
    undefined,
    `${mutation.name} must be rejected with an unsafe-side-effect message`,
  );
}

console.log(`Poe Setup targeted correction contract passed: ${candidatePath}`);