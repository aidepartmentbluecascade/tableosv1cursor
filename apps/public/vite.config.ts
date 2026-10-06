import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const appDir = path.dirname(fileURLToPath(import.meta.url));

// Dev-server ports/targets are overridable so several checkouts can run side by side.
const apiTarget = process.env["TABULA_API_PROXY"] ?? "http://localhost:3000";
const devPort = Number(process.env["TABULA_PUBLIC_PORT"] ?? 5174);

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
    },
  },
});
