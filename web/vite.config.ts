import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";

// The Cloudflare plugin runs the SPA (HMR) AND the Worker + bindings (DO/D1/R2)
// in Miniflare under one `vite dev`. It reads main/assets from wrangler.jsonc.
// Artifacts are served from R2 via /api/artifacts/* (no publicDir needed).
export default defineConfig({
  plugins: [cloudflare()],
  // Allow the sandbox container to reach the Worker's ingest endpoints via the
  // Docker Desktop host gateway (Vite blocks unknown Host headers otherwise).
  server: { host: true, allowedHosts: ["host.docker.internal"] },
});
