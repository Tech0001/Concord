import type { Express, Request, Response } from "express";
import type { Server } from "http";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import type { Pipeline } from "./pipeline";
import { getArchiveStatus } from "./db";
import { probeYtdlpHealth } from "./yt-dlp-bin";

const execFileAsync = promisify(execFile);

/**
 * Server/system endpoints — pipeline + archive status snapshots, raw
 * pipeline config get/post, the yt-dlp health probe (cached), platform
 * info for the client-side UI, the LAN URL for "open on your phone",
 * and the native folder picker.
 *
 * Grouped here because none of these touch the video queue / library
 * directly — they're either app-level state inspection or one-shot
 * shell-outs (osascript, yt-dlp --version) that have no business
 * cluttering the data-path routes. The `Server` arg is only needed for
 * /api/system/lan-url (which reads the bound port).
 */
export function registerSystemRoutes(app: Express, pipeline: Pipeline, httpServer: Server): void {
  app.get("/api/pipeline/status", (_req, res) => {
    res.json(pipeline.getState());
  });

  // Whole-archive status snapshot — powers the Status dashboard. Bundles
  // the pipeline state with coverage counts so the page renders from a
  // single fetch. Cheap aggregate queries; safe to poll every few seconds.
  app.get("/api/status", (_req, res) => {
    try {
      const cfg = pipeline.getConfig();
      const snapshot = getArchiveStatus(cfg.llm.embeddingModel || null);
      res.json({
        pipeline: pipeline.getState(),
        ...snapshot,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to assemble status snapshot",
      });
    }
  });

  app.get("/api/pipeline/config", (_req, res) => {
    res.json(pipeline.getConfig());
  });

  app.post("/api/pipeline/config", (req, res) => {
    try {
      pipeline.updateConfig(req.body);
      res.json({ success: true, config: pipeline.getConfig() });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Invalid config" });
    }
  });

  // yt-dlp health indicator. We deliberately do NOT auto-update yt-dlp
  // anywhere; this endpoint just probes `yt-dlp --version` so the UI can
  // show whether the binary is reachable and what version is installed.
  // The result is cached for 60s — version doesn't change between
  // user-initiated package upgrades.
  let ytdlpHealthCache: { at: number; data: Awaited<ReturnType<typeof probeYtdlpHealth>> } | null = null;
  app.get("/api/pipeline/ytdlp-health", async (req: Request, res: Response) => {
    const force = req.query.force === "1" || req.query.force === "true";
    if (!force && ytdlpHealthCache && Date.now() - ytdlpHealthCache.at < 60_000) {
      return res.json({ ...ytdlpHealthCache.data, cached: true });
    }
    const data = await probeYtdlpHealth();
    ytdlpHealthCache = { at: Date.now(), data };
    res.json({ ...data, cached: false });
  });

  // For client-side platform-aware UI filtering (e.g. only show
  // FluidAudio in the model picker when running on macOS).
  app.get("/api/system/info", (_req, res) => {
    res.json({ platform: process.platform, arch: process.arch });
  });

  // LAN URL ("open on your phone" UX). Returns the first non-internal
  // IPv4 address bound on this machine so the UI can show a URL the user
  // types into their phone's browser. Only meaningful when lanAccess is
  // enabled in pipeline config; the client gates display on that flag,
  // but the endpoint always answers so the UI can render "save config
  // and restart to enable" hints.
  app.get("/api/system/lan-url", async (_req, res) => {
    const os = await import("os");
    const port = (httpServer.address() as { port?: number } | null)?.port;
    const lanAccess = pipeline.getConfig().lanAccess === true;
    const ifaces = os.networkInterfaces();
    let ip: string | null = null;
    for (const list of Object.values(ifaces)) {
      for (const i of list || []) {
        if (i.family === "IPv4" && !i.internal) { ip = i.address; break; }
      }
      if (ip) break;
    }
    res.json({
      lanAccess,
      ip,
      port: port ?? null,
      url: lanAccess && ip && port ? `http://${ip}:${port}` : null,
    });
  });

  // Native folder picker — macOS only for now (AppleScript). When we
  // package as Electron we swap this for dialog.showOpenDialog. Lives
  // server-side because the app runs locally on the user's machine, so
  // the dialog appears on their desktop, not a remote one.
  app.post("/api/dialog/pick-folder", async (req, res) => {
    if (process.platform !== "darwin") {
      return res.status(501).json({
        error: "Folder picker not supported on this platform yet",
        platform: process.platform,
      });
    }
    const { prompt = "Choose folder", defaultPath } = req.body || {};
    const escape = (s: string) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    let script = `POSIX path of (choose folder with prompt "${escape(prompt)}"`;
    if (defaultPath && fs.existsSync(defaultPath)) {
      script += ` default location POSIX file "${escape(defaultPath)}"`;
    }
    script += `)`;
    try {
      const { stdout } = await execFileAsync("osascript", ["-e", script]);
      res.json({ path: stdout.trim() });
    } catch (err: unknown) {
      const e = err as { stderr?: string; message?: string };
      const stderr = String(e?.stderr || "");
      // osascript exits 1 with "User canceled. (-128)" when the user dismisses.
      if (stderr.includes("User canceled") || stderr.includes("(-128)")) {
        return res.json({ cancelled: true });
      }
      res.status(500).json({ error: stderr || e?.message || "osascript failed" });
    }
  });
}
