#!/usr/bin/env node
"use strict";

const path = require("path");
const { verifyBundleDomain } = require("./bundle-domain-check");

const projectRoot = path.resolve(__dirname, "..");
const webOutDir = path.join(projectRoot, "static-build", "web");

function runBundleDomainCheck({
  scanRoot = process.env.BUNDLE_DOMAIN_SCAN_ROOT || webOutDir,
  expectedDomain =
    process.env.BUNDLE_EXPECTED_DOMAIN ||
    process.env.REPLIT_INTERNAL_APP_DOMAIN ||
    process.env.EXPO_PUBLIC_DOMAIN,
} = {}) {
  try {
    const result = verifyBundleDomain({
      scanRoot,
      expectedDomain,
      label: "web bundle",
    });
    console.log(
      `[bundle:domain-check] PASSED — scanned ${result.files.length} JS file(s), no forbidden domains found.`,
    );
    return result;
  } catch (error) {
    console.error(`[bundle:domain-check] FAILED — ${error.message}`);
    process.exitCode = 1;
    return null;
  }
}

if (require.main === module) {
  runBundleDomainCheck();
}

module.exports = { runBundleDomainCheck };
