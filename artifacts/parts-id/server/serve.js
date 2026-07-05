/**
 * Standalone production server for Expo static builds.
 *
 * Serves the output of build.js (static-build/) with two special routes:
 * - GET / or /manifest with expo-platform header → platform manifest JSON
 * - GET / without expo-platform → landing page HTML
 * Everything else falls through to static file serving from ./static-build/.
 *
 * Zero external dependencies — uses only Node.js built-ins (http, fs, path).
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const STATIC_ROOT = path.resolve(__dirname, "..", "static-build");
const TEMPLATE_PATH = path.resolve(__dirname, "templates", "landing-page.html");
const basePath = (process.env.BASE_PATH || "/").replace(/\/+$/, "");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".map": "application/json",
};

function getAppName() {
  try {
    const appJsonPath = path.resolve(__dirname, "..", "app.json");
    const appJson = JSON.parse(fs.readFileSync(appJsonPath, "utf-8"));
    return appJson.expo?.name || "App Landing Page";
  } catch {
    return "App Landing Page";
  }
}

function serveManifest(platform, res) {
  const manifestPath = path.join(STATIC_ROOT, platform, "manifest.json");

  if (!fs.existsSync(manifestPath)) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ error: `Manifest not found for platform: ${platform}` }),
    );
    return;
  }

  const manifest = fs.readFileSync(manifestPath, "utf-8");
  res.writeHead(200, {
    "content-type": "application/json",
    "expo-protocol-version": "1",
    "expo-sfv-version": "0",
  });
  res.end(manifest);
}

function serveLandingPage(req, res, landingPageTemplate, appName) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const protocol = forwardedProto || "https";
  const host = req.headers["x-forwarded-host"] || req.headers["host"];
  const baseUrl = `${protocol}://${host}`;
  const expsUrl = `${host}`;

  const html = landingPageTemplate
    .replace(/BASE_URL_PLACEHOLDER/g, baseUrl)
    .replace(/EXPS_URL_PLACEHOLDER/g, expsUrl)
    .replace(/APP_NAME_PLACEHOLDER/g, appName);

  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

const WEB_ROOT = path.join(STATIC_ROOT, "web");

function serveFile(filePath, res) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  res.writeHead(200, { "content-type": contentType });
  res.end(fs.readFileSync(filePath));
}

/**
 * Serve a browser request from the Expo web build (static-build/web/).
 * Falls through to native static files (for Expo Go asset downloads),
 * then falls back to the Expo Go landing page if no web build exists.
 */
function serveWebOrFallback(urlPath, req, res, landingPageTemplate, appName) {
  const safePath = path.normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, "");
  const webIndexPath = path.join(WEB_ROOT, "index.html");

  // 1. Exact match in web build directory
  if (fs.existsSync(webIndexPath)) {
    const webFilePath = path.join(WEB_ROOT, safePath);
    if (
      webFilePath.startsWith(WEB_ROOT) &&
      fs.existsSync(webFilePath) &&
      fs.statSync(webFilePath).isFile()
    ) {
      return serveFile(webFilePath, res);
    }
  }

  // 2. Native static files — checked BEFORE SPA fallback so Expo Go bundle/asset
  //    requests (which lack expo-platform headers) are served correctly even when
  //    a web build exists.
  const staticFilePath = path.join(STATIC_ROOT, safePath);
  if (
    staticFilePath.startsWith(STATIC_ROOT) &&
    fs.existsSync(staticFilePath) &&
    fs.statSync(staticFilePath).isFile()
  ) {
    return serveFile(staticFilePath, res);
  }

  // 3. SPA fallback — serve index.html for client-side routes
  if (fs.existsSync(webIndexPath)) {
    return serveFile(webIndexPath, res);
  }

  // 4. No web build — show Expo Go landing page
  serveLandingPage(req, res, landingPageTemplate, appName);
}

const landingPageTemplate = fs.readFileSync(TEMPLATE_PATH, "utf-8");
const appName = getAppName();

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  let pathname = url.pathname;

  if (basePath && pathname.startsWith(basePath)) {
    pathname = pathname.slice(basePath.length) || "/";
  }

  // Native Expo Go manifest requests always take priority
  const platform = req.headers["expo-platform"];
  if ((platform === "ios" || platform === "android") &&
      (pathname === "/" || pathname === "/manifest")) {
    return serveManifest(platform, res);
  }

  serveWebOrFallback(pathname, req, res, landingPageTemplate, appName);
});

const port = parseInt(process.env.PORT || "3000", 10);

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[serve] Port ${port} is already in use. ` +
        `Kill the process holding it (fuser -k ${port}/tcp) and retry.`,
    );
  } else {
    console.error(`[serve] Server error:`, err);
  }
  process.exit(1);
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Serving static Expo build on port ${port}`);
});
