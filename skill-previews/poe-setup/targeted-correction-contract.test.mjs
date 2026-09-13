import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const candidateUrl = new URL("./SKILL.md", import.meta.url);
const candidate = readFileSync(candidateUrl, "utf8");
const candidatePath = fileURLToPath(candidateUrl);

function rawSdkModuleFrom(skill) {
  const section = skill.match(
    /## 5\. Raw SDK fallback[\s\S]*?```ts\n([\s\S]*?)\n```/,
  );
  assert.ok(section, "Raw SDK fallback must contain a TypeScript module example");
  return section[1];
}

function assertImportSafeModule(source, label) {
  let depth = 0;
  let moduleScopeSecretRead = false;

  for (const rawLine of source.split("\n")) {
    const line = rawLine.replace(/\/\/.*$/, "").trim();
    const depthBeforeLine = depth;

    if (depthBeforeLine === 0 && /\bnew\s+OpenAI\s*\(/.test(line)) {
      assert.fail(`${label}: constructs an OpenAI client at module scope`);
    }
    if (
      depthBeforeLine === 0 &&
      /process\.env\.POE_API_KEY2\b/.test(line)
    ) {
      moduleScopeSecretRead = true;
    }
    if (
      depthBeforeLine === 0 &&
      /\b(?:checkPoeKey|getPoeClient)\s*\([^)]*\)\s*;/.test(line)
    ) {
      assert.fail(`${label}: invokes Poe setup or health work at module scope`);
    }
    if (
      depthBeforeLine === 0 &&
      /\.(?:models\.list|chat\.completions\.create)\s*\(/.test(line)
    ) {
      assert.fail(`${label}: invokes a Poe network operation at module scope`);
    }

    const opens = (line.match(/{/g) ?? []).length;
    const closes = (line.match(/}/g) ?? []).length;
    depth = Math.max(0, depth + opens - closes);
  }

  assert.equal(
    moduleScopeSecretRead,
    false,
    `${label}: reads POE_API_KEY2 at module scope`,
  );
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
];

for (const mutation of rejectedMutations) {
  assert.throws(
    () => assertImportSafeModule(mutation.source, mutation.name),
    undefined,
    `${mutation.name} must be rejected`,
  );
}

console.log(`Poe Setup targeted correction contract passed: ${candidatePath}`);