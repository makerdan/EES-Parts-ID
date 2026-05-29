const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

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
