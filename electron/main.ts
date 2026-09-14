import { app, BrowserWindow, shell, Menu, nativeImage } from "electron";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import {
  getRuntimeLogs,
  installRuntimeLogCapture,
  subscribeRuntimeLogs,
  type RuntimeLogEntry,
} from "../server/runtime-logs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve the compiled server entry. In production main.js sits at
// dist/electron/main.js and the server bundle at dist/index.js (esbuild's
// existing layout — kept so server/vite.ts's `../dist/public` resolution
// still works inside the bundle). SERVER_ENTRY env var overrides for dev.
const serverEntry = process.env.SERVER_ENTRY
  ? path.resolve(process.env.SERVER_ENTRY)
  : path.resolve(__dirname, "..", "index.js");

let mainWindow: BrowserWindow | null = null;
interface ServerHandle {
  port: number;
  close: () => Promise<void>;
}
type StartServer = (opts: {
  port?: number;
  fallbackToRandom?: boolean;
}) => Promise<ServerHandle>;

let serverHandle: ServerHandle | null = null;
let serverStartPromise: Promise<ServerHandle> | null = null;
let shutdownPromise: Promise<void> | null = null;
let quitAfterShutdown = false;

// ---- Console forwarding to renderer DevTools ----
//
// The embedded server runs in this main process, so its console.log /
// console.error output goes to the terminal that launched Electron — but
// users running the packaged app from Activities don't see a terminal.
// Forward every log line into the renderer's console too so the in-app
// DevTools (Cmd/Ctrl+Shift+I) becomes the "terminal" for the app.

function sendToRenderer(entry: RuntimeLogEntry): void {
  const w = mainWindow;
  if (!w || w.isDestroyed()) return;
  const wc = w.webContents;
  if (wc.isDestroyed() || wc.isLoading()) return;
  // executeJavaScript is round-trip-free for fire-and-forget logging.
  // String-quote the message so newlines / quotes survive the round trip.
  const code = `console.${entry.level}(${JSON.stringify("[server] " + entry.message)});`;
  wc.executeJavaScript(code, true).catch(() => { /* swallow — not worth logging the log failure */ });
}

/** Flush buffered logs into a freshly-loaded window. Called from
 *  did-finish-load. Subsequent live logs go through sendToRenderer
 *  directly. */
function flushLogBufferToRenderer(): void {
  for (const entry of getRuntimeLogs()) sendToRenderer(entry);
}

installRuntimeLogCapture();
subscribeRuntimeLogs(sendToRenderer);

/**
 * AppImage launchers prepend their mounted runtime to PATH and
 * LD_LIBRARY_PATH. Electron itself has already loaded by this point; external
 * Python/CUDA/media tools should instead resolve against the host system.
 */
function sanitizeAppImageEnvironment(): void {
  const appDir = process.env.APPDIR;
  if (!appDir) return;
  const outsideAppDir = (value: string): boolean => {
    const normalized = path.resolve(value);
    return normalized !== appDir && !normalized.startsWith(`${appDir}${path.sep}`);
  };
  for (const key of ["PATH", "LD_LIBRARY_PATH"] as const) {
    const cleaned = (process.env[key] || "")
      .split(path.delimiter)
      .filter(Boolean)
      .filter(outsideAppDir)
      .join(path.delimiter);
    if (cleaned) process.env[key] = cleaned;
    else delete process.env[key];
  }
  for (const key of ["APPIMAGE", "APPDIR", "ARGV0", "OWD"]) delete process.env[key];
  console.log("[electron] sanitized AppImage environment for external tools");
}

sanitizeAppImageEnvironment();

/** Prepend the common install locations to PATH so child processes can
 *  find tools like `node` (needed by yt-dlp's player JS decoder) on a
 *  fresh user Mac. GUI-launched apps on macOS get a minimal PATH
 *  (/usr/bin:/bin:/usr/sbin:/sbin) and DON'T inherit the user's shell
 *  PATH from ~/.zshrc / ~/.bashrc — so even though `node` lives at
 *  /usr/local/bin/node, the .app's children can't find it. Augmenting
 *  here once propagates to every subsequent spawn (yt-dlp → node,
 *  ffmpeg, FluidAudio, etc.) because Node merges process.env into the
 *  default child env.
 *
 *  Specifically this resolves the "Requested format is not available"
 *  yt-dlp error on Macs without /usr/local/bin in their default GUI PATH —
 *  yt-dlp's player JS decoder silently fails to find node, falls back to
 *  the android_vr API which returns an empty/incomplete format list, and
 *  the default `bv*+ba/b` selector can't match anything. */
