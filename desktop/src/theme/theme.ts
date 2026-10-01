import { useCallback, useSyncExternalStore } from "react";
import { readStored, writeStored } from "../lib/storage.ts";
import { scopeTweakcn, themeNameFromPath } from "./scope.ts";

const files = import.meta.glob("./themes/*.css", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

export type ThemeMode = "system" | "dark" | "light";
export type ReadingFont = "serif" | "sans";
export type Appearance = {
  theme: string;
  mode: ThemeMode;
  reading: ReadingFont;
};
export const DEFAULT_APPEARANCE: Appearance = {
  theme: "concord",
  mode: "dark",
  reading: "serif",
};
const KEY = "appearance-v1";

export const THEMES: string[] = [
  "concord",
  ...Object.keys(files)
    .map(themeNameFromPath)
    .filter((n): n is string => !!n)
    .sort((a, b) => a.localeCompare(b)),
];

export function injectThemes(): void {
  const id = "concord-themes";
  const el = document.getElementById(id) ?? Object.assign(document.createElement("style"), { id });
  el.textContent = Object.entries(files)
    .map(([path, raw]) => {
      const name = themeNameFromPath(path);
      return name ? scopeTweakcn(raw, name) : "";
    })
    .join("\n");
  document.head.append(el);
}

export function loadAppearance(): Appearance {
  const v = readStored<Partial<Appearance>>(KEY, {}, (x) => typeof x === "object" && x !== null);
  return {
    theme: v.theme && THEMES.includes(v.theme) ? v.theme : DEFAULT_APPEARANCE.theme,
    mode: v.mode === "system" || v.mode === "light" || v.mode === "dark" ? v.mode : DEFAULT_APPEARANCE.mode,
    reading: v.reading === "sans" ? "sans" : "serif",
  };
}

const appearanceListeners = new Set<() => void>();
let appearanceSnapshot: Appearance | undefined;
const getAppearance = () => (appearanceSnapshot ??= loadAppearance());
const subscribeAppearance = (listener: () => void) => {
  appearanceListeners.add(listener);
  return () => {
    appearanceListeners.delete(listener);
  };
};

export function saveAppearance(a: Appearance): void {
  writeStored(KEY, a);
  appearanceSnapshot = a;
  appearanceListeners.forEach((listener) => listener());
}

let stopFollowingSystem: (() => void) | null = null;

export function applyAppearance(a: Appearance, root: HTMLElement = document.documentElement): void {
  for (const name of THEMES) root.classList.remove(`theme-${name}`);
  if (a.theme !== "concord") root.classList.add(`theme-${a.theme}`);
  stopFollowingSystem?.();
  stopFollowingSystem = null;
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const set = () => {
    const dark = a.mode === "dark" || (a.mode === "system" && query.matches);
    root.classList.toggle("dark", dark);
    root.style.colorScheme = dark ? "dark" : "light";
  };
  set();
  if (a.mode === "system") {
    query.addEventListener("change", set);
    stopFollowingSystem = () => query.removeEventListener("change", set);
  }
  root.dataset.reading = a.reading;
}

export function useAppearance(): [Appearance, (a: Appearance) => void] {
  const appearance = useSyncExternalStore(subscribeAppearance, getAppearance, getAppearance);
  const update = useCallback((a: Appearance) => {
    applyAppearance(a);
    saveAppearance(a);
  }, []);
  return [appearance, update];
}
