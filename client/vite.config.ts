import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// Swaps in the dev favicon during `vite dev` only — production build unchanged.
const devFavicon: Plugin = {
  name: "dev-favicon",
  apply: "serve",
  transformIndexHtml: (html) =>
    html.replace(
      'href="/favicon.ico"',
      'href="/favicon-dev.ico"'
    ),
};

export default defineConfig({
  plugins: [react(), tailwindcss(), devFavicon],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
    // FSEvents (macOS's native file-watch API) has been silently dropping change
    // events partway through dev sessions, leaving Vite serving stale transforms
    // until the process is restarted. Polling checks disk directly instead of
    // relying on OS-level notifications, trading a little CPU for reliability.
    watch: {
      usePolling: true,
    },
  },
});
