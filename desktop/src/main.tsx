import React from "react";
import { createRoot } from "react-dom/client";
import "./fonts/fonts.css";
import "./theme/concord.css";
import "./theme/tokens.css";
import "./theme/base.css";
import "./style.css";
import { applyAppearance, injectThemes, loadAppearance } from "./theme/theme.ts";
import App from "./App";

injectThemes();
applyAppearance(loadAppearance());
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
