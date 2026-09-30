import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { getConfigValues } from "./db";
import { transcribeWithFluidAudio } from "./transcribe-fluidaudio";
import { transcribeWithParakeet } from "./transcribe-parakeet";
import { enginesDir } from "./transcription-setup";
import { trackChildProcess } from "./child-process-registry";
import { resolveTranscriptionPython } from "./transcription-config";
import { transcribeWithNemo } from "./transcribe-nemo";
import { NEMO_MODEL } from "./nemo-runtime";

export interface TranscriptionOptions {
  model?: string;
  language?: string;
  device?: string;
  computeType?: string;
  beamSize?: number;
  pythonPath?: string;
  /** Run speaker diarization (only honored by engines that support it,
   *  currently FluidAudio). Default true. Set false for known
   *  single-speaker channels to skip the diarization wall-time cost. */
  diarize?: boolean;
  /** Video + channel IDs are passed through to engines that persist
   *  cross-video speaker identity. Optional because manual one-shot
   *  transcribe calls (e.g. CLI testing) don't always have these. */
  videoId?: string;
  channelId?: string;
}

export interface TranscriptionResult {
  model: string;
  language: string;
  language_probability: number;
  duration_seconds: number;
  duration_formatted: string;
  segment_count: number;
  load_time_seconds: number;
  transcription_time_seconds: number;
  realtime_factor: number;
  word_count: number;
}

function isParakeetModel(model: string): boolean {
  return model.toLowerCase().includes("parakeet");
}

function isFluidModel(model: string): boolean {
  return model.toLowerCase().startsWith("fluid-");
}

function defaultPythonPath(parakeet: boolean): string {
  // Resolution order:
  //   1. Wizard-installed venv (transcription.venvPath in config) — only
  //      honored when the marker engine matches what we need (i.e. no
  //      asking the parakeet path to use a whisper venv that lacks NeMo).
  //   2. Env var override (PARAKEET_PYTHON / WHISPER_PYTHON).
  //   3. cwd-relative fallback (legacy dev layout).
  const cfg = getConfigValues();
  const wizardEngine = cfg["transcription.engine"]; // "parakeet" | "whisper" | ""
  const wizardVenv = cfg["transcription.venvPath"];
  const wantedEngine = parakeet ? "parakeet" : "whisper";
  if (wizardVenv && wizardEngine === wantedEngine) {
    const py = path.join(wizardVenv, "bin", "python");
    if (fs.existsSync(py)) return py;
  }

  if (parakeet) {
    return process.env.PARAKEET_PYTHON
      || path.join(process.cwd(), "venv-parakeet", "bin", "python");
  }

  return process.env.WHISPER_PYTHON
    || path.join(process.cwd(), "venv", "bin", "python");
}

let transcriptionLock: Promise<void> = Promise.resolve();

async function withTranscriptionLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = transcriptionLock;
  let release: () => void = () => {};
  transcriptionLock = new Promise<void>((resolve) => {
    release = resolve;
  });

  // The whole body is wrapped in try/finally — any throw (including a
  // rejection from `await previous` if a future variant of this lock ever
  // produces one) still hits release(). Without this, an orphan rejection
  // on `previous` would skip release() and freeze every subsequent
  // transcribe forever, which is the kind of silent stall that's almost
  // impossible to debug from a running server.
  try {
    try { await previous; } catch { /* prior caller already saw the error */ }
    return await fn();
  } finally {
    release();
  }
}

/**
 * TypeScript wrapper for the Python transcription script.
 * Spawns a Python process and waits for completion.
 */
export function transcribeAudio(
  audioPath: string,
  outputMdPath: string,
  options: TranscriptionOptions = {}
): Promise<TranscriptionResult> {
  const {
    model = "large-v3",
    language = "en",
    device = "cuda",
    computeType = "float16",
    beamSize = 5,
    pythonPath,
    diarize,
    videoId,
    channelId,
  } = options;

  if (model === NEMO_MODEL) {
    return withTranscriptionLock(() => transcribeWithNemo(audioPath, outputMdPath, options));
  }

  if (isFluidModel(model)) {
    return withTranscriptionLock(() =>
      transcribeWithFluidAudio(audioPath, outputMdPath, { model, diarize, videoId, channelId }),
    );
  }

  const parakeet = isParakeetModel(model);
  if (parakeet) {
    // Parakeet (transcription) + Sortformer (diarization) run in parallel
    // through the TS wrapper so segment+speaker merge happens via the
    // shared diarize-merge module. Same flow as Mac's FluidAudio path.
    //
    // ALWAYS use the parakeet venv — the pipeline config stores a single
    // pythonVenv (the whisper venv) which doesn't have NeMo. Ignore the
    // whisper override here; PARAKEET_PYTHON env var can still customize
    // (handled inside defaultPythonPath).
    return withTranscriptionLock(() =>
      transcribeWithParakeet(audioPath, outputMdPath, {
        model,
        device,
        pythonPath: defaultPythonPath(true),
        diarize,
        videoId,
        channelId,
      }),
    );
  }

  // The pipeline config stores a single `pythonVenv` (the whisper venv).
  // Parakeet needs a separate Python with NeMo installed, so when the model
  // is parakeet we always route to the parakeet venv and ignore the
  // whisper-flavored override. PARAKEET_PYTHON env var can still customize.
  const resolvedPythonPath = parakeet
    ? defaultPythonPath(true)
    : resolveTranscriptionPython({
      engine: getConfigValues()["transcription.engine"],
      venvPath: getConfigValues()["transcription.venvPath"],
      pythonVenv: pythonPath || defaultPythonPath(false),
    }, false);
  const scriptPath = path.join(
    enginesDir(),
    parakeet ? "transcribe-parakeet.py" : "transcribe.py",
  );

  return withTranscriptionLock(() => spawnTranscriber({
    audioPath,
    outputMdPath,
    model,
    language,
    device,
    computeType,
    beamSize,
    resolvedPythonPath,
    scriptPath,
    parakeet,
  }));
}

