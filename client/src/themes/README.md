# Themes

Drop a tweakcn export into this folder. The filename is the theme name. The
picker in the top bar discovers files via Vite's `import.meta.glob`, so adding
a new file shows up after a refresh — no registry to edit.

## Add a theme from tweakcn

1. Build a theme on https://tweakcn.com.
2. Click **Code → Tailwind v4** and copy the entire snippet.
3. Save it as `client/src/themes/<name>.css`. The filename (no extension) is
   what shows up in the picker.
4. Refresh.

You can paste tweakcn output **verbatim** — including the `@import`,
`@custom-variant`, `@theme inline`, `@layer base { … }` extras. At runtime we
extract the `:root { … }` and `.dark { … }` blocks and rewrite them as
`.theme-<filename>` / `.theme-<filename>.dark`; everything else is ignored
because those directives are build-time only and already handled by
`client/src/index.css`.

## "Default" entry

The picker always exposes a `default` option that uses the bare `:root` /
`.dark` blocks defined in `client/src/index.css` directly — no `theme-*` class
on `<html>`. Edit `index.css` if you want to change the fallback look.

## Light vs dark within a theme

Each theme file defines its own `:root` (light) and `.dark` (dark) blocks.
The light/dark toggle in the top bar adds/removes the `dark` class on
`<html>`, so theme + mode compose: `<html class="theme-rose dark">`.

## Scope of theme files

The file contents only need to set CSS variables. Any token your theme
doesn't define falls back to the default in `index.css`. The full set of
tokens the app understands is documented at the top of `index.css` (color,
sidebar, chart, radius, fonts, shadows).
