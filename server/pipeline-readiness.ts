import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { PipelineConfig } from "./pipeline-types";
import { resolveTranscriptionPython } from "./transcription-config";
import { detectGpu, venvDir } from "./transcription-setup";

export interface SetupCheck {
  id: "storage" | "downloads" | "transcription";
  label: string;
  ready: boolean;
  detail: string;
}

export interface PipelineSetupStatus {
  completed: boolean;
  ready: boolean;
  requirementsMet: boolean;
  checks: SetupCheck[];
}

/** Inspect the closest existing parent without creating folders during a GET. */
export function outputFolderError(value: string): string | null {
  if (!value?.trim()) return "Choose a folder.";
  if (!path.isAbsolute(value)) return "Use a full, absolute folder path.";
  let current = value;
  try {
    while (!fs.existsSync(current)) {
      const parent = path.dirname(current);
      if (parent === current) return "Folder is unavailable.";
      current = parent;
    }
    if (!fs.statSync(current).isDirectory()) return "The path points to a file.";
    fs.accessSync(current, fs.constants.W_OK | fs.constants.X_OK);
    return null;
  } catch {
    return "Folder is unavailable or not writable.";
  }
}

const runtimeCache = new Map<string, { at: number; error: string | null }>();
export function clearRuntimeChecks(): void { runtimeCache.clear(); }
let runtimeInstalling = false;
export function setRuntimeInstalling(value: boolean): void { runtimeInstalling = value; clearRuntimeChecks(); }

function runtimeError(config: PipelineConfig, platform: NodeJS.Platform): string | null {
  const t = config.transcription;
  if (platform === "darwin") {
    const bundled = typeof process.resourcesPath === "string" ? path.join(process.resourcesPath, "binaries/fluidaudiocli") : "";
    const binary = process.env.FLUIDAUDIO_BIN || (bundled && fs.existsSync(bundled) ? bundled : path.join(os.homedir(), "GitHub/FluidAudio/.build/release/fluidaudiocli"));
    try { fs.accessSync(binary, fs.constants.X_OK); return null; }
    catch { return "FluidAudio is unavailable. Install a packaged macOS build or configure its executable."; }
  }
  if (!t.model || t.model.startsWith("fluid-")) return "Choose a transcription engine for this machine.";
  if (!["cpu", "cuda"].includes(t.device)) return "Choose CPU or NVIDIA GPU for transcription.";
  if (t.device === "cuda" && !detectGpu().present) return "No NVIDIA GPU detected. Use CPU settings or install the recommended Whisper engine.";
  if (t.device === "cpu" && !["int8", "float32"].includes(t.computeType)) return "CPU transcription needs int8 or float32 compute.";
  const parakeet = t.model.includes("parakeet");
  const python = resolveTranscriptionPython(t, parakeet);
  const moduleName = parakeet ? "nemo" : "faster_whisper";
  if (t.venvPath && path.resolve(t.venvPath) === path.resolve(venvDir())) {
    try {
      if (fs.readFileSync(path.join(t.venvPath, "concord-engine.txt"), "utf8").trim() !== (parakeet ? "parakeet" : "whisper")) {
        return "Finish installing the selected transcription engine.";
      }
    } catch { return "Finish installing the transcription engine."; }
  }
  // Verify packages as well as an interpreter: an interrupted pip install
  // must not count as a usable engine. Cache only successful probes briefly.
  const key = `${python}:${moduleName}`;
  const cached = runtimeCache.get(key);
  if (cached && Date.now() - cached.at < 30_000 && fs.existsSync(python)) return cached.error;
  const probe = spawnSync(python, ["-c", `import importlib.util, sys; sys.exit(0 if importlib.util.find_spec('${moduleName}') else 1)`], { timeout: 10_000, encoding: "utf8" });
  if (probe.status !== 0) return "Install or repair the transcription engine for this machine.";
  runtimeCache.set(key, { at: Date.now(), error: null });
  return null;
}

export function pipelineSetupStatus(
  config: PipelineConfig,
  completed: boolean,
  probes: { folder?: typeof outputFolderError; runtime?: (config: PipelineConfig, platform: NodeJS.Platform) => string | null; platform?: NodeJS.Platform } = {},
): PipelineSetupStatus {
  const folder = probes.folder ?? outputFolderError;
  const storageError = folder(config.videoSaveDir) || folder(config.transcriptDir);
  const downloadsReady = ["480", "720", "1080", "best"].includes(config.videoQuality)
    && ["any", "av01", "vp9", "avc1"].includes(config.videoCodec)
    && ["fast", "balanced", "conservative"].includes(config.youtubeSpeedPreset)
    && Number.isFinite(config.checkIntervalMinutes) && config.checkIntervalMinutes > 0
    && Number.isInteger(config.dailyDownloadCap) && config.dailyDownloadCap >= 0;
  const transcriptionError = runtimeInstalling ? "Wait for the transcription installation to finish." : (probes.runtime ?? runtimeError)(config, probes.platform ?? process.platform);
  const checks: SetupCheck[] = [
    { id: "storage", label: "Storage", ready: !storageError, detail: storageError || "Video and transcript folders are configured and writable." },
    { id: "downloads", label: "Downloads", ready: downloadsReady, detail: downloadsReady ? "Quality, schedule, and download limits are configured." : "Review download quality, schedule, and limits." },
    { id: "transcription", label: "Transcription", ready: !transcriptionError, detail: transcriptionError || "Transcription packages are available. Models download on first use." },
  ];
  const requirementsMet = checks.every(check => check.ready);
  return { completed, requirementsMet, ready: completed && requirementsMet, checks };
}

export class PipelineSetupRequiredError extends Error {
  readonly status = 409;
  constructor(readonly setup: PipelineSetupStatus) {
    super("Complete Pipeline setup before downloading or transcribing.");
  }
}
