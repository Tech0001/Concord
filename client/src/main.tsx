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

    const storedMode = localStorage.getItem("yt-ripper-theme");
    const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    const mode = storedMode === "dark" || storedMode === "light"
      ? storedMode
      : prefersDark ? "dark" : "light";
    root.classList.toggle("dark", mode === "dark");
    root.style.colorScheme = mode;

    const storedName = localStorage.getItem("yt-ripper-theme-name");
    const name = storedName && themes.includes(storedName) ? storedName : DEFAULT_THEME;
    if (name !== DEFAULT_THEME) {
      root.classList.add(`theme-${name}`);
    }
  } catch {}
})();

createRoot(document.getElementById("root")!).render(<App />);
