import { app, BrowserWindow, shell, Menu, nativeImage } from "electron";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve the compiled server entry. In production main.js sits at
// dist/electron/main.js and the server bundle at dist/index.js (esbuild's
// existing layout — kept so server/vite.ts's `../dist/public` resolution
// still works inside the bundle). SERVER_ENTRY env var overrides for dev.
const serverEntry = process.env.SERVER_ENTRY
  ? path.resolve(process.env.SERVER_ENTRY)
  : path.resolve(__dirname, "..", "index.js");

let mainWindow: BrowserWindow | null = null;
let closeServer: (() => Promise<void>) | null = null;

/** Resolve the master icon PNG. In a packaged app it's at
 *  process.resourcesPath/icon.png (copied via build.extraResources in
 *  package.json). In dev runs (electron:dev) it sits in the source tree
 *  at build/icon-src/icon_1024.png. Returns the absolute path. */
function resolveIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "icon.png")
    : path.resolve(__dirname, "..", "..", "build", "icon-src", "icon_1024.png");
}

/** Pick the HTTP port the embedded server should bind to. Default 5050
 *  so users can bookmark a stable URL across restarts (especially on
 *  always-on installs like a Dell-as-server setup); CONCORD_PORT or PORT
 *  env vars override. Set explicitly to 0 in env to fall back to an
 *  OS-assigned random port. */
function pickServerPort(): number {
  const fromEnv = process.env.CONCORD_PORT ?? process.env.PORT;
  if (fromEnv !== undefined && fromEnv !== "") {
    const n = Number(fromEnv);
    if (Number.isFinite(n) && n >= 0 && n <= 65535) return n;
  }
  return 5050;
}

async function createWindow(serverPort: number): Promise<void> {
  // Linux + Windows: set the window's own icon. The .desktop entry's
  // Icon= field only governs the launcher; the running window needs its
  // own icon for the title bar / taskbar / Alt-Tab / dock entry to show
  // the right image. macOS gets its icon from the .app bundle (and
  // app.dock.setIcon below for dev runs), so we skip it there.
  const windowIcon = process.platform === "darwin" ? undefined : resolveIconPath();

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0a0a0a",
    icon: windowIcon,
    webPreferences: {
      // Hard lock the renderer — only the Express UI runs here, so no
      // node integration is needed and contextIsolation prevents the
      // page from poking at Electron internals if a dep is ever
      // compromised at runtime.
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Open external links in the user's default browser instead of inside
  // the BrowserWindow (so a click on a YouTube URL doesn't hijack the app).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  await mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);
}

async function bootstrap(): Promise<void> {
  await app.whenReady();

  // Apps launched from Finder/Dock start with cwd = `/`; from terminal cwd
  // is wherever you ran the command. Server code that uses relative paths
  // (legacy `./pipeline.db` migration probe, `./youtube-dl-cache`, default
  // working dir, etc.) behaves wildly differently between the two. Pin cwd
  // to the per-user data dir — always writable, always the same, independent
  // of launch method.
  try {
    const userData = app.getPath("userData");
    fs.mkdirSync(userData, { recursive: true });
    process.chdir(userData);
    console.log(`[electron] cwd: ${process.cwd()}`);
  } catch (err) {
    console.warn("[electron] chdir to userData failed:", err);
  }

  // Set the Dock icon explicitly so dev runs (`electron dist/...`) show
  // the Concord icon instead of the generic Electron icon. In a packaged
  // .app this is overridden by the bundle's Info.plist CFBundleIconFile,
  // but it doesn't hurt to set both.
  if (process.platform === "darwin" && app.dock) {
    const iconPath = resolveIconPath();
    try {
      const img = nativeImage.createFromPath(iconPath);
      if (img.isEmpty()) throw new Error("decoded image is empty");
      app.dock.setIcon(img);
      console.log(`[electron] dock icon set: ${iconPath}`);
    } catch (err) {
      console.warn(`[electron] dock.setIcon failed for ${iconPath}:`, err);
    }
  }

  const { startServer } = await import(serverEntry);
  const handle = await startServerWithFallback(startServer);
  closeServer = handle.close;
  console.log(`[electron] server bound on port ${handle.port}`);

  await createWindow(handle.port);
}

/** Try the configured port first; fall back to OS-assigned random on
 *  EADDRINUSE so a port collision (e.g. dev server already running)
 *  doesn't crash the launch. The console log makes the fallback
 *  obvious so the user notices the URL changed. */
async function startServerWithFallback(
  startServer: (opts: { port?: number }) => Promise<{ port: number; close: () => Promise<void> }>,
): Promise<{ port: number; close: () => Promise<void> }> {
  const wanted = pickServerPort();
  try {
    return await startServer({ port: wanted });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "EADDRINUSE" || wanted === 0) throw err;
    console.warn(`[electron] port ${wanted} in use; falling back to random port`);
    return await startServer({ port: 0 });
  }
}

// macOS convention: re-create the window when the dock icon is clicked
// and no windows are open.
app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0 && closeServer) {
    const { startServer } = await import(serverEntry);
    const handle = await startServerWithFallback(startServer);
    await createWindow(handle.port);
  }
});

// On macOS, apps usually stay open until Cmd-Q. On other platforms,
// quitting when the last window closes is the expected behavior.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async () => {
  if (closeServer) {
    try { await closeServer(); } catch { /* swallow on shutdown */ }
    closeServer = null;
  }
});

// Minimal Mac menu so Cmd-Q / Cmd-W / Edit shortcuts all work without
// having to wire them up individually.
Menu.setApplicationMenu(Menu.buildFromTemplate([
  { role: "appMenu" },
  { role: "editMenu" },
  { role: "viewMenu" },
  { role: "windowMenu" },
]));

bootstrap().catch((err) => {
  console.error("[electron] bootstrap failed:", err);
  // Persist the crash to a log file so Finder/Dock launches (where stdout
  // is /dev/null) leave a trail we can read. ~/Library/Logs/Concord/
  // is the macOS-blessed location.
  try {
    const logDir = process.platform === "darwin"
      ? path.join(app.getPath("home"), "Library", "Logs", "Concord")
      : app.getPath("logs");
    fs.mkdirSync(logDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dump = `[${new Date().toISOString()}] bootstrap failed\n`
      + `cwd=${process.cwd()}\n`
      + `argv=${JSON.stringify(process.argv)}\n`
      + `error=${err instanceof Error ? err.stack : String(err)}\n`;
    fs.writeFileSync(path.join(logDir, `crash-${stamp}.log`), dump);
  } catch { /* if even logging fails, nothing we can do */ }
  app.quit();
});
