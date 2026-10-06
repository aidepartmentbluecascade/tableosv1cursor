import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const appDir = path.dirname(fileURLToPath(import.meta.url));

// Dev-server ports/targets are overridable so several checkouts can run side by side.
const apiTarget = process.env["TABULA_API_PROXY"] ?? "http://localhost:3000";
const realtimeTarget = process.env["TABULA_REALTIME_PROXY"] ?? "ws://localhost:3002";
const devPort = Number(process.env["TABULA_WEB_PORT"] ?? 5173);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: "@tabula/ui/tokens.css",
        replacement: path.resolve(appDir, "../../packages/ui/src/tokens.css"),
      },
      {
        find: "@tabula/ui",
        replacement: path.resolve(appDir, "../../packages/ui/src/index.ts"),
      },
    ],
  },
  server: {
    port: devPort,
    strictPort: true,
    proxy: {
      "/v1": {
        target: apiTarget,
        changeOrigin: true,
      },
      "/health": {
        target: apiTarget,
        changeOrigin: true,
      },
      "/ws": {
        target: realtimeTarget,
        ws: true,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ws/, "/v1/ws"),
      },
    },
  },
});
