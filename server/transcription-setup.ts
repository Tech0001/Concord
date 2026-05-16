import { spawn, spawnSync } from "child_process";
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Electron is a special module that only resolves inside Electron's
// runtime. When the server runs via `pnpm dev` (plain tsx, no Electron)
// the import would throw, so we resolve it lazily through createRequire
// and treat its absence as "not packaged".
const requireFromHere = createRequire(import.meta.url);
function isPackagedElectron(): boolean {
  if (!process.versions.electron) return false;
  try {
    const electron = requireFromHere("electron");
    return Boolean(electron?.app?.isPackaged);
  } catch {
    return false;
  }
}

// ---- Types ----------------------------------------------------------------

export type EngineId = "parakeet" | "whisper";

export interface PythonInfo {
  /** True when a python3 ≥3.10 is available on PATH. */
  ok: boolean;
  /** Path to the python binary, or "python3" if only the name resolved. */
  path: string;
  /** Version string from `python3 --version` (or null on failure). */
  version: string | null;
  /** Numeric tuple parsed from version (e.g. [3,12,4]) for comparisons. */
  versionParts: [number, number, number] | null;
  /** Human-readable error explaining a probe failure. */
  error?: string;
}

export interface GpuInfo {
  /** True iff `nvidia-smi` returned a usable line. */
  present: boolean;
  /** GPU name, e.g. "NVIDIA GeForce RTX 4090". */
  name?: string;
  /** Total VRAM in MB. */
  vramMb?: number;
  /** Why detection failed, if it did. */
  error?: string;
}

export interface VenvInfo {
  /** Locked install location: ~/.local/share/concord/venv on Linux,
   *  the equivalent XDG/AppData path on the other platforms. */
  path: string;
  /** True iff the venv directory exists AND has a python binary. */
  exists: boolean;
  /** Engine id stored in the marker file `<venv>/concord-engine.txt`,
   *  populated by installEngine. Lets the UI know which engine the
   *  installed venv corresponds to. */
  engine: EngineId | null;
}

export interface SetupStatus {
  platform: NodeJS.Platform;
  /** True on Mac (FluidAudio is bundled — no Python needed). */
  skipSetup: boolean;
  python: PythonInfo;
  gpu: GpuInfo;
  /** Auto-pick: parakeet if NVIDIA + ≥8GB VRAM, otherwise whisper. */
  recommendedEngine: EngineId;
  venv: VenvInfo;
  /** True iff a usable venv exists for SOME engine. */
  installed: boolean;
}

// ---- Locked paths ---------------------------------------------------------

const PARAKEET_VRAM_FLOOR_MB = 8 * 1024;

/** XDG-style data root for our user data. ~/.local/share/concord on Linux. */
function dataRoot(): string {
  // Mirrors defaultDbPath() in db.ts so the venv lives next to the DB.
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Concord");
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Concord");
  const xdg = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
  return path.join(xdg, "concord");
}

/** Locked Python venv install location. Single venv per machine — only one
 *  engine is installed at a time, switched via the wizard. */
export function venvDir(): string {
  return path.join(dataRoot(), "venv");
}

/** Resolve the directory holding requirements*.txt and the engine .py
 *  scripts. In a packaged Electron app these ship via extraResources at
 *  process.resourcesPath/transcription-engines/. In dev they live in the
 *  source tree. */
export function enginesDir(): string {
  if (isPackagedElectron()) return path.join(process.resourcesPath, "transcription-engines");
  return path.resolve(__dirname, "transcription-engines");
}

const ENGINE_MARKER = "concord-engine.txt";

// ---- Detection ------------------------------------------------------------

/** Probe the system python3. We only need ≥3.10 because both engines
 *  drop older Python in their wheels. */
