import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";

// The Cloudflare plugin runs the SPA (HMR) AND the Worker + bindings (DO/D1/R2)
// in Miniflare under one `vite dev`. It reads main/assets from wrangler.jsonc.
// Artifacts are served from R2 via /api/artifacts/* (no publicDir needed).
export default defineConfig({
  plugins: [cloudflare()],
});
