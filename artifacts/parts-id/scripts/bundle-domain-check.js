"use strict";

const fs = require("fs");
const path = require("path");

const FORBIDDEN_DOMAIN_PATTERN = /[a-z0-9-]+\.replit\.dev/gi;

function collectJavaScriptFiles(scanRoot) {
  if (!fs.existsSync(scanRoot)) {
    throw new Error(
      `[Bundle Domain] JavaScript scan root not found: ${scanRoot}`,
    );
  }
  if (!fs.statSync(scanRoot).isDirectory()) {
    throw new Error(
      `[Bundle Domain] JavaScript scan root is not a directory: ${scanRoot}`,
    );
  }

  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(filePath);
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        files.push(filePath);
      }
    }
  }
  walk(scanRoot);

  if (files.length === 0) {
    throw new Error(
      `[Bundle Domain] No JavaScript inputs found under ${scanRoot}`,
    );
  }

  const emptyFiles = files.filter((filePath) => fs.statSync(filePath).size === 0);
  if (emptyFiles.length > 0) {
    throw new Error(
      `[Bundle Domain] Empty JavaScript input(s): ${emptyFiles
        .map((filePath) => path.relative(scanRoot, filePath))
        .join(", ")}`,
    );
  }

  return files;
}

/**
 * Validate the JavaScript inputs used by a bundle.
 *
 * expectedDomain is optional for the standalone scan because validation may
 * run without a deployment-domain environment variable. When supplied, the
 * same expected-domain assertion used by the build-integrated verifier is
 * enforced.
 */
function verifyBundleDomain({ scanRoot, expectedDomain, label = "bundle" }) {
  const files = collectJavaScriptFiles(scanRoot);
  const expected = expectedDomain?.trim();
  const violations = [];
  let domainFound = !expected;

  for (const filePath of files) {
    const rel = path.relative(scanRoot, filePath);
    const content = fs.readFileSync(filePath, "utf8");

    if (expected && content.includes(expected)) {
      domainFound = true;
    }

    for (const match of content.matchAll(FORBIDDEN_DOMAIN_PATTERN)) {
      violations.push({ file: rel, match: match[0] });
    }
  }

  if (violations.length > 0) {
    const lines = violations
      .map((violation) => `  ${violation.file}: "${violation.match}"`)
      .join("\n");
    throw new Error(
      `[Bundle Domain] Forbidden dev domain found in ${label}.\n` +
        `  A *.replit.dev URL was baked into the finished JavaScript bundle.\n` +
        `  Matches found:\n${lines}`,
    );
  }

  if (expected && !domainFound) {
    throw new Error(
      `[Bundle Domain] Expected domain not found in ${label}.\n` +
        `  The intended domain "${expected}" does not appear in the JavaScript inputs.`,
    );
  }

  return { files };
}

module.exports = {
  collectJavaScriptFiles,
  verifyBundleDomain,
};