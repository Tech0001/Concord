import { useEffect, useState } from "react";

import { DEFAULT_THEME, themes } from "@/themes";

type Mode = "light" | "dark";

const MODE_KEY = "yt-ripper-theme";
const NAME_KEY = "yt-ripper-theme-name";

function readMode(): Mode {
  if (typeof window === "undefined") return "light";
  const stored = window.localStorage.getItem(MODE_KEY);
  if (stored === "dark" || stored === "light") return stored;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function readThemeName(): string {
  if (typeof window === "undefined") return DEFAULT_THEME;
  const stored = window.localStorage.getItem(NAME_KEY);
  return stored && themes.includes(stored) ? stored : DEFAULT_THEME;
}

function applyMode(mode: Mode) {
  const root = document.documentElement;
  root.classList.toggle("dark", mode === "dark");
  root.style.colorScheme = mode;
}

function applyThemeName(name: string) {
  const root = document.documentElement;
  root.classList.forEach((cls) => {
    if (cls.startsWith("theme-")) root.classList.remove(cls);
  });
  if (name && name !== DEFAULT_THEME) {
    root.classList.add(`theme-${name}`);
  }
}

export function useTheme() {
  const [theme, setTheme] = useState<Mode>(() => readMode());
  const [themeName, setThemeName] = useState<string>(() => readThemeName());

  useEffect(() => {
    applyMode(theme);
    window.localStorage.setItem(MODE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    applyThemeName(themeName);
    window.localStorage.setItem(NAME_KEY, themeName);
  }, [themeName]);

  return {
    theme,
    setTheme,
    toggle: () => setTheme((t) => (t === "dark" ? "light" : "dark")),
    themeName,
    setThemeName,
    themes,
  };
}
