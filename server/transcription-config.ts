import path from "node:path";
import { NEMO_MODEL } from "./nemo-runtime";

export interface TranscriptionConfig {
  engine?: string;
  venvPath?: string;
  pythonVenv?: string;
}

/** Keep setup and execution in agreement, including on machines without CUDA. */
export function transcriptionDefaults(engine: "nemo" | "parakeet" | "whisper", gpuPresent: boolean, venvPath: string, vramMb?: number) {
  return {
    engine,
    venvPath,
    pythonVenv: path.join(venvPath, "bin", "python"),
    model: engine === "nemo" ? NEMO_MODEL : engine === "parakeet" ? "nvidia/parakeet-tdt-0.6b-v3" : gpuPresent && (vramMb === undefined || vramMb >= 8192) ? "large-v3" : "small",
    device: engine === "nemo" ? "auto" : gpuPresent ? "cuda" : "cpu",
    computeType: engine === "nemo" ? "q8_0" : gpuPresent ? "float16" : "int8",
  };
}

export function resolveTranscriptionPython(config: TranscriptionConfig, parakeet: boolean): string {
  const engine = parakeet ? "parakeet" : "whisper";
  if (config.engine === engine && config.venvPath) return path.join(config.venvPath, "bin", "python");
  if (parakeet) return process.env.PARAKEET_PYTHON || path.resolve("venv-parakeet/bin/python");
  return process.env.WHISPER_PYTHON || config.pythonVenv || path.resolve("venv/bin/python");
}
