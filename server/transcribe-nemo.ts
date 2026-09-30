import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { TranscriptionOptions, TranscriptionResult } from "./transcribe";
import { postProcess } from "./transcribe-parakeet";
import { detectGpu, detectPython, enginesDir, venvDir } from "./transcription-setup";
import { trackChildProcess } from "./child-process-registry";
import { NEMO_MODEL, nemoStatus, verifyNemoArtifact } from "./nemo-runtime";

export function nemoLanguage(language?: string): string {
  if (!language || language === "auto") return "auto";
  const locales: Record<string, string> = { en:"en-US", es:"es-ES", fr:"fr-FR", de:"de-DE", it:"it-IT", pt:"pt-PT", nl:"nl-NL", ru:"ru-RU", ar:"ar-AR", hi:"hi-IN", ja:"ja-JP", ko:"ko-KR", vi:"vi-VN", uk:"uk-UA", pl:"pl-PL", sv:"sv-SE", cs:"cs-CZ", nb:"nb-NO", da:"da-DK", bg:"bg-BG", fi:"fi-FI", hr:"hr-HR", sk:"sk-SK", zh:"zh-CN", hu:"hu-HU", ro:"ro-RO", et:"et-EE", tr:"tr-TR" };
  return locales[language] || language;
}

export function nemoPython(diarize: boolean): string {
  const managed = process.env.CONCORD_SPEAKER_PYTHON || path.join(venvDir(), process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  return diarize || fs.existsSync(managed) ? managed : detectPython().path;
}

export async function transcribeWithNemo(audioPath: string, outputMdPath: string, options: TranscriptionOptions): Promise<TranscriptionResult> {
  const status = nemoStatus();
  if (!status.installed) throw new Error("Finish installing Nemotron in Pipeline → Setup before transcribing.");
  const diarize = options.diarize !== false;
  for (const artifact of status.models.slice(0, diarize ? 2 : 1)) {
    if (!await verifyNemoArtifact(artifact.path, artifact)) throw new Error(`Nemotron model failed verification: ${artifact.file}. Repair it in Pipeline → Setup.`);
  }
  const device = options.device === "cuda" || !options.device || options.device === "auto" ? status.device : options.device;
  if (!["cpu", "vulkan:0", "metal"].includes(device)) throw new Error(`Unsupported native device: ${device}`);
  const embeddingDevice = device !== "cpu" && detectGpu().present ? "cuda" : "cpu";
  fs.mkdirSync(path.dirname(outputMdPath), { recursive: true });
  // Keep an existing transcript intact if either model fails mid-job.
  const temp = fs.mkdtempSync(path.join(path.dirname(outputMdPath), ".concord-nemo-"));
  const md = path.join(temp, path.basename(outputMdPath));
  const json = md.replace(/\.[^.]+$/, ".json");
  const diar = md.replace(/\.[^.]+$/, ".diar.json");
  try {
    const args = [path.join(enginesDir(), "transcribe-nemo.py"), audioPath,
      "--output-json", json, "--runtime", status.binary, "--asr-model", status.models[0].path,
      "--diar-model", status.models[1].path, "--device", device,
      "--language", nemoLanguage(options.language), "--embedding-device", embeddingDevice];
    if (diarize) args.push("--diar-output", diar);
    await new Promise<void>((resolve, reject) => {
      const env = { ...process.env, PYTHONUNBUFFERED: "1", OMP_NUM_THREADS: "8", MKL_NUM_THREADS: "8" };
      // NeMo restores TitaNet before .to(device); prevent accidental CUDA
      // initialization on a CPU-only request. Vulkan is independent of CUDA.
      if (embeddingDevice === "cpu") Object.assign(env, { CUDA_VISIBLE_DEVICES: "" });
      const child = trackChildProcess(spawn(nemoPython(diarize), args, { stdio: ["ignore", "pipe", "pipe"], env }), "Nemotron transcription and speaker matching");
      let tail = "";
      for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk: Buffer) => {
        const text = chunk.toString(); tail = (tail + text).slice(-4000);
        console.log(`[nemo] ${text.trimEnd()}`);
      });
      child.once("error", reject);
      child.once("close", code => code === 0 ? resolve() : reject(new Error(`Nemotron processing failed (${code}): ${tail.slice(-1000)}`)));
    });
    const result = postProcess({ jsonPath: json, diarPath: diar, outputMdPath: md,
      audioPath, model: NEMO_MODEL, diarize, videoId: options.videoId, channelId: options.channelId });
    fs.renameSync(json, outputMdPath.replace(/\.[^.]+$/, ".json"));
    fs.renameSync(md, outputMdPath);
    return result;
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
