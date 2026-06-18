const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const config = getDefaultConfig(__dirname);

// Watch the entire monorepo so Metro can resolve pnpm symlinks whose real
// paths (e.g. lib/api-client-react/, lib/zone-validation/) live outside the
// projectRoot (artifacts/parts-id). Without this, HMR triggers a SHA-1 crash
// whenever those packages change.
const workspaceRoot = path.resolve(__dirname, "../..");
config.watchFolders = [...(config.watchFolders ?? []), workspaceRoot];

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