function spawnTranscriber(argsInput: {
  audioPath: string;
  outputMdPath: string;
  model: string;
  language: string;
  device: string;
  computeType: string;
  beamSize: number;
  resolvedPythonPath: string;
  scriptPath: string;
  parakeet: boolean;
}): Promise<TranscriptionResult> {
  const {
    audioPath,
    outputMdPath,
    model,
    language,
    device,
    computeType,
    beamSize,
    resolvedPythonPath,
    scriptPath,
    parakeet,
  } = argsInput;

  return new Promise((resolve, reject) => {
    const args = parakeet
      ? [
        scriptPath,
        audioPath,
        outputMdPath,
        "--model", model,
        "--device", device,
        "--json",
      ]
      : [
        scriptPath,
        audioPath,
        outputMdPath,
        "--model", model,
        "--language", language,
        "--device", device,
        "--compute-type", computeType,
        "--beam-size", String(beamSize),
        "--json",
      ];

    console.log(`[transcribe] Spawning: ${resolvedPythonPath} ${args.join(" ")}`);

    const proc = trackChildProcess(
      spawn(resolvedPythonPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: process.cwd(),
      }),
      "Python transcription",
    );

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      // Print real-time log lines (they start with [transcribe])
      for (const line of text.split("\n")) {
        if (line.trim()) {
          console.log(`[python] ${line.trim()}`);
        }
      }
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
      // Print stderr lines (might be errors or progress)
      for (const line of data.toString().split("\n")) {
        if (line.trim()) {
          console.error(`[python:err] ${line.trim()}`);
        }
      }
    });

    proc.on("close", (code) => {
      if (code === 0) {
        // Check that output file was created
        if (fs.existsSync(outputMdPath)) {
          console.log(`[transcribe] Output verified: ${outputMdPath}`);

          // Parse the last JSON line from stdout for metadata
          const lines = stdout.trim().split("\n");
          const lastLine = lines[lines.length - 1];
          try {
            const metadata: TranscriptionResult = JSON.parse(lastLine);
            resolve(metadata);
          } catch {
            // If JSON parsing fails, check for nested JSON (the metadata JSON within the log)
            for (const line of lines) {
              try {
                const parsed = JSON.parse(line);
                if (parsed.duration_seconds !== undefined) {
                  resolve(parsed as TranscriptionResult);
                  return;
                }
              } catch {}
            }
            // Still resolve if we can't parse metadata but file exists
            resolve({
              model,
              language,
              language_probability: 1,
              duration_seconds: 0,
              duration_formatted: "00:00",
              segment_count: 0,
              load_time_seconds: 0,
              transcription_time_seconds: 0,
              realtime_factor: 0,
              word_count: 0,
            });
          }
        } else {
          reject(new Error(`Transcription output file not created: ${outputMdPath}`));
        }
      } else {
        const errorSummary = stderr.slice(-500) || stdout.slice(-500) || "No output";
        reject(new Error(`Transcription failed (code ${code}): ${errorSummary}`));
      }
    });

    proc.on("error", (err) => {
      // ENOENT here usually means the requested model's engine doesn't
      // match what the wizard installed (e.g. user picked whisper but
      // only Parakeet is set up). Point them at the wizard rather than
      // suggesting a manual `python3 -m venv ...` recipe that doesn't
      // line up with how Concord actually manages its venvs.
      const wanted = parakeet ? "Parakeet" : "Whisper";
      reject(new Error(
        `Failed to start Python transcriber (${wanted}): ${err.message}\n`
        + `Tried: ${resolvedPythonPath}\n`
        + `Re-run the transcription setup wizard, or change the model in Settings → Transcription to one your installed engine supports.`,
      ));
    });
  });
}
