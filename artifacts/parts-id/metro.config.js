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

module.exports = config;
