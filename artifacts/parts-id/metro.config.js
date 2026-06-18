const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");
const fs = require("fs");

const config = getDefaultConfig(__dirname);

// Derive watchFolders from @workspace/* dependencies declared in package.json
// so Metro automatically tracks any lib package added as a dependency — no
// manual list to maintain.  The convention is @workspace/<name> → ../../lib/<name>.
const libRoot = path.resolve(__dirname, "../../lib");
const pkg = require("./package.json");
const allDeps = {
  ...pkg.dependencies,
  ...pkg.devDependencies,
};
const watchedLibs = Object.keys(allDeps)
  .filter((dep) => dep.startsWith("@workspace/"))
  .map((dep) => {
    const libName = dep.slice("@workspace/".length);
    const libPath = path.join(libRoot, libName);
    if (!fs.existsSync(libPath)) {
      console.warn(
        `[metro.config] WARNING: resolved path for ${dep} does not exist: ${libPath}`
      );
    }
    return libPath;
  })
  .filter((libPath) => fs.existsSync(libPath));
config.watchFolders = [...(config.watchFolders ?? []), ...watchedLibs];

// Allow bundling .svg files as static assets (used by SvgUri via expo-asset)
const { assetExts, sourceExts } = config.resolver;
config.resolver.assetExts = [...assetExts.filter(ext => ext !== "svg"), "svg"];
config.resolver.sourceExts = sourceExts.filter(ext => ext !== "svg");

// Polyfill Node.js built-ins that some packages (e.g. react-native-svg's
// fetchData.ts) import but that Metro does not provide by default.
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  buffer: require.resolve("buffer"),
};

// Force pdf-lib (and any subpath imports) to always resolve to its CJS build.
// Metro's dynamic import() picks up the "module" field (es/index.js) instead
// of "main" (cjs/index.js). The ES build does `import tslib from "tslib"` which
// resolves to a default import, but tslib v2 has no default export — causing:
//   "Cannot destructure property '__extends' of 'tslib.default' as it is undefined."
// The CJS build uses named requires and works correctly with tslib v2.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "pdf-lib") {
    return {
      filePath: require.resolve("pdf-lib/cjs/index.js"),
      type: "sourceFile",
    };
  }
  if (moduleName.startsWith("pdf-lib/") && !moduleName.startsWith("pdf-lib/cjs/")) {
    const subpath = moduleName.slice("pdf-lib/".length);
    return {
      filePath: require.resolve(`pdf-lib/cjs/${subpath}`),
      type: "sourceFile",
    };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
