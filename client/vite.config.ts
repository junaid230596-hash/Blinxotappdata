import fs from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { loadEnv, type Plugin } from "vite";
import { defineConfig } from "vitest/config";

/** Build-time PWA/SEO glue: stamps the service worker with a build id (fresh caches per deploy) and, when VITE_SITE_URL is set, adds absolute canonical/OG tags. */
function blinxotBuild(siteUrl: string): Plugin {
  const buildId = Date.now().toString(36);
  let outDir = "dist";
  return {
    name: "blinxot-build",
    configResolved(c) { outDir = path.resolve(c.root, c.build.outDir); },
    transformIndexHtml(html) {
      const origin = siteUrl.replace(/\/+$/, "");
      const tags = origin ? [
        `<link rel="canonical" href="${origin}/" />`, `<meta property="og:url" content="${origin}/" />`,
        `<meta property="og:image" content="${origin}/og-image.png" />`, `<meta name="twitter:image" content="${origin}/og-image.png" />`,
      ].join("\n    ") : "";
      return html.replace("<!--SITE_META-->", tags);
    },
    closeBundle() {
      const sw = path.join(outDir, "sw.js");
      if (fs.existsSync(sw)) fs.writeFileSync(sw, fs.readFileSync(sw, "utf8").replaceAll("__BUILD_ID__", buildId));
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  return {
    plugins: [react(), blinxotBuild(env.VITE_SITE_URL ?? "")],
    server: { port: 5173, proxy: { "/api": "http://localhost:4000", "/uploads": "http://localhost:4000", "/sitemap.xml": "http://localhost:4000", "/robots.txt": "http://localhost:4000" } },
    build: { sourcemap: false, target: "es2020", chunkSizeWarningLimit: 300 },
    test: { environment: "jsdom", env: {
        NODE_ENV: "test", DATABASE_URL: "postgres://blinxot:blinxot_dev@localhost:5432/blinxot_client_test",
        JWT_ACCESS_SECRET: "client-test-secret-client-test-secret-1234", UPLOAD_DIR: "./.test-uploads",
      }, globals: true, setupFiles: ["./tests/setup.ts"], include: ["tests/**/*.test.{ts,tsx}"], testTimeout: 20000, fileParallelism: false },
  };
});
