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
  },
});
