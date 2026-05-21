import type { Express, Request, Response } from "express";
import type { Server } from "http";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import type { Pipeline } from "./pipeline";
import { getArchiveStatus } from "./db";
import path from "path";
import os from "os";
import crypto from "crypto";
import { probeYtdlpHealth, userYtdlpPath } from "./yt-dlp-bin";

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

  // Update yt-dlp in place. Pulls the latest universal `yt-dlp_macos`
  // (or `yt-dlp` for Linux) from yt-dlp's GitHub releases, verifies
  // SHA256 against their SHA2-256SUMS manifest, ad-hoc signs the binary
  // so Apple Silicon's kernel will execute it (downloads from third
  // parties aren't signed by Apple-recognized identities), then
  // atomically renames into <userdata>/bin/yt-dlp. The next yt-dlp
  // spawn picks it up automatically — no server restart required.
  app.post("/api/pipeline/ytdlp-update", async (_req: Request, res: Response) => {
    try {
      const result = await updateBundledYtdlp();
      ytdlpHealthCache = null; // version changed — force a re-probe
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Update failed" });
    }
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

  // Native folder picker. macOS uses AppleScript; Linux falls back to
  // zenity (kdialog as backup for KDE). Lives server-side because the
  // app runs locally on the user's machine, so the dialog appears on
  // their desktop, not a remote one.
  app.post("/api/dialog/pick-folder", async (req, res) => {
    const { prompt = "Choose folder", defaultPath } = req.body || {};
    try {
      const pick = await openNativeFolderPicker({ prompt, defaultPath });
      res.json(pick);
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string };
      if (e?.code === "UNSUPPORTED") {
        return res.status(501).json({
          error: e.message || "Folder picker not supported on this platform yet",
          platform: process.platform,
        });
      }
      res.status(500).json({ error: e?.message || "picker failed" });
    }
  });

  // Native file picker — siblings the folder picker above. Used by the
  // FileInput component for things like the cookies.txt path.
  app.post("/api/dialog/pick-file", async (req, res) => {
    const { prompt = "Choose file", defaultPath } = req.body || {};
    try {
      const pick = await openNativeFilePicker({ prompt, defaultPath });
      res.json(pick);
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string };
      if (e?.code === "UNSUPPORTED") {
        return res.status(501).json({
          error: e.message || "File picker not supported on this platform yet",
          platform: process.platform,
        });
      }
      res.status(500).json({ error: e?.message || "picker failed" });
    }
  });
}

// ---- Native picker helpers ------------------------------------------------

interface PickerOpts {
  prompt: string;
  defaultPath?: string;
}

interface PickerResult {
  path?: string;
  cancelled?: boolean;
}

class UnsupportedPickerError extends Error {
  code = "UNSUPPORTED" as const;
}

/** macOS escape for AppleScript string literals. */
function aescape(s: string): string {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Try `which <bin>` synchronously — true if the binary is on PATH.
 *  Used to pick zenity vs kdialog on Linux without throwing if both
 *  are missing. */
function hasBinary(bin: string): boolean {
  try {
    return fs.existsSync(`/usr/bin/${bin}`) || fs.existsSync(`/usr/local/bin/${bin}`);
  } catch {
    return false;
  }
}

async function openNativeFolderPicker(opts: PickerOpts): Promise<PickerResult> {
  if (process.platform === "darwin") {
    let script = `POSIX path of (choose folder with prompt "${aescape(opts.prompt)}"`;
    if (opts.defaultPath && fs.existsSync(opts.defaultPath)) {
      script += ` default location POSIX file "${aescape(opts.defaultPath)}"`;
    }
    script += `)`;
    return runAppleScript(script);
  }
  if (process.platform === "linux") return runLinuxPicker(opts, "directory");
  throw new UnsupportedPickerError(`No folder picker for platform: ${process.platform}`);
}

async function openNativeFilePicker(opts: PickerOpts): Promise<PickerResult> {
  if (process.platform === "darwin") {
    let script = `POSIX path of (choose file with prompt "${aescape(opts.prompt)}"`;
    if (opts.defaultPath) {
      const dir = fs.existsSync(opts.defaultPath) && !fs.statSync(opts.defaultPath).isDirectory()
        ? opts.defaultPath.replace(/\/[^/]*$/, "") || opts.defaultPath
        : opts.defaultPath;
      if (fs.existsSync(dir)) {
        script += ` default location POSIX file "${aescape(dir)}"`;
      }
    }
    script += `)`;
    return runAppleScript(script);
  }
  if (process.platform === "linux") return runLinuxPicker(opts, "file");
  throw new UnsupportedPickerError(`No file picker for platform: ${process.platform}`);
}

async function runAppleScript(script: string): Promise<PickerResult> {
  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script]);
    return { path: stdout.trim() };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const stderr = String(e?.stderr || "");
    // osascript exits 1 with "User canceled. (-128)" when the user dismisses.
    if (stderr.includes("User canceled") || stderr.includes("(-128)")) {
      return { cancelled: true };
    }
    throw new Error(stderr || e?.message || "osascript failed");
  }
}

