// Capture Concord Next pages from the Vite dev server using headless Chromium over CDP.
// Usage: node desktop/scripts/screens.mjs <outdir> [name-filter]
// Env: BASE (default http://127.0.0.1:1420/), CDP_PORT (default 9333), EXTRA (JSON array of extra shots),
//      SIZES (comma list of desktop,small,tablet,phone), MODES (comma list of dark,light).
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const out = process.argv[2] ?? "screens";
const only = process.argv[3] ?? "";
const base = process.env.BASE ?? "http://127.0.0.1:1420/";
const port = Number(process.env.CDP_PORT ?? 9333);
const allSizes = {
  desktop: { width: 1440, height: 940, mobile: false },
  small: { width: 960, height: 640, mobile: false },
  tablet: { width: 820, height: 1180, mobile: true },
  phone: { width: 390, height: 844, mobile: true },
};
const sizes = Object.entries(allSizes).filter(([name]) => !process.env.SIZES || process.env.SIZES.split(",").includes(name));
const modes = process.env.MODES ? process.env.MODES.split(",") : ["dark", "light"];
// Each shot: name, hash route, optional script before a reload (before), after load (after),
// and an optional probe expression whose JSON value is printed (for layout debugging).
const shots = [
  { name: "gallery", query: "gallery", hash: "" },
  { name: "library", hash: "#/library" },
  { name: "library-list", hash: "#/library", before: "localStorage.setItem('library-view-v1', JSON.stringify('list'))" },
  { name: "player", hash: "#/recording/" + encodeURIComponent("rec-01") + "?t=65" },
  { name: "player-audio", hash: "#/recording/" + encodeURIComponent("rec-03") },
  { name: "search", hash: "#/search?q=harbour" },
  { name: "documents", hash: "#/documents" },
  { name: "document", hash: "#/documents/doc-1" },
  { name: "notes", hash: "#/notes" },
  { name: "speakers", hash: "#/speakers" },
  { name: "map", hash: "#/map" },
  { name: "settings", hash: "#/settings" },
  ...(process.env.EXTRA ? JSON.parse(process.env.EXTRA) : []),
];

mkdirSync(out, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), "concord-screens-"));
const chrome = spawn(
  "chromium",
  ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--hide-scrollbars", "--force-color-profile=srgb", "--autoplay-policy=no-user-gesture-required", "about:blank"],
  { stdio: "ignore" },
);
try {
  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) {
    try {
      await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      ready = true;
    } catch {
      await sleep(100);
    }
  }
  if (!ready) throw new Error("Chromium did not start");
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  await send("Page.enable");
  await send("Runtime.enable");
  for (const shot of shots.filter((s) => !only || s.name.includes(only))) {
    for (const mode of modes) {
      for (const [sizeName, size] of sizes) {
        await send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: size.mobile });
        await send("Emulation.setTouchEmulationEnabled", size.mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
        await send("Emulation.setEmitTouchEventsForMouse", { enabled: size.mobile });
        const url = `${base}?mock&mode=${mode}${shot.query ? `&${shot.query}` : ""}${shot.hash ?? ""}`;
        await send("Page.navigate", { url: "about:blank" });
        await send("Page.navigate", { url });
        await sleep(400);
        if (shot.before) {
          await send("Runtime.evaluate", { expression: shot.before });
          await send("Page.reload");
        }
        await sleep(1000);
        if (shot.after) {
          await send("Runtime.evaluate", { expression: shot.after, awaitPromise: true });
          await sleep(500);
        }
        if (shot.probe) {
          const { result } = await send("Runtime.evaluate", { expression: shot.probe, returnByValue: true, awaitPromise: true });
          console.log(`probe ${shot.name}-${sizeName}-${mode}:`, JSON.stringify(result.value));
        }
        const { data } = await send("Page.captureScreenshot", { format: "png" });
        const file = join(out, `${shot.name}-${sizeName}-${mode}.png`);
        writeFileSync(file, Buffer.from(data, "base64"));
        console.log(file);
      }
    }
  }
  ws.close();
} finally {
  const exited = new Promise((r) => chrome.once("exit", r));
  chrome.kill();
  await exited;
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
