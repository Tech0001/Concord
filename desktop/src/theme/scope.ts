/** Rewrite a pasted tweakcn export so several themes can coexist. Only :root and .dark token blocks are kept. */
export function scopeTweakcn(raw: string, name: string): string {
  const blocks: string[] = [];
  const light = /:root\s*\{([^{}]*)\}/.exec(raw);
  const dark = /\.dark\s*\{([^{}]*)\}/.exec(raw);
  if (light) blocks.push(`:root.theme-${name} {${light[1]}}`);
  if (dark) blocks.push(`:root.theme-${name}.dark {${dark[1]}}`);
  return blocks.join("\n");
}

export function themeNameFromPath(path: string): string | null {
  const match = /\/([^/]+)\.css$/.exec(path);
  return match && !match[1].startsWith("_") ? match[1] : null;
}
