// Auto-discover all .css files in this folder. Each file is treated as a
// drop-in tweakcn export — paste the file verbatim, filename becomes the theme
// name. We pull out the `:root { … }` and `.dark { … }` blocks and rewrite
// them as `.theme-<name>` / `.theme-<name>.dark` so multiple themes coexist
// without colliding in `:root`.
//
// Anything else in the file (the `@import "tailwindcss"`, `@custom-variant`,
// `@theme inline`, `@layer base { … }` blocks tweakcn emits) is ignored at
// runtime — those are build-time directives already handled in `index.css`.
const rawThemes = import.meta.glob("./*.css", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

export const DEFAULT_THEME = "default";

function nameFromPath(path: string): string | null {
  const m = path.match(/^\.\/(.+)\.css$/);
  return m ? m[1] : null;
}

export const themes: string[] = [
  DEFAULT_THEME,
  ...Object.keys(rawThemes)
    .map(nameFromPath)
    .filter((n): n is string => n !== null && !n.startsWith("_"))
    .sort((a, b) => a.localeCompare(b)),
];

function scopeBlock(raw: string, selector: RegExp, replacement: string): string | null {
  // Match `:root { … }` / `.dark { … }` where the body has no nested braces —
  // true of every tweakcn export, since both blocks contain only flat
  // `--token: value;` declarations.
  const match = raw.match(selector);
  if (!match) return null;
  return `${replacement} {${match[1]}}`;
}

function scopeTweakcnCss(raw: string, name: string): string {
  const blocks: string[] = [];
  const root = scopeBlock(raw, /:root\s*\{([^{}]*)\}/, `.theme-${name}`);
  if (root) blocks.push(root);
  const dark = scopeBlock(raw, /\.dark\s*\{([^{}]*)\}/, `.theme-${name}.dark`);
  if (dark) blocks.push(dark);
  return blocks.join("\n");
}

const STYLE_ID = "app-themes";

export function injectThemes(): void {
  const css = Object.entries(rawThemes)
    .map(([path, raw]) => {
      const name = nameFromPath(path);
      return name ? scopeTweakcnCss(raw, name) : "";
    })
    .filter(Boolean)
    .join("\n\n");

  if (typeof document === "undefined") return;
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = css;
}
