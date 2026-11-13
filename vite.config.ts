import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: Vite on 5173 proxies the API to the backend on 8791. Prod: the backend serves dist/.
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist", emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: { "/api": { target: "http://127.0.0.1:8791", changeOrigin: true }, "/oauth": { target: "http://127.0.0.1:8791", changeOrigin: true } },
  },
  test: undefined,
} as any);
