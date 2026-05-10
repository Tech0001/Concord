import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { transcribeWithFluidAudio } from "./transcribe-fluidaudio";

export interface TranscriptionOptions {
  model?: string;
  language?: string;
  device?: string;
  computeType?: string;
  beamSize?: number;
  pythonPath?: string;
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

  await previous;
  try {
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
  } = options;

  if (isFluidModel(model)) {
    return withTranscriptionLock(() =>
      transcribeWithFluidAudio(audioPath, outputMdPath, { model }),
    );
  }

  const parakeet = isParakeetModel(model);
  // The pipeline config stores a single `pythonVenv` (the whisper venv).
  // Parakeet needs a separate Python with NeMo installed, so when the model
  // is parakeet we always route to the parakeet venv and ignore the
  // whisper-flavored override. PARAKEET_PYTHON env var can still customize.
  const resolvedPythonPath = parakeet
    ? defaultPythonPath(true)
    : (pythonPath || defaultPythonPath(false));
  const scriptPath = path.join(
    process.cwd(),
    "server",
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

    const proc = spawn(resolvedPythonPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: process.cwd(),
    });

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
      const packageHint = parakeet
        ? "/usr/bin/python3.12 -m venv venv-parakeet && ./venv-parakeet/bin/pip install -r requirements-parakeet.txt"
        : "python3 -m venv venv && ./venv/bin/pip install faster-whisper";
      reject(new Error(`Failed to start Python transcriber: ${err.message}\nMake sure the virtual environment is set up: ${packageHint}`));
    });
  });
}