export function detectPython(): PythonInfo {
  const tryPath = (p: string): PythonInfo | null => {
    const r = spawnSync(p, ["--version"], { encoding: "utf-8" });
    if (r.status !== 0) return null;
    const out = `${r.stdout || ""}${r.stderr || ""}`.trim(); // some pythons print to stderr
    const m = out.match(/Python (\d+)\.(\d+)\.(\d+)/);
    if (!m) return { ok: false, path: p, version: out, versionParts: null, error: "could not parse version" };
    const parts: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const okVersion = parts[0] > 3 || (parts[0] === 3 && parts[1] >= 10);
    return {
      ok: okVersion,
      path: p,
      version: out,
      versionParts: parts,
      error: okVersion ? undefined : `python ${parts.join(".")} is too old (need ≥ 3.10)`,
    };
  };

  // Prefer specific minor versions when present (newer = better wheels);
  // fall back to the bare "python3" alias for distros that only ship it.
  for (const candidate of ["python3.12", "python3.11", "python3.10", "python3"]) {
    const info = tryPath(candidate);
    if (info) return info;
  }
  return { ok: false, path: "python3", version: null, versionParts: null, error: "python3 not found on PATH" };
}

/** Probe nvidia-smi. Returns present=false on every non-NVIDIA / non-CUDA
 *  machine — that's fine, the wizard then picks whisper. */
export function detectGpu(): GpuInfo {
  const r = spawnSync(
    "nvidia-smi",
    ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
    { encoding: "utf-8" },
  );
  if (r.status !== 0 || !r.stdout) {
    return { present: false, error: r.error?.message ?? "nvidia-smi not available" };
  }
  // Take just the first GPU when there are multiple — the rest don't help us.
  const line = r.stdout.split("\n").map(s => s.trim()).find(Boolean);
  if (!line) return { present: false, error: "nvidia-smi returned no rows" };
  const [name, vramRaw] = line.split(",").map(s => s.trim());
  const vramMb = Number(vramRaw);
  return {
    present: true,
    name: name || undefined,
    vramMb: Number.isFinite(vramMb) ? vramMb : undefined,
  };
}

/** Inspect the locked venv path — does the directory exist with a usable
 *  python, and which engine did we install there? */
export function detectVenv(): VenvInfo {
  const dir = venvDir();
  const py = path.join(dir, "bin", "python");
  if (!fs.existsSync(py)) return { path: dir, exists: false, engine: null };

  let engine: EngineId | null = null;
  try {
    const marker = fs.readFileSync(path.join(dir, ENGINE_MARKER), "utf-8").trim();
    if (marker === "parakeet" || marker === "whisper") engine = marker;
  } catch { /* no marker — engine unknown but venv exists */ }

  return { path: dir, exists: true, engine };
}

/** The auto-pick rule: parakeet only when there's a real NVIDIA GPU
 *  with enough VRAM to load parakeet-tdt-0.6b-v3 + activations. Anything
 *  smaller (or no GPU at all) falls back to faster-whisper, which runs
 *  on CPU. */
export function pickRecommendedEngine(gpu: GpuInfo): EngineId {
  if (!gpu.present) return "whisper";
  if ((gpu.vramMb ?? 0) < PARAKEET_VRAM_FLOOR_MB) return "whisper";
  return "parakeet";
}

/** Top-level status — what the UI needs to render the wizard / Settings
 *  page in one round trip. */
export function getSetupStatus(): SetupStatus {
  // On macOS we ship FluidAudio inside the .app and never run a Python
  // engine, so don't probe for python at all — invoking the `/usr/bin/python3`
  // stub triggers macOS's "Install Command Line Developer Tools?" dialog on
  // a fresh Mac, which is a terrible first-launch experience for a tool
  // that doesn't even need Python. Same for nvidia-smi (always absent) and
  // the wizard venv (skipSetup=true means we never create one).
  if (process.platform === "darwin") {
    return {
      platform: "darwin",
      skipSetup: true,
      python: { ok: false, path: "python3", version: null, versionParts: null, error: "not applicable on macOS (FluidAudio bundled)" },
      gpu: { present: false, error: "not applicable on macOS" },
      recommendedEngine: "whisper", // unused when skipSetup is true
      venv: { exists: false, path: venvDir(), engine: null },
      installed: false,
    };
  }
  const python = detectPython();
  const gpu = detectGpu();
  const venv = detectVenv();
  const recommendedEngine = pickRecommendedEngine(gpu);
  return {
    platform: process.platform,
    skipSetup: false,
    python,
    gpu,
    recommendedEngine,
    venv,
    installed: venv.exists,
  };
}

