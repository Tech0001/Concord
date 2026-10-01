import { test } from "node:test";
import assert from "node:assert/strict";
import { themeAccent, scopeTweakcn, themeNameFromPath } from "./scope.ts";

const sample = `@import "tailwindcss";
@custom-variant dark (&:is(.dark *));
:root { --background: #fff; --primary: red; }
.dark { --background: #000; }
@theme inline { --color-background: var(--background); }
@layer base { * { border-color: var(--border); } }`;

test("scopes light and dark blocks to the theme and drops build directives", () => {
  const css = scopeTweakcn(sample, "lifeOS");
  assert.equal(
    css,
    ":root.theme-lifeOS { --background: #fff; --primary: red; }\n:root.theme-lifeOS.dark { --background: #000; }",
  );
});

test("a theme without a dark block yields only its light block", () => {
  assert.equal(scopeTweakcn(":root{--a:1;}", "mono"), ":root.theme-mono {--a:1;}");
});

test("theme names come from file names; underscore files are ignored", () => {
  assert.equal(themeNameFromPath("./themes/lifeOS.css"), "lifeOS");
  assert.equal(themeNameFromPath("./themes/altar-invert.css"), "altar-invert");
  assert.equal(themeNameFromPath("./themes/_draft.css"), null);
});

test("a theme's accent color comes from its light primary token", () => {
  const raw = ":root {\n  --background: oklch(1 0 0);\n  --primary: oklch(0.62 0.18 348.1);\n}\n.dark {\n  --primary: #ffffff;\n}";
  assert.equal(themeAccent(raw), "oklch(0.62 0.18 348.1)");
  assert.equal(themeAccent(".dark { --primary: red; }"), null);
});
