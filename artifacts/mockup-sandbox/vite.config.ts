import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "fs";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";
import { mockupPreviewPlugin } from "./mockupPreviewPlugin";

const rawPort = process.env.PORT;

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH;

if (!basePath) {
  throw new Error(
    "BASE_PATH environment variable is required but was not provided.",
  );
}

const portRegistry = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "../../scripts/dev-ports.json"), "utf8"),
) as { workflowPorts?: { api?: number } };

// Target for the /api proxy. Override via VITE_API_SERVER env var if the API
// server is running on a different port or host in your dev environment. The
// registry fallback is explicit and stays aligned with the workflow contract.
const apiPort = portRegistry.workflowPorts?.api;
if (!Number.isInteger(apiPort)) {
  throw new Error("Port registry is missing workflowPorts.api");
}
const apiServerTarget =
  process.env.VITE_API_SERVER ?? `http://localhost:${apiPort}`;

// Proxy config shared between the dev server and `vite preview`.
// Forwards every /api/** request to the API server so that Clerk session
// cookies are sent to the same origin and admin endpoints are reachable.
const apiProxy = {
  "/api": {
    target: apiServerTarget,
    changeOrigin: true,
    secure: false,
    // Rewrite Set-Cookie domain so Clerk session cookies are not dropped when
    // Vite rewrites the response from the API server back to the browser.
    cookieDomainRewrite: "",
  },
};

export default defineConfig({
  base: basePath,
  plugins: [
    mockupPreviewPlugin(),
    react(),
    tailwindcss({ optimize: false }),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
    },
    proxy: apiProxy,
  },
  preview: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    proxy: apiProxy,
  },
});
