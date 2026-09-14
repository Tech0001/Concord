import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  root: path.resolve(import.meta.dirname, "client"),
  server: {
    // Allow the dev server to be reached over Tailscale (MagicDNS names
    // end in .ts.net). Vite 5+ rejects unknown Host headers with a 403
    // ("This host is not allowed"), which blocks loading the app from a
    // phone over the tailnet. A leading-dot entry allows that domain and
    // any subdomain. localhost / LAN IPs are allowed by default.
    allowedHosts: [".ts.net"],
    watch: {
      usePolling: true,
      interval: 500,
      ignored: [
        "**/node_modules/**",
        "**/venv/**",
        "**/venv-parakeet/**",
        "**/downloads/**",
        "**/saved_videos/**",
        "**/transcripts/**",
        "**/temp/**",
        "**/youtube-dl-cache/**",
        "**/dist/**",
        "**/*.db",
        "**/*.db-shm",
        "**/*.db-wal",
        "**/*.mp4",
        "**/*.m4a",
        "**/*.wav",
        "**/*.webm",
        "**/*.mkv",
      ],
    },
  },
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
});
