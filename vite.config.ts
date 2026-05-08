import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  root: path.resolve(import.meta.dirname, "client"),
  server: {
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
