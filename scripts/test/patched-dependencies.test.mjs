#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  checkPatchApplication,
  patchFileIntegrityErrors,
  parseExactPackageSpecifier,
  parsePatchedDependenciesLockfile,
  sha256,
} from "../check-patched-dependencies.mjs";

const at = String.fromCharCode(64);
const imageSizeSpecifier = `image-size${at}2.0.2`;
const imageSizePatchPath = `patches/${imageSizeSpecifier}.patch`;

assert.deepEqual(parseExactPackageSpecifier(imageSizeSpecifier), {
  name: "image-size",
  version: "2.0.2",
});
assert.deepEqual(parseExactPackageSpecifier("@scope/image-size@1.2.3-beta.1"), {
  name: "@scope/image-size",
  version: "1.2.3-beta.1",
});
assert.equal(parseExactPackageSpecifier("image-size@^2.0.2"), null);
assert.equal(parseExactPackageSpecifier("image-size"), null);

const lockEntries = parsePatchedDependenciesLockfile(`
patchedDependencies:
  ${imageSizeSpecifier}:
    hash: abc123
    path: ${imageSizePatchPath}

importers:
`);
assert.deepEqual(lockEntries.get(imageSizeSpecifier), {
  hash: "abc123",
  path: imageSizePatchPath,
});

const patch = readFileSync(resolve(imageSizePatchPath));
assert.equal(
  sha256(patch),
  "0e0dacbcc59dd86b9e840f5fd4a87111b3c8742b17ab1c957fc8027bb303fa5b",
);
assert.ok(patch.toString("utf8").endsWith("\n"), "tracked patch must preserve its final newline");

const fixture = mkdtempSync(join(tmpdir(), "patched-dependency-contract-"));
const sourcePath = join(fixture, "source.txt");
const patchPath = join(fixture, "source.patch");
const validPatch = `diff --git a/source.txt b/source.txt
--- a/source.txt
+++ b/source.txt
@@ -1,3 +1,3 @@
 alpha
-beta
+updated
 gamma
`;
try {
  writeFileSync(sourcePath, "alpha\nbeta\ngamma\n");
  writeFileSync(patchPath, validPatch);
  assert.deepEqual(checkPatchApplication(fixture, patchPath, "fixture@1.0.0"), []);

  writeFileSync(sourcePath, "changed\nbeta\ngamma\n");
  assert.match(
    checkPatchApplication(fixture, patchPath, "fixture@1.0.0").join("\n"),
    /context or end-of-file integrity drift detected/,
  );
  assert.match(
    patchFileIntegrityErrors("fixture@1.0.0", "patches/fixture.patch", validPatch.slice(0, -1)).join("\n"),
    /must end with a newline; the patch is truncated or corrupt/,
  );
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

console.log("PASS patched dependency validation helpers");