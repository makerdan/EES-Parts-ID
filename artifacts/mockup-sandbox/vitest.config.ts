import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

function mockSvgRawPlugin() {
  return {
    name: "mock-svg-raw",
    enforce: "pre" as const,
    load(id: string): string | undefined {
      if (/\.svg\?raw($|&)/.test(id)) {
        return `export default "<svg xmlns='http://www.w3.org/2000/svg'></svg>"`;
      }
      return undefined;
    },
  };
}

export default defineConfig({
  plugins: [react(), mockSvgRawPlugin()],
  resolve: {
    alias: {
      "@": path.resolve("./src"),
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["src/test-setup.ts"],
  },
});
