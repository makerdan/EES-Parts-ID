const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { findMissingDirectives } = require("./check-react-compiler-directives");

let metroProcess = null;

const projectRoot = path.resolve(__dirname, "..");

function findWorkspaceRoot(startDir) {
  let dir = startDir;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error("Could not find workspace root (no pnpm-workspace.yaml found)");
}

const workspaceRoot = findWorkspaceRoot(projectRoot);
const basePath = (process.env.BASE_PATH || "/").replace(/\/+$/, "");
const devPorts = JSON.parse(
  fs.readFileSync(path.join(workspaceRoot, "scripts", "dev-ports.json"), "utf8"),
);
const metroPort = Number(
  process.env.METRO_PORT || process.env.PORT || devPorts.workflowPorts?.expo,
);
if (!Number.isInteger(metroPort) || metroPort <= 0 || metroPort > 65535) {
  throw new Error("A valid METRO_PORT, PORT, or registered Expo workflow port is required");
}

function exitWithError(message) {
  console.error(message);
  if (metroProcess) {
    metroProcess.kill();
  }
  process.exit(1);
}

function setupSignalHandlers() {
  const cleanup = () => {
    if (metroProcess) {
      console.log("Cleaning up Metro process...");
      metroProcess.kill();
    }
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("SIGHUP", cleanup);
}

function stripProtocol(domain) {
  let urlString = domain.trim();

  if (!/^https?:\/\//i.test(urlString)) {
    urlString = `https://${urlString}`;
  }

  return new URL(urlString).host;
}

function getDeploymentDomain() {
  if (process.env.REPLIT_INTERNAL_APP_DOMAIN) {
    return stripProtocol(process.env.REPLIT_INTERNAL_APP_DOMAIN);
  }

  if (process.env.REPLIT_DEV_DOMAIN) {
    const devDomain = stripProtocol(process.env.REPLIT_DEV_DOMAIN);
    const warning =
      `[Build Guard] WARNING: Baking a dev domain into the build.\n` +
      `  Domain: ${devDomain}\n` +
      `  REPLIT_INTERNAL_APP_DOMAIN was not set, so the preview-only *.replit.dev\n` +
      `  domain is being used instead. This domain is access-controlled and will\n` +
      `  reject API calls from the deployed app — users will see auth and API failures.\n` +
      `  To fix: ensure REPLIT_INTERNAL_APP_DOMAIN is set before building for production.`;
    if (process.env.NODE_ENV === "production") {
      exitWithError(warning);
    }
    console.warn(warning);
    return devDomain;
  }

  if (process.env.EXPO_PUBLIC_DOMAIN) {
    return stripProtocol(process.env.EXPO_PUBLIC_DOMAIN);
  }

  console.error(
    "ERROR: No deployment domain found. Set REPLIT_INTERNAL_APP_DOMAIN, REPLIT_DEV_DOMAIN, or EXPO_PUBLIC_DOMAIN",
  );
  process.exit(1);
}

// Resolve the Clerk Frontend API proxy URL that gets baked into the build.
// A production Clerk instance (pk_live_…) requires Frontend API traffic to be
// routed through the app's own domain via the API server's /api/__clerk proxy.
// When a live key is in use and no explicit proxy URL is set, default it to
// https://<deployment-domain>/api/__clerk so production builds are not shipped
// with a broken auth config. Test keys (pk_test_…) and local dev are left
// untouched — Clerk proxying only applies to production instances.
function resolveClerkProxyUrl(domain) {
  const explicit = process.env.EXPO_PUBLIC_CLERK_PROXY_URL;
  if (explicit) {
    return explicit;
  }

  const publishableKey =
    process.env.CLERK_PUBLISHABLE_KEY ||
    process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ||
    "";

  if (publishableKey.startsWith("pk_live_") && domain) {
    const derived = `https://${stripProtocol(domain)}/api/__clerk`;
    console.log(
      `Deriving EXPO_PUBLIC_CLERK_PROXY_URL=${derived} (production Clerk key detected)`,
    );
    return derived;
  }

  return "";
}

// Guard against shipping a production build with a broken Clerk auth config.
// A production Clerk instance (pk_live_…) requires the Frontend API to be
// proxied through the app's own domain; if EXPO_PUBLIC_CLERK_PROXY_URL ends up
// empty, ClerkLoaded never resolves and the web app renders a permanent blank
// screen with no error. This inspects the ACTUAL values baked into the env
// passed to Metro/web export (not the raw process.env) and returns an error
// message when the combination is unsafe, or null when it is fine. Kept pure
// (returns a string/null instead of exiting) so it can be unit-tested.
function getClerkAuthConfigError(publishableKey, proxyUrl) {
  const key = publishableKey || "";
  const proxy = proxyUrl || "";

  if (!key) {
    return (
      "[Build Guard] Clerk publishable key is missing: EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY " +
      "(or CLERK_PUBLISHABLE_KEY) is empty or not set. Without a publishable key " +
      "ClerkLoaded never resolves and the app will render a blank screen. Set a valid " +
      "pk_test_… or pk_live_… key before building."
    );
  }

  if (!key.startsWith("pk_test_") && !key.startsWith("pk_live_")) {
    return (
      "[Build Guard] Clerk publishable key is malformed: the key does not start with " +
      '"pk_test_" or "pk_live_". A placeholder, typo, or wrong environment variable was ' +
      "baked into the build. ClerkLoaded will never resolve and the app will render a " +
      "blank screen. Set a valid pk_test_… or pk_live_… key before building."
    );
  }

  if (key.startsWith("pk_live_") && !proxy) {
    return (
      "[Build Guard] Production Clerk auth config is broken: a live publishable " +
      "key (pk_live_…) is baked into the build but EXPO_PUBLIC_CLERK_PROXY_URL is " +
      "empty. Clerk requires production Frontend API traffic to be proxied through " +
      "the app's own domain, so ClerkLoaded will never resolve and the app will " +
      "render a blank screen. Ensure a deployment domain is available (so the proxy " +
      "URL can be auto-derived) or set EXPO_PUBLIC_CLERK_PROXY_URL explicitly."
    );
  }

  return null;
}

function prepareDirectories(timestamp) {
  console.log("Preparing build directories...");

  const staticBuild = path.join(projectRoot, "static-build");
  if (fs.existsSync(staticBuild)) {
    fs.rmSync(staticBuild, { recursive: true });
  }

  const dirs = [
    path.join(staticBuild, timestamp, "_expo", "static", "js", "ios"),
    path.join(staticBuild, timestamp, "_expo", "static", "js", "android"),
    path.join(staticBuild, "ios"),
    path.join(staticBuild, "android"),
  ];

  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }

  console.log("Build:", timestamp);
}

