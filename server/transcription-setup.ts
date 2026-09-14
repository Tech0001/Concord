import { spawn, spawnSync } from "child_process";
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { trackChildProcess } from "./child-process-registry";
import { transcriptionDefaults } from "./transcription-config";

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
  /** True when a Python supported by the transcription dependency stack is available. */
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
  recommendedSettings: ReturnType<typeof transcriptionDefaults>;
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

/** Return mise-managed Python binaries even when that version is installed
 * alongside the global default and therefore has no active PATH shim. */
function misePythonCandidates(minor: string): string[] {
  const miseData = process.env.MISE_DATA_DIR || path.join(os.homedir(), ".local", "share", "mise");
  const installsDir = path.join(miseData, "installs", "python");
  let versions: string[];
  try {
    versions = fs.readdirSync(installsDir)
      .filter(version => version === minor || version.startsWith(`${minor}.`))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  } catch {
    return [];
  }

  return versions.flatMap(version => [
    path.join(installsDir, version, "bin", `python${minor}`),
    path.join(installsDir, version, "bin", "python3"),
  ]);
}

/** Probe for a Python version with wheels across NeMo's ASR dependency
 * stack. Python 3.14 itself runs NeMo, but some required ASR packages do not
 * publish 3.14 wheels yet, so setup deliberately stays on 3.10–3.13. */
export function detectPython(): PythonInfo {
  const tryPath = (p: string): PythonInfo | null => {
    const r = spawnSync(p, ["--version"], { encoding: "utf-8" });
    if (r.status !== 0) return null;
    const out = `${r.stdout || ""}${r.stderr || ""}`.trim(); // some pythons print to stderr
    const m = out.match(/Python (\d+)\.(\d+)\.(\d+)/);
    if (!m) return { ok: false, path: p, version: out, versionParts: null, error: "could not parse version" };
    const parts: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const okVersion = parts[0] === 3 && parts[1] >= 10 && parts[1] <= 13;
    const error = parts[0] !== 3 || parts[1] < 10
      ? `python ${parts.join(".")} is too old (need 3.10–3.13)`
      : parts[1] > 13
        ? `python ${parts.join(".")} is too new for the current transcription dependency wheels (need 3.10–3.13)`
        : undefined;
    return {
      ok: okVersion,
      path: p,
      version: out,
      versionParts: parts,
      error,
    };
  };

  // Python 3.12 is the known-good NeMo environment. Check ordinary PATH
  // commands and side-by-side mise installs before falling back to python3.
  const candidates = ["3.12", "3.13", "3.11", "3.10"]
    .flatMap(minor => [`python${minor}`, ...misePythonCandidates(minor)]);
  candidates.push("python3");

  let unsupported: PythonInfo | null = null;
  for (const candidate of Array.from(new Set(candidates))) {
    const info = tryPath(candidate);
    if (info?.ok) return info;
    if (info && !unsupported) unsupported = info;
  }
  return unsupported
    ?? { ok: false, path: "python3", version: null, versionParts: null, error: "Python 3.10–3.13 not found" };
}

/** Probe nvidia-smi. Returns present=false on every non-NVIDIA / non-CUDA
 *  machine — that's fine, the wizard then picks whisper. */
let gpuCache: { at: number; info: GpuInfo } | undefined;
export function detectGpu(): GpuInfo {
  if (gpuCache && Date.now() - gpuCache.at < 30_000) return gpuCache.info;
  const info = probeGpu();
  gpuCache = { at: Date.now(), info };
  return info;
}

function probeGpu(): GpuInfo {
  const r = spawnSync(
    "nvidia-smi",
    ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
    { encoding: "utf-8", timeout: 5_000 },
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
  if (!isUsablePython(py)) return { path: dir, exists: false, engine: null };

  let engine: EngineId | null = null;
  try {
    const marker = fs.readFileSync(path.join(dir, ENGINE_MARKER), "utf-8").trim();
    if (marker === "parakeet" || marker === "whisper") engine = marker;
  } catch { /* no marker — engine unknown but venv exists */ }

  return { path: dir, exists: true, engine };
}

/** A copied venv can leave behind a Python symlink that exists as a directory
 * entry but points to an interpreter from the previous OS. Actually execute
 * the interpreter and check its minor version so setup does not mistake a
 * stale or unsupported environment for a usable install. */
function isUsablePython(pythonPath: string): boolean {
  if (!fs.existsSync(pythonPath)) return false;
  const result = spawnSync(pythonPath, ["--version"], { encoding: "utf-8" });
  if (result.status !== 0 || result.error) return false;
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  const match = output.match(/Python (\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major === 3 && minor >= 10 && minor <= 13;
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
      recommendedSettings: { ...transcriptionDefaults("whisper", false, ""), model: "fluid-parakeet-tdt-v3" },
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
    recommendedSettings: transcriptionDefaults(recommendedEngine, gpu.present, venv.path, gpu.vramMb),
    venv,
    installed: venv.exists && venv.engine !== null,
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

  // Step 1: create the venv. Virtual environments are not portable between
  // operating-system installs: their interpreter links and console-script
  // shebangs contain absolute paths. Remove only Concord's dependency venv
  // when it is present but unusable; the database and model caches live
  // outside this directory and are left untouched.
  const venvPython = path.join(dir, "bin", "python");
  if (!isUsablePython(venvPython)) {
    if (fs.existsSync(dir)) {
      onProgress({
        phase: "venv",
        line: `Existing transcription environment is incompatible or incomplete; rebuilding ${dir}`,
      });
      fs.rmSync(dir, { recursive: true, force: true });
    }
    onProgress({ phase: "venv", line: `Creating venv at ${dir}` });
    await runStreaming(python.path, ["-m", "venv", dir], onProgress, "venv");
    if (!isUsablePython(venvPython)) {
      const msg = `Virtual environment was created, but its Python interpreter is not usable: ${venvPython}`;
      onProgress({ phase: "error", line: msg });
      throw new Error(msg);
    }
  } else {
    onProgress({ phase: "venv", line: `Reusing existing venv at ${dir}` });
  }

  // Step 2: pip install -r requirements
  // An interrupted repair must not retain a successful install marker.
  fs.rmSync(path.join(dir, ENGINE_MARKER), { force: true });
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

  onProgress({ phase: "pip", line: "Checking that the transcription runtime imports successfully…" });
  await runStreaming(venvPython, ["-c", engine === "parakeet" ? "import nemo.collections.asr" : "from faster_whisper import WhisperModel"], onProgress, "pip");

  // Step 3: write the marker only after the installed runtime imports.
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
    const proc = trackChildProcess(
      spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }),
      `transcription setup (${phase})`,
    );
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
