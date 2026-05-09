import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { injectThemes, DEFAULT_THEME, themes } from "./themes";

// Make every theme file in client/src/themes/ available before React mounts.
injectThemes();

// Apply persisted theme + mode synchronously to avoid a flash of the default.
(() => {
  try {
    const root = document.documentElement;

    // Read the new keys, falling back to the legacy "yt-ripper-*" names so
    // existing users keep their persisted theme + light/dark choice across
    // the rename.
    const storedMode = localStorage.getItem("concord-theme")
      ?? localStorage.getItem("yt-ripper-theme");
    const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    const mode = storedMode === "dark" || storedMode === "light"
      ? storedMode
      : prefersDark ? "dark" : "light";
    root.classList.toggle("dark", mode === "dark");
    root.style.colorScheme = mode;

    const storedName = localStorage.getItem("concord-theme-name")
      ?? localStorage.getItem("yt-ripper-theme-name");
    const name = storedName && themes.includes(storedName) ? storedName : DEFAULT_THEME;
    if (name !== DEFAULT_THEME) {
      root.classList.add(`theme-${name}`);
    }
  } catch {}
})();

createRoot(document.getElementById("root")!).render(<App />);
