import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const appDir = path.dirname(fileURLToPath(import.meta.url));

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
    port: 5174,
    proxy: {
      "/v1": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
