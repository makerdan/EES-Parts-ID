const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

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

const webBundleContactReplacements = [
  {
    value: ["support@", "clerk.com"].join(""),
    replacement: "support",
  },
  {
    value: `Nicolas Charpentier <${["nicolas.charpentier079@", "gmail.com"].join("")}>`,
    replacement: "",
  },
];

function sanitizeWebBundleSource(source) {
  return webBundleContactReplacements.reduce(
    (result, { value, replacement }) => result.split(value).join(replacement),
    source,
  );
}

function contentHashedFilename(filename, source) {
  const match = filename.match(/^(.*-)([0-9a-f]{32})(\.js)$/);
  if (!match) return filename;

  const hash = crypto.createHash("md5").update(source).digest("hex");
  return `${match[1]}${hash}${match[3]}`;
}

function rewriteArtifactReferences(artifacts, replacements) {
  const references = [...replacements.entries()].sort(
    ([oldName], [otherName]) => otherName.length - oldName.length,
  );

  for (const artifact of artifacts) {
    if (typeof artifact.source !== "string") continue;

    for (const [oldName, newName] of references) {
      artifact.source = artifact.source.split(oldName).join(newName);
    }
  }
}

const originalSerializer = config.serializer.customSerializer;
if (typeof originalSerializer === "function") {
  config.serializer.customSerializer = async (...args) => {
    const serialized = await originalSerializer(...args);

    const wasString = typeof serialized === "string";
    let bundle;
    try {
      bundle = wasString ? JSON.parse(serialized) : serialized;
    } catch {
      return serialized;
    }

    if (!bundle || !Array.isArray(bundle.artifacts)) {
      return serialized;
    }

    const isWebBundle = bundle.artifacts.some(
      (artifact) =>
        typeof artifact.filename === "string" &&
        artifact.filename.includes("static/js/web/"),
    );
    if (!isWebBundle) {
      return serialized;
    }

    const renamedFiles = new Map();
    for (const artifact of bundle.artifacts) {
      if (artifact.type !== "js" || typeof artifact.source !== "string") {
        continue;
      }

      artifact.source = sanitizeWebBundleSource(artifact.source);
      const nextFilename = contentHashedFilename(artifact.filename, artifact.source);
      if (nextFilename !== artifact.filename) {
        renamedFiles.set(artifact.filename, nextFilename);
        artifact.filename = nextFilename;
      }
    }

    for (const artifact of bundle.artifacts) {
      if (typeof artifact.filename !== "string") continue;

      const renamedSource = renamedFiles.get(artifact.filename);
      if (renamedSource) {
        artifact.filename = renamedSource;
      } else {
        for (const [oldName, newName] of renamedFiles) {
          if (artifact.filename === `${oldName}.map`) {
            artifact.filename = `${newName}.map`;
            break;
          }
        }
      }
    }

    rewriteArtifactReferences(bundle.artifacts, renamedFiles);
    return wasString ? JSON.stringify(bundle) : bundle;
  };
}

module.exports = config;