function augmentPathForGuiLaunch(): void {
  if (process.platform !== "darwin") return;
  const extras = ["/usr/local/bin", "/opt/homebrew/bin"];
  const current = (process.env.PATH || "").split(":").filter(Boolean);
  const missing = extras.filter((p) => !current.includes(p));
  if (missing.length === 0) return;
  process.env.PATH = [...missing, ...current].join(":");
  console.log(`[electron] PATH augmented for GUI launch: prepended ${missing.join(", ")}`);
}
augmentPathForGuiLaunch();

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
      sandbox: true,
    },
  });

  const appUrl = new URL(`http://127.0.0.1:${serverPort}`);

  // Open external links in the user's default browser instead of inside
  // the BrowserWindow (so a click on a YouTube URL doesn't hijack the app).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    let targetOrigin: string | null = null;
    try { targetOrigin = new URL(url).origin; } catch { /* invalid URL: block below */ }
    if (targetOrigin === appUrl.origin) return;
    event.preventDefault();
    if (targetOrigin) void shell.openExternal(url);
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Replay buffered server logs into the renderer's console after each
  // load. did-finish-load fires on the initial nav AND on any reloads,
  // so a Cmd-R wipes the renderer console but the server-side history
  // re-appears immediately.
  mainWindow.webContents.on("did-finish-load", () => {
    flushLogBufferToRenderer();
  });

  await mainWindow.loadURL(appUrl.href);
}

async function bootstrap(): Promise<void> {
  await app.whenReady();

  // Keep mutable server data in the platform's data location. Electron's
  // Linux userData path is ~/.config/Concord, which is appropriate for UI
  // preferences but not downloads, yt-dlp cache, or multi-gigabyte media.
  try {
    const dataRoot = concordDataRoot();
    fs.mkdirSync(dataRoot, { recursive: true });
    migrateLegacyLinuxWorkingData(app.getPath("userData"), dataRoot);
    process.chdir(dataRoot);
    console.log(`[electron] cwd: ${process.cwd()}`);
  } catch (err) {
    console.warn("[electron] chdir to Concord data root failed:", err);
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

  const handle = await ensureServer();
  console.log(`[electron] server bound on port ${handle.port}`);

  await createWindow(handle.port);
}

function concordDataRoot(): string {
  if (process.platform !== "linux") return app.getPath("userData");
  const xdgData = process.env.XDG_DATA_HOME
    || path.join(app.getPath("home"), ".local", "share");
  return path.join(xdgData, "concord");
}

/** Move only legacy server work folders, never Electron's own cache/config. */
function migrateLegacyLinuxWorkingData(legacyRoot: string, dataRoot: string): void {
  if (process.platform !== "linux" || legacyRoot === dataRoot) return;
  for (const name of ["downloads", "temp", "youtube-dl-cache"]) {
    const source = path.join(legacyRoot, name);
    const destination = path.join(dataRoot, name);
    if (!fs.existsSync(source) || fs.existsSync(destination)) continue;
    try {
      fs.renameSync(source, destination);
      console.log(`[electron] migrated ${name} → ${destination}`);
    } catch (error) {
      // Never delete or copy potentially large media implicitly. A cross-device
      // or permissions failure leaves the original recoverable in place.
      console.warn(`[electron] could not migrate ${source}:`, error);
    }
  }
}

async function ensureServer(): Promise<ServerHandle> {
  if (serverHandle) return serverHandle;
  serverStartPromise ??= (async () => {
    const module = await import(serverEntry) as { startServer: StartServer };
    const handle = await module.startServer({
      port: pickServerPort(),
      fallbackToRandom: true,
    });
    serverHandle = handle;
    return handle;
  })();
  try {
    return await serverStartPromise;
  } catch (error) {
    serverStartPromise = null;
    throw error;
  }
}

// macOS convention: re-create the window when the dock icon is clicked
// and no windows are open.
app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    try {
      const handle = await ensureServer();
      await createWindow(handle.port);
    } catch (error) {
      console.error("[electron] could not reopen window:", error);
    }
  }
});

// On macOS, apps usually stay open until Cmd-Q. On other platforms,
// quitting when the last window closes is the expected behavior.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (quitAfterShutdown) return;
  event.preventDefault();
  if (shutdownPromise) return;
  shutdownPromise = (async () => {
    if (serverHandle) {
      try {
        await serverHandle.close();
      } catch (error) {
        console.error("[electron] server shutdown failed:", error);
      }
      serverHandle = null;
    }
    quitAfterShutdown = true;
    app.quit();
  })();
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
