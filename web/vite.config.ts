import { defineConfig } from "vite";
import { resolve } from "node:path";

// The real knack artifacts (variant HTML, thumbnails, brand-review) live in the
// frozen prototype tree. Serve them at the web root for M1 so the mock-driven
// flow exercises the genuine artifacts without copying 18MB into web/.
// In M2+ these come from R2 via the Worker instead.
export default defineConfig({
  root: __dirname,
  publicDir: resolve(__dirname, "../prototypes"),
  server: { port: 5173, fs: { allow: [resolve(__dirname, "..")] } },
  build: { outDir: "dist", emptyOutDir: true },
});
