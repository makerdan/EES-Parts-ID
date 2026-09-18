"use strict";

const fs = require("fs");
const path = require("path");
const { collectJavaScriptFiles, verifyBundleDomain } = require("./bundle-domain-check");

const BUILD_METADATA_FILENAME = "build-metadata.json";
const REQUIRED_FILES = [
  "web/index.html",
  "web/metadata.json",
  "ios/manifest.json",
  "android/manifest.json",
  BUILD_METADATA_FILENAME,
];
const REQUIRED_DIRECTORIES = ["web/_expo/static/js/web"];
const BUILD_METADATA_VERSION = 1;

function isDevelopmentMode(mode = process.env.PARTS_ID_SERVER_MODE) {
  return mode === "development" || (!mode && process.env.NODE_ENV === "development");
}

function nonEmptyFiles(staticRoot) {
  const empty = [];
  for (const relativePath of REQUIRED_FILES) {
    const filePath = path.join(staticRoot, relativePath);
    if (fs.existsSync(filePath) && fs.statSync(filePath).size === 0) {
      empty.push(relativePath);
    }
  }
  return empty;
}

function validateJsonFile(staticRoot, relativePath, invalid) {
  try {
    JSON.parse(fs.readFileSync(path.join(staticRoot, relativePath), "utf8"));
  } catch {
    invalid.push(relativePath);
  }
}

function preflightWebArtifact({ staticRoot, mode = process.env.PARTS_ID_SERVER_MODE } = {}) {
  if (!staticRoot) {
    throw new Error("[serve] Web artifact preflight requires a static root.");
  }
  if (isDevelopmentMode(mode)) {
    return { mode: "development", fallback: true };
  }

  const missing = REQUIRED_FILES.filter(
    (relativePath) => !fs.existsSync(path.join(staticRoot, relativePath)),
  );
  const missingDirectories = REQUIRED_DIRECTORIES.filter(
    (relativePath) => !fs.existsSync(path.join(staticRoot, relativePath)),
  );
  const empty = nonEmptyFiles(staticRoot);
  const invalid = [];
  let javascriptError = null;

  for (const relativePath of ["web/metadata.json", "ios/manifest.json", "android/manifest.json"]) {
    if (fs.existsSync(path.join(staticRoot, relativePath))) {
      validateJsonFile(staticRoot, relativePath, invalid);
    }
  }

  const javascriptRoot = path.join(staticRoot, "web/_expo/static/js/web");
  if (fs.existsSync(javascriptRoot)) {
    try {
      collectJavaScriptFiles(javascriptRoot);
      verifyBundleDomain({
        scanRoot: javascriptRoot,
        label: "web artifact",
      });
    } catch (error) {
      javascriptError = error.message;
    }
  }

  let buildMetadata = null;
  const metadataPath = path.join(staticRoot, BUILD_METADATA_FILENAME);
  if (fs.existsSync(metadataPath) && fs.statSync(metadataPath).size > 0) {
    try {
      buildMetadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    } catch {
      invalid.push(BUILD_METADATA_FILENAME);
    }
  }

  const stale = [];
  if (buildMetadata) {
    if (
      buildMetadata.version !== BUILD_METADATA_VERSION ||
      typeof buildMetadata.buildId !== "string" ||
      !buildMetadata.buildId ||
      typeof buildMetadata.builtAt !== "string" ||
      Number.isNaN(Date.parse(buildMetadata.builtAt)) ||
      buildMetadata.webEntry !== "web/index.html" ||
      !Array.isArray(buildMetadata.manifests) ||
      buildMetadata.manifests.length !== 2 ||
      !buildMetadata.manifests.includes("ios/manifest.json") ||
      !buildMetadata.manifests.includes("android/manifest.json")
    ) {
      invalid.push(BUILD_METADATA_FILENAME);
    } else {
      const markerMtime = fs.statSync(metadataPath).mtimeMs;
      for (const relativePath of ["web/index.html", "web/metadata.json", "ios/manifest.json", "android/manifest.json"]) {
        const artifactPath = path.join(staticRoot, relativePath);
        if (fs.existsSync(artifactPath) && fs.statSync(artifactPath).mtimeMs > markerMtime) {
          stale.push(relativePath);
        }
      }
    }
  }

  if (
    missing.length ||
    missingDirectories.length ||
    empty.length ||
    invalid.length ||
    stale.length ||
    javascriptError
  ) {
    const diagnostics = [];
    if (missing.length) diagnostics.push(`missing file(s): ${missing.join(", ")}`);
    if (missingDirectories.length) {
      diagnostics.push(`missing directory(ies): ${missingDirectories.join(", ")}`);
    }
    if (empty.length) diagnostics.push(`empty file(s): ${empty.join(", ")}`);
    if (invalid.length) diagnostics.push(`invalid build metadata/manifest(s): ${invalid.join(", ")}`);
    if (stale.length) diagnostics.push(`stale artifact(s) newer than build marker: ${stale.join(", ")}`);
    if (javascriptError) diagnostics.push(javascriptError);
    throw new Error(
      `[serve] Web artifact preflight failed for ${mode || "production"} mode:\n` +
        diagnostics.map((diagnostic) => `  - ${diagnostic}`).join("\n"),
    );
  }

  return { mode: mode || "production", fallback: false, buildMetadata };
}

function writeWebBuildMetadata({ staticRoot, buildId }) {
  if (!staticRoot || !buildId) {
    throw new Error("Cannot write web build metadata without a static root and build ID.");
  }
  const metadataPath = path.join(staticRoot, BUILD_METADATA_FILENAME);
  fs.writeFileSync(
    metadataPath,
    JSON.stringify(
      {
        version: BUILD_METADATA_VERSION,
        buildId,
        builtAt: new Date().toISOString(),
        webEntry: "web/index.html",
        manifests: ["ios/manifest.json", "android/manifest.json"],
      },
      null,
      2,
    ) + "\n",
  );
}

module.exports = {
  BUILD_METADATA_FILENAME,
  BUILD_METADATA_VERSION,
  REQUIRED_FILES,
  REQUIRED_DIRECTORIES,
  isDevelopmentMode,
  preflightWebArtifact,
  writeWebBuildMetadata,
};