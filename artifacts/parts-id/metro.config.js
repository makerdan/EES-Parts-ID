const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const config = getDefaultConfig(__dirname);

// Watch only the lib packages that Parts ID actually imports so Metro can
// resolve pnpm symlinks whose real paths live outside projectRoot without
// indexing unrelated artifacts or build output as the monorepo grows.
// If a new @workspace/* dependency is added here, add its lib dir below.
const libRoot = path.resolve(__dirname, "../../lib");
const watchedLibs = [
  path.join(libRoot, "api-client-react"),
  path.join(libRoot, "zone-validation"),
];
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
