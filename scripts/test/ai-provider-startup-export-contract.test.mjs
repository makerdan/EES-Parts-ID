#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const requireFromApiServer = createRequire(
  new URL("../../artifacts/api-server/package.json", import.meta.url),
);
const { build } = requireFromApiServer("esbuild");

const providerPath = new URL(
  "../../artifacts/api-server/src/lib/aiProvider.ts",
  import.meta.url,
);
const source = await readFile(providerPath, "utf8");

const exportedNames = new Set();

for (const match of source.matchAll(
  /\bexport\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g,
)) {
  exportedNames.add(match[1]);
}

for (const match of source.matchAll(/\bexport\s*\{([^}]*)\}/gs)) {
  for (const specifier of match[1].split(",")) {
    const exportedName = specifier
      .trim()
      .replace(/^type\s+/, "")
      .split(/\s+as\s+/i)
      .at(-1);
    if (exportedName) exportedNames.add(exportedName);
  }
}

const misleadingExports = [...exportedNames].filter(
  (name) => /startup/i.test(name) && /probe/i.test(name),
);

assert.deepEqual(
  misleadingExports,
  [],
  `aiProvider.ts must not export startup-named live probes: ${misleadingExports.join(", ")}`,
);

const fixtureDir = await mkdtemp(join(tmpdir(), "ai-provider-startup-contract-"));
try {
  const boundaryStubPath = join(fixtureDir, "provider-boundary-stub.mjs");
  const bundlePath = join(fixtureDir, "aiProvider.mjs");

  await writeFile(
    boundaryStubPath,
    `globalThis.__providerSafety = {
  clientBuilds: 0,
  registryReads: 0,
  networkCalls: 0,
};

export const adminPreferencesTable = {};
export const db = {
  select() {
    throw new Error("database work occurred while importing aiProvider.ts");
  },
};
export function eq() {
  throw new Error("database predicate construction occurred while importing aiProvider.ts");
}
export const POE_MODEL_REGISTRY_VERSION = "test";
export function createPoeChatCompletionWithSettlement() {
  throw new Error("Poe completion work occurred while importing aiProvider.ts");
}
export function getPoeClient() {
  globalThis.__providerSafety.clientBuilds += 1;
  throw new Error("Poe client construction occurred while importing aiProvider.ts");
}
export function getPoeModelRegistry() {
  globalThis.__providerSafety.registryReads += 1;
  throw new Error("Poe registry work occurred while importing aiProvider.ts");
}
export function getPoeRegistryModel() {
  throw new Error("Poe registry lookup occurred while importing aiProvider.ts");
}
export function resetPoeClient() {
  throw new Error("Poe client reset occurred while importing aiProvider.ts");
}
export const logger = {
  warn() {
    throw new Error("logger work occurred while importing aiProvider.ts");
  },
};
export default class OpenAI {
  constructor() {
    globalThis.__providerSafety.clientBuilds += 1;
    throw new Error("OpenAI client construction occurred while importing aiProvider.ts");
  }
}
`,
    "utf8",
  );

  await build({
    bundle: true,
    entryPoints: [fileURLToPath(providerPath)],
    format: "esm",
    outfile: bundlePath,
    platform: "node",
    target: "node24",
    plugins: [
      {
        name: "mock-provider-boundaries",
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /.*/ }, (args) =>
            args.importer ? { path: boundaryStubPath } : undefined,
          );
        },
      },
    ],
  });

  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
for (const name of [
  "AI_PROVIDER",
  "POE_API_KEY2",
  "AI_INTEGRATIONS_OPENAI_API_KEY",
  "AI_INTEGRATIONS_OPENAI_BASE_URL",
]) delete process.env[name];
globalThis.fetch = () => {
  globalThis.__providerSafety.networkCalls += 1;
  throw new Error("network activity occurred while importing aiProvider.ts");
};
const provider = await import(${JSON.stringify(pathToFileURL(bundlePath).href)});
if (provider.getProvider() !== "poe") {
  throw new Error("aiProvider.ts did not safely initialize its default provider");
}
if (globalThis.__providerSafety.clientBuilds !== 0) {
  throw new Error("aiProvider.ts constructed a provider client during import");
}
if (globalThis.__providerSafety.registryReads !== 0) {
  throw new Error("aiProvider.ts performed registry work during import");
}
if (globalThis.__providerSafety.networkCalls !== 0) {
  throw new Error("aiProvider.ts performed network work during import");
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
      "aiProvider.ts must import safely without optional provider configuration",
      child.stdout,
      child.stderr,
    ]
      .filter(Boolean)
      .join("\n"),
  );
} finally {
  await rm(fixtureDir, { recursive: true, force: true });
}

console.log("AI provider startup export contract passed.");