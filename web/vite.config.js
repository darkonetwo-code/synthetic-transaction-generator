import { defineConfig } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: "./",
  server: {
    port: 5173,
    host: true,
    fs: { allow: [path.resolve(dir, "..")] },
  },
  preview: {
    port: 4173,
    host: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