/** Linux picker — zenity preferred, kdialog as fallback. Both ship
 *  with most desktop installs and behave identically from the
 *  caller's POV (path on stdout, exit 1 on cancel). */
async function runLinuxPicker(
  opts: PickerOpts,
  kind: "file" | "directory",
): Promise<PickerResult> {
  if (hasBinary("zenity")) {
    const args = ["--file-selection", "--title", opts.prompt];
    if (kind === "directory") args.push("--directory");
    if (opts.defaultPath) {
      // zenity --filename expects a trailing slash for directories so
      // it opens *inside* the path rather than selecting the parent.
      const seed = kind === "directory" ? opts.defaultPath.replace(/\/?$/, "/") : opts.defaultPath;
      args.push("--filename", seed);
    }
    try {
      const { stdout } = await execFileAsync("zenity", args);
      const picked = stdout.trim();
      return picked ? { path: picked } : { cancelled: true };
    } catch (err) {
      // zenity exits 1 on cancel — distinguish it from a real failure
      // by inspecting stderr (zenity stays silent on cancel).
      const e = err as { code?: number; stderr?: string; message?: string };
      const stderr = String(e?.stderr || "");
      if (!stderr.trim()) return { cancelled: true };
      throw new Error(stderr || e?.message || "zenity failed");
    }
  }
  if (hasBinary("kdialog")) {
    const flag = kind === "directory" ? "--getexistingdirectory" : "--getopenfilename";
    const args = [flag, opts.defaultPath || "."];
    args.push("--title", opts.prompt);
    try {
      const { stdout } = await execFileAsync("kdialog", args);
      const picked = stdout.trim();
      return picked ? { path: picked } : { cancelled: true };
    } catch {
      // kdialog returns non-zero on cancel without stderr — treat as
      // cancel rather than error.
      return { cancelled: true };
    }
  }
  throw new UnsupportedPickerError(
    "Install zenity (or kdialog) to enable the native folder picker on Linux. "
    + "On Ubuntu/Debian: sudo apt install zenity",
  );
}

// ---- yt-dlp self-update helpers --------------------------------------------

interface YtdlpUpdateResult {
  ok: boolean;
  fromVersion: string | null;
  toVersion: string;
  releaseTag: string;
  binaryPath: string;
  sizeBytes: number;
  signed: boolean;
}

/** Pick the right release asset for this platform. yt-dlp publishes a
 *  universal Mach-O for macOS (arm64 + x86_64 in one file) and a plain
 *  ELF for Linux. */
function ytdlpAssetName(): string {
  if (process.platform === "darwin") return "yt-dlp_macos";
  if (process.platform === "linux") return "yt-dlp_linux";
  if (process.platform === "win32") return "yt-dlp.exe";
  throw new Error(`Unsupported platform for yt-dlp self-update: ${process.platform}`);
}

async function fetchText(url: string, accept?: string): Promise<string> {
  const headers: Record<string, string> = { "User-Agent": "Concord/yt-dlp-updater" };
  if (accept) headers["Accept"] = accept;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  return res.text();
}

