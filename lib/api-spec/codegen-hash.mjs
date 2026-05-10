#!/usr/bin/env node
/**
 * Spec-hash utility for the API codegen workflow.
 *
 * write — after `orval` runs, compute sha256(openapi.yaml) and write it into
 *         each generated directory so the hash travels with the generated files.
 *
 * check — read the stored hash from each generated directory and compare it
 *         against the current openapi.yaml; exit 1 if any hash is missing or
 *         does not match (spec changed since last `pnpm codegen` run).
 *
 * Usage (from lib/api-spec/):
 *   node ./codegen-hash.mjs write   # called by codegen:only after orval
 *   node ./codegen-hash.mjs check   # called by root codegen:check in typecheck
 */
import { createHash } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..', '..');

const SPEC_PATH = resolve(__dirname, 'openapi.yaml');
const HASH_FILENAME = '.spec-hash';

/** Directories that contain orval-generated files. */
const GENERATED_DIRS = [
  resolve(root, 'lib', 'api-client-react', 'src', 'generated'),
  resolve(root, 'lib', 'api-zod', 'src', 'generated'),
];

function hashSpec() {
  return createHash('sha256').update(readFileSync(SPEC_PATH)).digest('hex');
}

const [, , mode] = process.argv;

if (mode === 'write') {
  const hash = hashSpec();
  for (const dir of GENERATED_DIRS) {
    writeFileSync(resolve(dir, HASH_FILENAME), hash + '\n');
  }
  console.log(`spec-hash written (${hash.slice(0, 12)}…)`);
} else if (mode === 'check') {
  const current = hashSpec();
  let stale = false;

  for (const dir of GENERATED_DIRS) {
    const hashFile = resolve(dir, HASH_FILENAME);
    let stored;
    try {
      stored = readFileSync(hashFile, 'utf8').trim();
    } catch {
      console.error(`✗ ${hashFile} not found — run \`pnpm codegen\` to generate.`);
      stale = true;
      continue;
    }
    if (stored !== current) {
      console.error(`✗ ${dir} is stale — openapi.yaml changed since last \`pnpm codegen\` run.`);
      stale = true;
    }
  }

  if (stale) {
    console.error('\nRun `pnpm codegen` then commit the updated generated files.');
    process.exit(1);
  }
  console.log('✓ Generated API client is up to date with openapi.yaml.');
} else {
  console.error('Usage: codegen-hash.mjs [write|check]');
  process.exit(1);
}
