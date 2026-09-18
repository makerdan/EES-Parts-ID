#!/usr/bin/env node
/**
 * Keep the audited dependency floors and the intentional image-size
 * exception explicit. This contract reads manifests and the lockfile only;
 * published-package patch applicability is covered by the adjacent
 * patched-dependencies validation step.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parsePatchedDependenciesLockfile, sha256 } from "../check-patched-dependencies.mjs";

const root = resolve(".");
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const packageJson = readJson("package.json");
const apiPackage = readJson("artifacts/api-server/package.json");
const canvasPackage = readJson("artifacts/mockup-sandbox/package.json");
const lockfile = readFileSync(resolve(root, "pnpm-lock.yaml"), "utf8");

function versionTuple(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  assert.ok(match, `expected a concrete semver, got ${version}`);
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  const a = versionTuple(left);
  const b = versionTuple(right);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function packageVersions(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const versions = new Set();
  const pattern = new RegExp(
    `^  ['"]?${escaped}@([^:(\\n'"]+)(?:\\([^\\n]*\\))?['"]?:$`,
    "gm",
  );
  for (const match of lockfile.matchAll(pattern)) versions.add(match[1]);
  assert.ok(versions.size > 0, `${name} must have a lockfile resolution`);
  return [...versions];
}

function assertMinimum(name, minimum) {
  for (const version of packageVersions(name)) {
    assert.ok(
      compareVersions(version, minimum) >= 0,
      `${name}@${version} is below the safe minimum ${minimum}`,
    );
  }
}

assertMinimum("sharp", "0.35.4");
assertMinimum("js-yaml", "3.15.2");
assertMinimum("smol-toml", "1.7.1");
assertMinimum("vitest", "4.1.11");
assertMinimum("@vitest/mocker", "4.1.11");

assert.equal(apiPackage.dependencies.sharp, "^0.35.4");
assert.equal(canvasPackage.devDependencies.vitest, "^4.1.11");
assert.equal(canvasPackage.devDependencies["@vitest/coverage-v8"], "^4.1.11");
assert.equal(packageJson.pnpm.overrides["js-yaml@<3.15.2"], "3.15.2");
assert.equal(packageJson.pnpm.overrides["js-yaml@>=4.0.0 <4.3.2"], "4.3.2");
assert.equal(packageJson.pnpm.overrides["smol-toml"], ">=1.7.1");

const imageSizeSpecifier = ["image-size", "2.0.2"].join("@");
const imageSizePatchPath = ["patches/image-size", "2.0.2.patch"].join("@");
const minimatchSpecifier = ["minimatch", "3.1.5"].join("@");
const minimatchPatchPath = ["patches/minimatch", "3.1.5.patch"].join("@");
const expectedIgnoredAdvisories = ["GHSA-5p2g-fcmc-qvqq", "GHSA-w3rx-r6r6-pgpr"];
assert.deepEqual(packageJson.pnpm.patchedDependencies, {
  [imageSizeSpecifier]: imageSizePatchPath,
  [minimatchSpecifier]: minimatchPatchPath,
});
assert.deepEqual([...packageJson.pnpm.auditConfig.ignoreCves].sort(), expectedIgnoredAdvisories);
assert.equal(packageJson.pnpm.auditConfig.ignoreCves.length, expectedIgnoredAdvisories.length);

const patchedEntries = parsePatchedDependenciesLockfile(lockfile);
assert.deepEqual(patchedEntries.get(imageSizeSpecifier), {
  hash: sha256(readFileSync(resolve(root, imageSizePatchPath))),
  path: imageSizePatchPath,
});
assert.deepEqual(patchedEntries.get(minimatchSpecifier), {
  hash: sha256(readFileSync(resolve(root, minimatchPatchPath))),
  path: minimatchPatchPath,
});
assert.equal(patchedEntries.size, 2, "each approved patched package must remain one-to-one with its tracked patch");
assert.match(
  lockfile,
  /image-size@2\.0\.2\(patch_hash=[0-9a-f]+\):/,
  "the lockfile must retain the patched image-size snapshot",
);
assert.match(
  lockfile,
  /minimatch@3\.1\.5\(patch_hash=[0-9a-f]+\):/,
  "the lockfile must retain the patched minimatch snapshot",
);

console.log("Dependency security contract: safe resolutions and approved patches are aligned");