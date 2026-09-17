import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    // Node 22+'s broken global localStorage stub and a system ffmpeg without libass are
    // environment defects, not product defects — the shims live in one place.
    setupFiles: ["./vitest.setup.ts"],
    // exclude node_modules, build artifacts (.next/standalone copies e2e in), and the Playwright e2e directory
    exclude: ["**/node_modules/**", "**/.next/**", "**/dist/**", "**/e2e/**"],
  },
});