async function fetchBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url, { headers: { "User-Agent": "Concord/yt-dlp-updater" } });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Run `codesign --sign - --force` so the kernel will execute the freshly
 *  downloaded binary. yt-dlp's release binaries aren't signed by an
 *  Apple-recognized identity, so on Apple Silicon they get killed at
 *  launch without an ad-hoc signature. No-op on non-darwin. */
async function adhocSign(binaryPath: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  try {
    await execFileAsync("codesign", ["--sign", "-", "--force", binaryPath], { timeout: 15000 });
    return true;
  } catch (err) {
    console.warn(`[yt-dlp-update] ad-hoc codesign failed (binary may not execute): ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

async function updateBundledYtdlp(): Promise<YtdlpUpdateResult> {
  // 1. Find the latest release.
  const releaseJson = await fetchText(
    "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest",
    "application/vnd.github+json",
  );
  const release = JSON.parse(releaseJson) as { tag_name: string };
  const tag = release.tag_name;
  if (!tag) throw new Error("yt-dlp latest release has no tag_name");

  // 2. Download the right asset + the manifest.
  const assetName = ytdlpAssetName();
  const base = `https://github.com/yt-dlp/yt-dlp/releases/download/${tag}`;
  const [binary, manifest] = await Promise.all([
    fetchBuffer(`${base}/${assetName}`),
    fetchText(`${base}/SHA2-256SUMS`),
  ]);

  // 3. Verify the SHA256 listed for this exact asset matches.
  const expectedLine = manifest
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.endsWith(`  ${assetName}`) || l.endsWith(` ${assetName}`));
  if (!expectedLine) {
    throw new Error(`No SHA256 entry for ${assetName} in the release manifest`);
  }
  const expected = expectedLine.split(/\s+/)[0];
  const actual = crypto.createHash("sha256").update(binary).digest("hex");
  if (expected !== actual) {
    throw new Error(`SHA256 mismatch for ${assetName}@${tag} (expected ${expected}, got ${actual})`);
  }

  // 4. Capture the current version (if any) for the response.
  let fromVersion: string | null = null;
  try {
    // Generous timeout — yt-dlp is a PyInstaller bundle and a cold
    // exec can take 5-10s while it unpacks. See yt-dlp-bin.ts.
    const { stdout } = await execFileAsync(userYtdlpPath(), ["--version"], { timeout: 30000 });
    fromVersion = stdout.trim();
  } catch { /* no current binary or it doesn't run — fine, this IS the fix */ }

  // 5. Write to a tempfile next to the target so the rename below is
  //    same-filesystem atomic. Then ad-hoc sign and rename into place.
  const dst = userYtdlpPath();
  const tmp = `${dst}.new`;
  await fs.promises.mkdir(path.dirname(dst), { recursive: true });
  await fs.promises.writeFile(tmp, binary, { mode: 0o755 });
  const signed = await adhocSign(tmp);
  // Probe the new binary's version BEFORE swapping — if it can't even
  // print its version, bailing now means we don't lose a working old copy.
  let toVersion: string;
  try {
    const { stdout } = await execFileAsync(tmp, ["--version"], { timeout: 30000 });
    toVersion = stdout.trim();
  } catch (err) {
    try { await fs.promises.unlink(tmp); } catch { /* ignore */ }
    throw new Error(`Downloaded binary fails to run --version: ${err instanceof Error ? err.message : err}`);
  }
  await fs.promises.rename(tmp, dst);

  console.log(
    `[yt-dlp-update] ${fromVersion ?? "(none)"} → ${toVersion}`
    + ` (release ${tag}, ${(binary.length / 1024 / 1024).toFixed(1)} MB${signed ? ", ad-hoc signed" : ""})`,
  );
  // Suppress unused-import-warning on `os` if the file doesn't otherwise need it.
  void os;

  return {
    ok: true,
    fromVersion,
    toVersion,
    releaseTag: tag,
    binaryPath: dst,
    sizeBytes: binary.length,
    signed,
  };
}
