import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const clientDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  // The single .env lives at the repo root, one level up from here.
  const env = loadEnv(mode, resolve(clientDir, ".."), "");
  const apiUrl = env.VITE_API_URL || "http://localhost:4000";

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { "@": resolve(clientDir, "src") },
    },
    server: {
      port: 5173,
      // Proxying keeps the browser on one origin, which avoids CORS entirely
      // and — more importantly — lets EventSource work without credentials
      // juggling, since SSE cannot send custom headers.
      proxy: {
        "/api": { target: apiUrl, changeOrigin: true },
      },
    },
  };
});
