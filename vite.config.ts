import { defineConfig } from "vite";

// Builds the unprivileged UI (ui/) into the add-on; plugin/ is bundled separately by esbuild (scripts/build.sh).
export default defineConfig({
  root: "ui",
  base: "./",
  build: {
    target: "firefox115",
    outDir: "../build/addon/content/ui",
    emptyOutDir: true,
    modulePreload: false,
  },
});