// ---- Install --------------------------------------------------------------

export interface InstallProgress {
  /** Phase identifier so the UI can label each step. */
  phase: "venv" | "pip" | "marker" | "done" | "error";
  /** Free-form line of stdout/stderr (or a status note). */
  line: string;
}

/** Build a venv at the locked path and pip-install the engine's
 *  requirements file. Streams every line of stdout/stderr through
 *  onProgress so the UI can render a live install log. Resolves with
 *  the final python binary path on success; rejects with a descriptive
 *  error on failure. */
export async function installEngine(
  engine: EngineId,
  python: PythonInfo,
  onProgress: (event: InstallProgress) => void,
): Promise<{ pythonPath: string }> {
  if (!python.ok) {
    const msg = python.error || "python3 not available";
    onProgress({ phase: "error", line: msg });
    throw new Error(msg);
  }

  const dir = venvDir();
  fs.mkdirSync(path.dirname(dir), { recursive: true });

  // Step 1: create venv (or reuse existing if a marker matches)
  if (!fs.existsSync(path.join(dir, "bin", "python"))) {
    onProgress({ phase: "venv", line: `Creating venv at ${dir}` });
    await runStreaming(python.path, ["-m", "venv", dir], onProgress, "venv");
  } else {
    onProgress({ phase: "venv", line: `Reusing existing venv at ${dir}` });
  }

  const venvPython = path.join(dir, "bin", "python");

  // Step 2: pip install -r requirements
  const reqs = path.join(enginesDir(), `requirements-${engine}.txt`);
  if (!fs.existsSync(reqs)) {
    const msg = `Requirements file missing: ${reqs}`;
    onProgress({ phase: "error", line: msg });
    throw new Error(msg);
  }
  onProgress({ phase: "pip", line: `pip install -r ${reqs}` });
  await runStreaming(
    venvPython,
    ["-m", "pip", "install", "--upgrade", "--no-cache-dir", "-r", reqs],
    onProgress,
    "pip",
  );

  // Step 3: write the engine marker so detectVenv() can identify it later
  fs.writeFileSync(path.join(dir, ENGINE_MARKER), engine + "\n");
  onProgress({ phase: "marker", line: `Recorded engine: ${engine}` });

  onProgress({ phase: "done", line: `Installed ${engine}` });
  return { pythonPath: venvPython };
}

/** Run a process and stream every line of stdout/stderr through
 *  onProgress. Resolves on exit code 0; rejects otherwise with a message
 *  containing the tail of stderr so the UI can show an actionable error. */
function runStreaming(
  cmd: string,
  args: string[],
  onProgress: (event: InstallProgress) => void,
  phase: InstallProgress["phase"],
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stderrTail: string[] = [];
    const STDERR_TAIL_LINES = 40;

    function pipe(stream: NodeJS.ReadableStream, isStderr: boolean) {
      let buf = "";
      stream.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        let idx;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx).trimEnd();
          buf = buf.slice(idx + 1);
          if (line.length === 0) continue;
          onProgress({ phase, line });
          if (isStderr) {
            stderrTail.push(line);
            if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
          }
        }
      });
      stream.on("end", () => {
        if (buf.trim().length > 0) {
          onProgress({ phase, line: buf.trim() });
          if (isStderr) {
            stderrTail.push(buf.trim());
            if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
          }
        }
      });
    }

    pipe(proc.stdout, false);
    pipe(proc.stderr, true);

    proc.on("error", (err) => {
      onProgress({ phase: "error", line: err.message });
      reject(err);
    });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        const tail = stderrTail.join(" | ").slice(-400);
        const msg = `${cmd} exited ${code}: ${tail || "(no stderr)"}`;
        onProgress({ phase: "error", line: msg });
        reject(new Error(msg));
      }
    });
  });
}

// ---- Cleanup --------------------------------------------------------------

/** Wipe the venv directory. Used by the "Switch engine" / "Reinstall"
 *  flows. The marker file is removed implicitly with the directory. */
export function uninstallEngine(): void {
  const dir = venvDir();
  if (!fs.existsSync(dir)) return;
  fs.rmSync(dir, { recursive: true, force: true });
}
