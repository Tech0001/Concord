import "./runtime-logs";
import express, { type Request, Response, NextFunction } from "express";
import { fileURLToPath } from "url";
import type { AddressInfo } from "net";
import { registerRoutes } from "./routes";
import { serveStatic, log } from "./vite";
import { getConfigValues } from "./db";
import { shutdownManagedChildProcesses } from "./child-process-registry";

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
  "/api/runtime-logs",
  "/api/chat/conversations",
]);
const QUIET_PREFIXES = [
  "/api/pipeline/events",                   // SSE — fires constantly
  "/api/runtime-logs/events",               // live server output SSE
  "/api/pipeline/queue/",                   // per-channel queue polls
  "/api/videos/download-progress/",         // long-poll progress
  "/api/clips/related/",                    // VideoDrawer side-panel polls
];
const QUIET_GET_PATHS = new Set([
  "/api/background-jobs",                  // BackgroundJobs status poll
]);
const QUIET_LOGS = process.env.LOG_QUIET !== "0";

function shouldQuiet(method: string, path: string, status: number): boolean {
  if (!QUIET_LOGS) return false;
  if (status >= 400) return false;
  if (method === "GET" && QUIET_GET_PATHS.has(path)) return true;
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
    if (shouldQuiet(req.method, path, res.statusCode)) return;

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
export interface StartServerOptions {
  port?: number;
  /** Reuse this server on an OS-assigned port when the preferred port is busy. */
  fallbackToRandom?: boolean;
}

export interface ServerHandle {
  port: number;
  close: () => Promise<void>;
}

let activeServerPromise: Promise<ServerHandle> | null = null;

export function startServer(opts: StartServerOptions = {}): Promise<ServerHandle> {
  // Registering the same Express routes twice also starts duplicate pipeline
  // timers. Treat repeated callers as requests for the existing server.
  activeServerPromise ??= startServerOnce(opts);
  return activeServerPromise;
}

async function startServerOnce(opts: StartServerOptions): Promise<ServerHandle> {
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
  try {
    await listenOnce(server, requestedPort, host);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!opts.fallbackToRandom || requestedPort === 0 || code !== "EADDRINUSE") throw error;
    console.warn(`[server] port ${requestedPort} in use; falling back to a random port`);
    await listenOnce(server, 0, host);
  }

  const addr = server.address() as AddressInfo;
  log(`serving on ${host}:${addr.port}${lanAccess ? " (LAN access enabled)" : ""}`);
  let closePromise: Promise<void> | null = null;
  return {
    port: addr.port,
    close: () => {
      closePromise ??= (async () => {
        await closeHttpServer(server);
        const report = await shutdownManagedChildProcesses();
        if (report.requested > 0) {
          console.log(
            `[shutdown] stopped ${report.requested} tool process(es)`
            + `${report.forced > 0 ? ` (${report.forced} forced)` : ""}`
            + `${report.remaining > 0 ? `; ${report.remaining} still present` : ""}`,
          );
        }
      })();
      return closePromise;
    },
  };
}

function listenOnce(server: import("http").Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ port, host });
  });
}

function closeHttpServer(server: import("http").Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    server.close(finish);
    // SSE and media streams otherwise keep server.close() pending forever.
    server.closeAllConnections?.();
    setTimeout(finish, 5_000).unref();
  });
}

// Auto-start when invoked directly (tsx server/index.ts or node dist/server/index.js).
// In Electron, the main process imports startServer and calls it explicitly.
const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  startServer()
    .then(handle => {
      let stopping = false;
      const stop = (signal: string) => {
        if (stopping) return;
        stopping = true;
        console.log(`[server] received ${signal}; shutting down`);
        void handle.close().finally(() => process.exit(0));
      };
      process.once("SIGINT", () => stop("SIGINT"));
      process.once("SIGTERM", () => stop("SIGTERM"));
    })
    .catch((err) => {
      console.error("Server failed to start:", err);
      process.exit(1);
    });
}
