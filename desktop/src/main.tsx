import React from "react";
import { createRoot } from "react-dom/client";
import "./fonts/fonts.css";
import "./theme/concord.css";
import "./theme/tokens.css";
import "./theme/base.css";
import "./style.css";
import { applyAppearance, injectThemes, loadAppearance, saveAppearance } from "./theme/theme.ts";
import App from "./App";

async function boot() {
  const params = new URLSearchParams(location.search);
  if (import.meta.env.DEV && params.has("mock")) {
    (await import("./dev/mock-ipc.ts")).installMock();
    const theme = params.get("theme");
    const mode = params.get("mode");
    if (theme || mode) {
      const current = loadAppearance();
      saveAppearance({
        ...current,
        theme: theme ?? current.theme,
        mode: mode === "light" ? "light" : mode === "dark" ? "dark" : current.mode,
      });
    }
  }
  injectThemes();
  applyAppearance(loadAppearance());
  const Root = import.meta.env.DEV && params.has("gallery") ? (await import("./dev/Gallery.tsx")).default : App;
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>,
  );
}
void boot();