function clearMetroCache() {
  console.log("Clearing Metro cache...");

  const cacheDirs = [
    path.join(projectRoot, ".metro-cache"),
    path.join(projectRoot, "node_modules/.cache/metro"),
  ];

  for (const dir of cacheDirs) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log("Cache cleared");
}

async function checkMetroHealth() {
  try {
    const response = await fetch(`http://localhost:${metroPort}/status`, {
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function getExpoPublicReplId() {
  return process.env.REPL_ID || process.env.EXPO_PUBLIC_REPL_ID;
}

// Expo's public env convention is an allowlist, not a license to pass server
// credentials into a client build. Metro still needs the inherited process
// environment for its toolchain, so remove all server-only and unknown public
// variables before starting it.
const SERVER_ONLY_ENV_VARS = [
  "DATABASE_URL",
  "DATABASE_ENV",
  "AI_PROVIDER",
  "CORS_ALLOWED_ORIGINS",
  "CLERK_PUBLISHABLE_KEY",
  "CLERK_SECRET_KEY",
  "AI_INTEGRATIONS_GEMINI_API_KEY",
  "AI_INTEGRATIONS_GEMINI_BASE_URL",
  "AI_INTEGRATIONS_OPENAI_API_KEY",
  "AI_INTEGRATIONS_OPENAI_BASE_URL",
  "POE_API_KEY2",
  "DEFAULT_OBJECT_STORAGE_BUCKET_ID",
  "PRIVATE_OBJECT_DIR",
  "SESSION_SECRET",
];

const CLIENT_PUBLIC_ENV_VARS = new Set([
  "EXPO_PUBLIC_API_BASE",
  "EXPO_PUBLIC_APP_URL",
  "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "EXPO_PUBLIC_CLERK_PROXY_URL",
  "EXPO_PUBLIC_DOMAIN",
  "EXPO_PUBLIC_REPL_ID",
]);

async function startMetro(expoPublicDomain, expoPublicReplId) {
  const isRunning = await checkMetroHealth();
  if (isRunning) {
    console.log("Metro already running");
    return;
  }

  console.log("Starting Metro...");
  console.log(`Setting EXPO_PUBLIC_DOMAIN=${expoPublicDomain}`);
  const env = {
    ...process.env,
    EXPO_PUBLIC_DOMAIN: expoPublicDomain,
    EXPO_PUBLIC_REPL_ID: expoPublicReplId,
    EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.CLERK_PUBLISHABLE_KEY || process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY || "",
    EXPO_PUBLIC_CLERK_PROXY_URL: resolveClerkProxyUrl(expoPublicDomain),
    NODE_OPTIONS: "--max-old-space-size=4096",
  };
  for (const name of SERVER_ONLY_ENV_VARS) {
    delete env[name];
  }
  for (const name of Object.keys(env)) {
    if (name.startsWith("EXPO_PUBLIC_") && !CLIENT_PUBLIC_ENV_VARS.has(name)) {
      delete env[name];
    }
  }

  const clerkError = getClerkAuthConfigError(
    env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY,
    env.EXPO_PUBLIC_CLERK_PROXY_URL,
  );
  if (clerkError) {
    exitWithError(clerkError);
  }

  if (expoPublicReplId) {
    console.log(`Setting EXPO_PUBLIC_REPL_ID=${expoPublicReplId}`);
  }

  metroProcess = spawn(
    "pnpm",
    [
      "exec",
      "expo",
      "start",
      "--no-dev",
      "--minify",
      "--localhost",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
      cwd: projectRoot,
      env,
    },
  );

  if (metroProcess.stdout) {
    metroProcess.stdout.on("data", (data) => {
      const output = data.toString().trim();
      if (output) console.log(`[Metro] ${output}`);
    });
  }
  if (metroProcess.stderr) {
    metroProcess.stderr.on("data", (data) => {
      const output = data.toString().trim();
      if (output) console.error(`[Metro Error] ${output}`);
    });
  }

  for (let i = 0; i < 60; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const healthy = await checkMetroHealth();
    if (healthy) {
      console.log("Metro ready");
      return;
    }
  }

  console.error("Metro timeout");
  process.exit(1);
}

async function downloadFile(url, outputPath) {
  const controller = new AbortController();
  const fiveMinMS = 5 * 60 * 1_000;
  const timeoutId = setTimeout(() => controller.abort(), fiveMinMS);

  try {
    console.log(`Downloading: ${url}`);
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) {
      let errorBody = "";
      try {
        errorBody = await response.text();
        if (errorBody.length > 3000) errorBody = errorBody.slice(0, 3000) + "…";
      } catch {}
      if (errorBody) {
        console.error(`[Metro Error Body] ${errorBody}`);
      }
      throw new Error(`HTTP ${response.status}`);
    }

    const file = fs.createWriteStream(outputPath);
    await pipeline(Readable.fromWeb(response.body), file);

    const fileSize = fs.statSync(outputPath).size;

    if (fileSize === 0) {
      fs.unlinkSync(outputPath);
      throw new Error("Downloaded file is empty");
    }
  } catch (error) {
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }

    if (error.name === "AbortError") {
      throw new Error(`Download timeout after 5m: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function downloadBundle(platform, timestamp) {
  const entryPath = path.resolve(projectRoot, "node_modules", "expo-router", "entry");
  const bundlePath = path.relative(workspaceRoot, entryPath);
  const url = new URL(`http://localhost:${metroPort}/${bundlePath}.bundle`);
  url.searchParams.set("platform", platform);
  url.searchParams.set("dev", "false");
  url.searchParams.set("hot", "false");
  url.searchParams.set("lazy", "false");
  url.searchParams.set("minify", "true");

  const output = path.join(
    "static-build",
    timestamp,
    "_expo",
    "static",
    "js",
    platform,
    "bundle.js",
  );

  console.log(`Fetching ${platform} bundle...`);
  await downloadFile(url.toString(), output);
  console.log(`${platform} bundle ready`);
}

async function downloadManifest(platform) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 300_000);

  try {
    console.log(`Fetching ${platform} manifest...`);
    const response = await fetch(`http://localhost:${metroPort}/manifest`, {
      headers: { "expo-platform": platform },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const manifest = await response.json();
    console.log(`${platform} manifest ready`);
    return manifest;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(
        `Manifest download timeout after 5m for platform: ${platform}`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function downloadBundlesAndManifests(timestamp) {
  console.log("Downloading bundles and manifests...");
  console.log("This may take several minutes for production builds...");

  try {
    // Bundles are sequential — Metro can't handle both platforms simultaneously
    // without stalling. Manifests are cheap and run in parallel after.
    await downloadBundle("ios", timestamp);
    await downloadBundle("android", timestamp);

    const [iosManifest, androidManifest] = await Promise.all([
      downloadManifest("ios"),
      downloadManifest("android"),
    ]);

    console.log("All downloads completed successfully");
    return { ios: iosManifest, android: androidManifest };
  } catch (error) {
    exitWithError(`Download failed: ${error.message}`);
  }
}

function extractAssets(timestamp) {
  const staticBuild = path.join(projectRoot, "static-build");
  const bundles = {
    ios: fs.readFileSync(
      path.join(staticBuild, timestamp, "_expo", "static", "js", "ios", "bundle.js"),
      "utf-8",
    ),
    android: fs.readFileSync(
      path.join(staticBuild, timestamp, "_expo", "static", "js", "android", "bundle.js"),
      "utf-8",
    ),
  };

  const assetsMap = new Map();
  const assetPattern =
    /httpServerLocation:"([^"]+)"[^}]*hash:"([^"]+)"[^}]*name:"([^"]+)"[^}]*type:"([^"]+)"/g;

  const extractFromBundle = (bundle, platform) => {
    for (const match of bundle.matchAll(assetPattern)) {
      const originalPath = match[1];
      const filename = match[3] + "." + match[4];

      const tempUrl = new URL(`http://localhost:${metroPort}${originalPath}`);
      const unstablePath = tempUrl.searchParams.get("unstable_path");

      if (!unstablePath) {
        throw new Error(`Asset missing unstable_path: ${originalPath}`);
      }

      const decodedPath = decodeURIComponent(unstablePath);
      const key = path.posix.join(decodedPath, filename);

      if (!assetsMap.has(key)) {
        const asset = {
          url: path.posix.join("/", decodedPath, filename),
          originalPath: originalPath,
          filename: filename,
          relativePath: decodedPath,
          hash: match[2],
          platforms: new Set(),
        };

        assetsMap.set(key, asset);
      }
      assetsMap.get(key).platforms.add(platform);
    }
  };

  extractFromBundle(bundles.ios, "ios");
  extractFromBundle(bundles.android, "android");

  return Array.from(assetsMap.values());
}

async function downloadAssets(assets, timestamp) {
  if (assets.length === 0) {
    return 0;
  }

  console.log("Copying assets...");
  let successCount = 0;
  const failures = [];

  const downloadPromises = assets.map(async (asset) => {
      const tempUrl = new URL(`http://localhost:${metroPort}${asset.originalPath}`);
    const unstablePath = tempUrl.searchParams.get("unstable_path");

    if (!unstablePath) {
      throw new Error(`Asset missing unstable_path: ${asset.originalPath}`);
    }

    const decodedPath = decodeURIComponent(unstablePath);

    const outputDir = path.join(
      projectRoot,
      "static-build",
      timestamp,
      "_expo",
      "static",
      "js",
      asset.relativePath,
    );
    fs.mkdirSync(outputDir, { recursive: true });
    const output = path.join(outputDir, asset.filename);

    try {
      const candidates = [
        path.join(projectRoot, decodedPath, asset.filename),
        path.join(workspaceRoot, decodedPath, asset.filename),
      ];
      const found = candidates.find((p) => fs.existsSync(p));
      if (!found) {
        throw new Error(`Asset not found on disk: ${asset.filename}`);
      }
      fs.copyFileSync(found, output);
      successCount++;
    } catch (error) {
      failures.push({
        filename: asset.filename,
        error: error.message,
        url: asset.originalPath,
      });
    }
  });

  await Promise.all(downloadPromises);

  if (failures.length > 0) {
    const errorMsg =
      `Failed to download ${failures.length} asset(s):\n` +
      failures
        .map((f) => `  - ${f.filename}: ${f.error} (${f.url})`)
        .join("\n");
    exitWithError(errorMsg);
  }

  console.log(`Copied ${successCount} assets`);
  return successCount;
}

function updateBundleUrls(timestamp, baseUrl) {
  const updateForPlatform = (platform) => {
    const bundlePath = path.join(
      projectRoot,
      "static-build",
      timestamp,
      "_expo",
      "static",
      "js",
      platform,
      "bundle.js",
    );
    let bundle = fs.readFileSync(bundlePath, "utf-8");

    bundle = bundle.replace(
      /httpServerLocation:"(\/[^"]+)"/g,
      (_match, capturedPath) => {
      const tempUrl = new URL(`http://localhost:${metroPort}${capturedPath}`);
        const unstablePath = tempUrl.searchParams.get("unstable_path");

        if (!unstablePath) {
          throw new Error(
            `Asset missing unstable_path in bundle: ${capturedPath}`,
          );
        }

        const decodedPath = decodeURIComponent(unstablePath);
        return `httpServerLocation:"${baseUrl}${basePath}/${timestamp}/_expo/static/js/${decodedPath}"`;
      },
    );

    fs.writeFileSync(bundlePath, bundle);
  };

  updateForPlatform("ios");
  updateForPlatform("android");
  console.log("Updated bundle URLs");
}

function updateManifests(manifests, timestamp, baseUrl, assetsByHash) {
  const updateForPlatform = (platform, manifest) => {
    if (!manifest.launchAsset || !manifest.extra) {
      exitWithError(`Malformed manifest for ${platform}`);
    }

    manifest.launchAsset.url = `${baseUrl}${basePath}/${timestamp}/_expo/static/js/${platform}/bundle.js`;
    manifest.launchAsset.key = `bundle-${timestamp}`;
    manifest.createdAt = new Date(
      Number(timestamp.split("-")[0]),
    ).toISOString();
    manifest.extra.expoClient.hostUri =
      baseUrl.replace("https://", "") + "/" + platform;
    manifest.extra.expoGo.debuggerHost =
      baseUrl.replace("https://", "") + "/" + platform;
    manifest.extra.expoGo.packagerOpts.dev = false;

    if (manifest.assets && manifest.assets.length > 0) {
      manifest.assets.forEach((asset) => {
        if (!asset.url) return;

        const hash = asset.hash;
        if (!hash) return;

        const assetInfo = assetsByHash.get(hash);
        if (!assetInfo) return;

        asset.url = `${baseUrl}${basePath}/${timestamp}/_expo/static/js/${assetInfo.relativePath}/${assetInfo.filename}`;
      });
    }

    fs.writeFileSync(
      path.join(projectRoot, "static-build", platform, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
  };

  updateForPlatform("ios", manifests.ios);
  updateForPlatform("android", manifests.android);
  console.log("Manifests updated");
}

/**
 * Guard against the React Compiler (babel-plugin-react-compiler) silently
 * crashing a Babel worker thread and causing Metro to return an opaque HTTP
 * 500.  Components over LINE_THRESHOLD lines must opt out of the compiler
 * with "use no memo" so the worker stays alive.
 *
 * Add "use no memo" as the FIRST statement inside the component function body
 * to silence this check for a specific component.
 */
function checkReactCompilerDirectives() {
  const SCAN_DIRS = [
    path.join(projectRoot, "app"),
    path.join(projectRoot, "components"),
  ];

  const missing = findMissingDirectives(SCAN_DIRS);

  if (missing.length > 0) {
    const lines = missing.map(
      (m) => `  ${path.relative(projectRoot, m.file)} (${m.lines} lines)`
    );
    console.error(
      "\n[Build Guard] React Compiler crash prevention:\n" +
      "The following large components are missing the \"use no memo\" directive.\n" +
      "Add `\"use no memo\";` as the first statement inside each component function body\n" +
      "to prevent babel-plugin-react-compiler from crashing the Metro Babel worker thread.\n\n" +
      lines.join("\n") + "\n"
    );
    process.exit(1);
  }

  console.log(`[Build Guard] React Compiler directive check passed (${SCAN_DIRS.length} dirs scanned).`);
}

async function main() {
  console.log("Building static Expo Go deployment...");

  setupSignalHandlers();
  checkReactCompilerDirectives();

  const domain = getDeploymentDomain();
  const expoPublicReplId = getExpoPublicReplId();
  const baseUrl = `https://${domain}`;
  const timestamp = `${Date.now()}-${process.pid}`;

  prepareDirectories(timestamp);
  clearMetroCache();

  await startMetro(domain, expoPublicReplId);

  const downloadTimeout = 600000;
  const downloadPromise = downloadBundlesAndManifests(timestamp);
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      reject(
        new Error(
          `Overall download timeout after ${downloadTimeout / 1000} seconds. ` +
            "Metro may be struggling to generate bundles. Check Metro logs above.",
        ),
      );
    }, downloadTimeout);
  });

  const manifests = await Promise.race([downloadPromise, timeoutPromise]);

  console.log("Processing assets...");
  const assets = extractAssets(timestamp);
  console.log("Found", assets.length, "unique asset(s)");

  const assetsByHash = new Map();
  for (const asset of assets) {
    assetsByHash.set(asset.hash, {
      relativePath: asset.relativePath,
      filename: asset.filename,
    });
  }

  const assetCount = await downloadAssets(assets, timestamp);

  if (assetCount > 0) {
    updateBundleUrls(timestamp, baseUrl);
  }

  verifyNativeBundleDomain(domain, timestamp);

  console.log("Updating manifests and creating landing page...");
  updateManifests(manifests, timestamp, baseUrl, assetsByHash);

  if (metroProcess) {
    metroProcess.kill();
    metroProcess = null;
  }

  await buildWeb(domain, expoPublicReplId);

  console.log("Build complete! Deploy to:", baseUrl);
  process.exit(0);
}

async function buildWeb(domain, expoPublicReplId) {
  console.log("Building web bundle...");
  console.log(`Setting EXPO_PUBLIC_DOMAIN=${domain} for web build`);

  const webOutDir = path.join(projectRoot, "static-build", "web");
  if (fs.existsSync(webOutDir)) {
    fs.rmSync(webOutDir, { recursive: true });
  }

  const env = {
    ...process.env,
    EXPO_PUBLIC_DOMAIN: domain,
    EXPO_PUBLIC_REPL_ID: expoPublicReplId || "",
    EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.CLERK_PUBLISHABLE_KEY || process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY || "",
    EXPO_PUBLIC_CLERK_PROXY_URL: resolveClerkProxyUrl(domain),
    NODE_OPTIONS: "--max-old-space-size=4096",
  };

  const clerkError = getClerkAuthConfigError(
    env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY,
    env.EXPO_PUBLIC_CLERK_PROXY_URL,
  );
  if (clerkError) {
    exitWithError(clerkError);
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(
      "pnpm",
      ["exec", "expo", "export", "--platform", "web", "--output-dir", webOutDir],
      {
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
        cwd: projectRoot,
        env,
      },
    );

    proc.stdout?.on("data", (data) => {
      const output = data.toString().trim();
      if (output) console.log(`[Web] ${output}`);
    });
    proc.stderr?.on("data", (data) => {
      const output = data.toString().trim();
      if (output) console.error(`[Web Error] ${output}`);
    });

    proc.on("close", (code) => {
      if (code === 0) {
        console.log("Web build complete");
        try {
          verifyBundleDomain(domain, webOutDir);
        } catch (err) {
          reject(err);
          return;
        }
        resolve();
      } else {
        reject(new Error(`Web build failed with code ${code}`));
      }
    });

    proc.on("error", reject);
  });
}

// Scan the JS entry files in the web bundle output directory and assert that
// the baked-in domain matches what was intended and does NOT contain a
// .replit.dev dev-preview domain. Throws with a clear message if a violation
// is found. Exported so it can be unit-tested independently.
function verifyBundleDomain(domain, webOutDir) {
  const jsDir = path.join(webOutDir, "_expo", "static", "js", "web");

  if (!fs.existsSync(jsDir)) {
    console.warn(`[Build Guard] verifyBundleDomain: JS output dir not found (${jsDir}), skipping scan.`);
    return;
  }

  const jsFiles = fs.readdirSync(jsDir).filter((f) => f.endsWith(".js"));

  if (jsFiles.length === 0) {
    console.warn(`[Build Guard] verifyBundleDomain: No JS files found in ${jsDir}, skipping scan.`);
    return;
  }

  const devDomainPattern = /[a-z0-9-]+\.replit\.dev/g;
  const violations = [];
  let domainFound = false;

  for (const file of jsFiles) {
    const filePath = path.join(jsDir, file);
    const content = fs.readFileSync(filePath, "utf-8");

    if (content.includes(domain)) {
      domainFound = true;
    }

    const matches = [...content.matchAll(devDomainPattern)];
    for (const m of matches) {
      violations.push({ file, match: m[0] });
    }
  }

  if (violations.length > 0) {
    const lines = violations.map((v) => `  ${v.file}: "${v.match}"`).join("\n");
    throw new Error(
      `[Build Guard] Dev domain found in web bundle — build aborted.\n` +
      `  A *.replit.dev URL was baked into the finished JS bundle. This domain is\n` +
      `  access-controlled and will fail for users of the deployed app.\n` +
      `  Ensure REPLIT_INTERNAL_APP_DOMAIN is set so the correct production domain\n` +
      `  is used instead of the dev preview URL.\n\n` +
      `  Matches found:\n${lines}`
    );
  }

  if (!domainFound) {
    throw new Error(
      `[Build Guard] Expected domain not found in web bundle — build aborted.\n` +
      `  The intended domain "${domain}" does not appear anywhere in the finished\n` +
      `  JS bundle. This suggests the domain was not successfully baked into the\n` +
      `  build, which would cause API calls to fail at runtime.\n` +
      `  Check that EXPO_PUBLIC_DOMAIN was correctly set during the Expo web export.`
    );
  }

  console.log(`[Build Guard] Bundle domain check passed — domain "${domain}" present, no .replit.dev URLs found.`);
}

// Scan the native (iOS and Android) bundles for stale *.replit.dev occurrences.
// Called after downloadBundlesAndManifests() (and after updateBundleUrls(), if
// assets were present) so the bundles are fully written to disk. Throws with a
// clear message if a violation is found. Exported so it can be unit-tested.
function verifyNativeBundleDomain(domain, timestamp) {
  const platforms = ["ios", "android"];
  const staticBuild = path.join(projectRoot, "static-build");
  const devDomainPattern = /[a-z0-9-]+\.replit\.dev/g;
  const violations = [];
  let domainFound = false;

  for (const platform of platforms) {
    const bundlePath = path.join(
      staticBuild,
      timestamp,
      "_expo",
      "static",
      "js",
      platform,
      "bundle.js",
    );

    if (!fs.existsSync(bundlePath)) {
      console.warn(
        `[Build Guard] verifyNativeBundleDomain: bundle not found for ${platform} ` +
          `(${bundlePath}), skipping.`,
      );
      continue;
    }

    const content = fs.readFileSync(bundlePath, "utf-8");

    if (content.includes(domain)) {
      domainFound = true;
    }

    const matches = [...content.matchAll(devDomainPattern)];
    for (const m of matches) {
      violations.push({ platform, match: m[0] });
    }
  }

  if (violations.length > 0) {
    const lines = violations
      .map((v) => `  ${v.platform}/bundle.js: "${v.match}"`)
      .join("\n");
    throw new Error(
      `[Build Guard] Dev domain found in native bundle — build aborted.\n` +
        `  A *.replit.dev URL was baked into a native (iOS/Android) bundle. This domain\n` +
        `  is access-controlled and will fail for users of the deployed app.\n` +
        `  Ensure REPLIT_INTERNAL_APP_DOMAIN is set so the correct production domain\n` +
        `  is used instead of the dev preview URL.\n\n` +
        `  Matches found:\n${lines}`,
    );
  }

  if (!domainFound) {
    throw new Error(
      `[Build Guard] Expected domain not found in native bundles — build aborted.\n` +
        `  The intended domain "${domain}" does not appear in either the iOS or Android\n` +
        `  bundle. This suggests the domain was not successfully baked into the build,\n` +
        `  which would cause API calls to fail at runtime.\n` +
        `  Check that EXPO_PUBLIC_DOMAIN was correctly set when Metro started.`,
    );
  }

  console.log(
    `[Build Guard] Native bundle domain check passed — domain "${domain}" present, no .replit.dev URLs found.`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Build failed:", error.message);
    if (metroProcess) {
      metroProcess.kill();
    }
    process.exit(1);
  });
}

module.exports = {
  stripProtocol,
  resolveClerkProxyUrl,
  getClerkAuthConfigError,
  verifyBundleDomain,
  verifyNativeBundleDomain,
};
