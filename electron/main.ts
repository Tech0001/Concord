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

async function createWindow(serverPort: number): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0a0a0a",
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
    // In a packaged .app, electron-builder copies icon.png to
    // Contents/Resources/ (via extraResources). In dev runs the same file
    // lives at build/icon-src/icon_1024.png next to the project root.
    const iconPath = app.isPackaged
      ? path.join(process.resourcesPath, "icon.png")
      : path.resolve(__dirname, "..", "..", "build", "icon-src", "icon_1024.png");
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
  const handle = await startServer({ port: 0 });
  closeServer = handle.close;
  console.log(`[electron] server bound on port ${handle.port}`);

  await createWindow(handle.port);
}

// macOS convention: re-create the window when the dock icon is clicked
// and no windows are open.
app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0 && closeServer) {
    const { startServer } = await import(serverEntry);
    const handle = await startServer({ port: 0 });
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
