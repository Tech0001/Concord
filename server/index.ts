import express, { type Request, Response, NextFunction } from "express";
import { fileURLToPath } from "url";
import type { AddressInfo } from "net";
import { registerRoutes } from "./routes";
import { serveStatic, log } from "./vite";
import { getConfigValues } from "./db";

// Process-level safety nets. Without these, a single unhandled promise
// rejection (or a synchronous throw inside an async callback) takes
// the whole server down — which is what was happening when a background
// retranscribe job hit an unexpected error mid-queue. Log loudly and
// keep the event loop alive instead.
process.on("unhandledRejection", (reason) => {
  console.error("[process] Unhandled promise rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[process] Uncaught exception:", err);
});

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Endpoints polled on a timer or fired in tight UI loops. Logging every
// hit floods the dev terminal and buries real signals (download progress,
// transcription messages, errors). Logged only when their status is >=400
// so failures still surface; otherwise silent. Toggle off via env var
// LOG_QUIET=0 if you actually want the firehose back.
const QUIET_PATHS = new Set([
  "/api/llm/status",
  "/api/llm/models",
  "/api/llm/config",
  "/api/pipeline/status",
  "/api/pipeline/config",
  "/api/pipeline/queue",
  "/api/pipeline/transcripts",
  "/api/transcripts/search/stats",
  "/api/clips/tags",
  "/api/system/info",
  "/api/status",
  "/api/chat/conversations",
]);
const QUIET_PREFIXES = [
  "/api/pipeline/events",                   // SSE — fires constantly
  "/api/pipeline/queue/",                   // per-channel queue polls
  "/api/videos/download-progress/",         // long-poll progress
  "/api/clips/related/",                    // VideoDrawer side-panel polls
];
const QUIET_LOGS = process.env.LOG_QUIET !== "0";

function shouldQuiet(path: string, status: number): boolean {
  if (!QUIET_LOGS) return false;
  if (status >= 400) return false;
  if (QUIET_PATHS.has(path)) return true;
  return QUIET_PREFIXES.some((p) => path.startsWith(p));
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (!path.startsWith("/api")) return;
    if (shouldQuiet(path, res.statusCode)) return;

    let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
    if (capturedJsonResponse) {
      logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
    }

    if (logLine.length > 80) {
      logLine = logLine.slice(0, 79) + "…";
    }

    log(logLine);
  });

  next();
});

/**
 * Boot the server and start listening. Returns the actual bound port +
 * a close handle. Electron's main process calls this with `port: 0` to
 * get an ephemeral port, then loads BrowserWindow against `localhost:<port>`.
 * Run directly via `tsx` / `node` it auto-starts on PORT or 5050.
 */
export async function startServer(opts: { port?: number } = {}): Promise<{ port: number; close: () => Promise<void> }> {
  const server = await registerRoutes(app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  // Using process.env.NODE_ENV (not app.get("env")) so esbuild can statically
  // substitute it at build time via --define and tree-shake the entire dev
  // branch out of the production bundle. Without this, vite-dev.ts (and its
  // transitive imports of vite + vite plugins) end up in dist/index.js even
  // behind a dynamic import, and the packaged Electron app crashes at boot
  // because vite is a devDependency that isn't shipped.
  if (process.env.NODE_ENV !== "production") {
    const { setupVite } = await import("./vite-dev");
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // Default 5050 because macOS Control Center (AirPlay Receiver) holds 5000.
  // Electron passes 0 explicitly to get whatever ephemeral port is free.
  const requestedPort = opts.port ?? (Number(process.env.PORT) || 5050);
  // LAN access is opt-in via config — default 127.0.0.1 keeps the API off
  // the local network entirely. Toggling lanAccess to true (and restarting)
  // binds to 0.0.0.0 so a phone/tablet on the same WiFi can browse the app.
  const lanAccess = getConfigValues().lanAccess === "true";
  const host = lanAccess ? "0.0.0.0" : "127.0.0.1";
  return new Promise((resolve) => {
    server.listen({ port: requestedPort, host }, () => {
      const addr = server.address() as AddressInfo;
      log(`serving on ${host}:${addr.port}${lanAccess ? " (LAN access enabled)" : ""}`);
      resolve({
        port: addr.port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

// Auto-start when invoked directly (tsx server/index.ts or node dist/server/index.js).
// In Electron, the main process imports startServer and calls it explicitly.
const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  startServer().catch((err) => {
    console.error("Server failed to start:", err);
    process.exit(1);
  });
}
