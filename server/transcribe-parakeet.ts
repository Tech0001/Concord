import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import type { TranscriptionResult } from "./transcribe";
import {
  mergeSpeakers,
  spansFromFluidAudio,
  type SpeakerSpan,
} from "./diarize-merge";

// ---- JSON shapes on disk ----

// What transcribe-parakeet.py writes (schema v2 — no speaker fields).
interface ParakeetJSON {
  schema_version: number;
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
  text: string;
  segments: { start: number; end: number; text: string; speaker?: string | null }[];
  words: { start: number; end: number; text: string; speaker?: string | null }[];
}

// What diarize-sortformer.py writes (matches FluidAudio's `process` shape
// so spansFromFluidAudio() consumes both engines through one normalizer).
interface SortformerJSON {
  audioFile: string;
  durationSeconds: number;
  processingTimeSeconds: number;
  speakerCount: number;
  segments: {
    speakerId: string;
    startTimeSeconds: number;
    endTimeSeconds: number;
    qualityScore: number;
  }[];
}

export interface ParakeetOptions {
  model?: string;
  device?: string;
  pythonPath: string;
  /** Skip diarization (single-speaker channels). Default true — diarization
   *  on CUDA is ~200x realtime so the wall-time cost is trivial. */
  diarize?: boolean;
  /** Sortformer NeMo model id. The 4spk variant covers our archive
   *  workload (solo speakers + small panel discussions). */
  diarizeModel?: string;
}

const PARAKEET_SCRIPT = path.join(process.cwd(), "server", "transcribe-parakeet.py");
const SORTFORMER_SCRIPT = path.join(process.cwd(), "server", "diarize-sortformer.py");

export async function transcribeWithParakeet(
  audioPath: string,
  outputMdPath: string,
  options: ParakeetOptions,
): Promise<TranscriptionResult> {
  const {
    model = "nvidia/parakeet-tdt-0.6b-v3",
    device = "cuda",
    pythonPath,
    diarize = true,
    diarizeModel = "nvidia/diar_sortformer_4spk-v1",
  } = options;

  const parsed = path.parse(outputMdPath);
  const jsonPath = path.join(parsed.dir, parsed.name + ".json");
  const diarPath = path.join(parsed.dir, parsed.name + ".diar.json");
  fs.mkdirSync(parsed.dir, { recursive: true });

  const transcribeArgs = [
    PARAKEET_SCRIPT,
    audioPath,
    outputMdPath,
    "--model", model,
    "--device", device,
    "--json",
  ];

  const diarizeArgs = [
    SORTFORMER_SCRIPT,
    audioPath,
    "--output-json", diarPath,
    "--model", diarizeModel,
    "--device", device,
  ];

  // Run sequentially on Linux. Parallel CUDA processes fragment the
  // allocator and Sortformer init OOMs even with plenty of "free" VRAM.
  // Each Python process gets a fresh CUDA context this way; OS reclaims
  // all GPU memory cleanly when the parakeet process exits before
  // sortformer starts. Sortformer is ~200x realtime so the wall-time
  // cost vs parallel is ~5-10s per video — negligible.
  await runPython(pythonPath, transcribeArgs, "parakeet");
  if (diarize) {
    await runPython(pythonPath, diarizeArgs, "sortformer");
  }

  return postProcess({ jsonPath, diarPath, outputMdPath, audioPath, model, diarize });
}

function runPython(pythonPath: string, args: string[], tag: string): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`[${tag}] Spawning: ${pythonPath} ${args.join(" ")}`);
    const proc = spawn(pythonPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";

    proc.stdout.on("data", (d: Buffer) => {
      for (const line of d.toString().split("\n")) {
        if (line.trim()) console.log(`[${tag}] ${line.trim()}`);
      }
    });
    proc.stderr.on("data", (d: Buffer) => {
      const text = d.toString();
      stderr += text;
      for (const line of text.split("\n")) {
        if (line.trim()) console.error(`[${tag}:err] ${line.trim()}`);
      }
    });
    proc.on("error", (err) => reject(new Error(`Failed to spawn ${tag}: ${err.message}`)));
    proc.on("close", (code) => {
      if (code !== 0) {
        const summary = stderr.slice(-500) || "(no stderr)";
        reject(new Error(`${tag} failed (exit ${code}): ${summary}`));
        return;
      }
      resolve();
    });
  });
}

function postProcess(args: {
  jsonPath: string;
  diarPath: string;
  outputMdPath: string;
  audioPath: string;
  model: string;
  diarize: boolean;
}): TranscriptionResult {
  const { jsonPath, diarPath, outputMdPath, audioPath, model, diarize } = args;
  const raw = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as ParakeetJSON;

  // Load diarization spans if it ran. Sortformer emits FluidAudio-shape
  // JSON so we can reuse the same normalizer + merge as the Mac side.
  let speakerSpans: SpeakerSpan[] = [];
  if (diarize && fs.existsSync(diarPath)) {
    try {
      const diar = JSON.parse(fs.readFileSync(diarPath, "utf-8")) as SortformerJSON;
      speakerSpans = spansFromFluidAudio(diar.segments || []);
    } catch (err) {
      console.warn(
        `[parakeet] Diarization JSON malformed, continuing without speakers: ${(err as Error).message}`,
      );
    }
  }

  // mergeSpeakers mutates raw.words and raw.segments in place AND returns them.
  const { speakerCount } = mergeSpeakers(raw.words, raw.segments, speakerSpans);

  // Bump schema and add speaker_count (the only new top-level field).
  const updated = {
    ...raw,
    schema_version: 3,
    speaker_count: speakerCount,
  };

  fs.writeFileSync(jsonPath, JSON.stringify(updated, null, 2));
  fs.writeFileSync(outputMdPath, buildMarkdown({
    audioPath,
    model,
    duration: updated.duration_seconds,
    segments: updated.segments,
    words: updated.words,
    fullText: updated.text,
    speakerCount,
  }));

  // The .diar.json is fully merged into the main JSON now. Drop it so we
  // don't accumulate stale per-segment Sortformer scores alongside every
  // transcript.
  try { fs.unlinkSync(diarPath); } catch { /* ignore */ }

  console.log(
    `[parakeet] ✅ ${path.basename(outputMdPath)} ` +
    `(${updated.word_count} words, ${updated.realtime_factor}x realtime, ${speakerCount} speaker${speakerCount === 1 ? "" : "s"})`,
  );

  return {
    model: updated.model,
    language: updated.language,
    language_probability: updated.language_probability,
    duration_seconds: updated.duration_seconds,
    duration_formatted: updated.duration_formatted,
    segment_count: updated.segment_count,
    load_time_seconds: updated.load_time_seconds,
    transcription_time_seconds: updated.transcription_time_seconds,
    realtime_factor: updated.realtime_factor,
    word_count: updated.word_count,
  };
}

function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function buildMarkdown(args: {
  audioPath: string;
  model: string;
  duration: number;
  segments: { start: number; end: number; text: string; speaker?: string | null }[];
  words: { start: number; end: number; text: string; speaker?: string | null }[];
  fullText: string;
  speakerCount: number;
}): string {
  const { audioPath, model, duration, segments, words, fullText, speakerCount } = args;
  const audioBasename = path.parse(audioPath).name;
  const speakerPrefix = (s: string | null | undefined) => (s ? `**${s}:** ` : "");
  const transcribedAt = new Date().toISOString().replace("T", " ").slice(0, 19);

  const lines: string[] = [
    `# Transcript: ${audioBasename}`,
    "",
    `- **Model**: ${model}`,
    `- **Duration**: ${formatTimestamp(duration)}`,
    `- **Segments**: ${segments.length}`,
  ];
  if (speakerCount > 0) lines.push(`- **Speakers**: ${speakerCount}`);
  lines.push(
    `- **Transcribed at**: ${transcribedAt}`,
    "",
    "---",
    "",
    "## Full Text",
    "",
    fullText,
    "",
    "---",
    "",
    "## Timestamped Segments",
    "",
  );

  for (const seg of segments) {
    lines.push(
      `- [${formatTimestamp(seg.start)} -> ${formatTimestamp(seg.end)}] ${speakerPrefix(seg.speaker)}${seg.text}`,
    );
  }

  if (words.length > 0) {
    lines.push("", "---", "", "## Word Timestamps", "");
    for (const w of words) {
      lines.push(
        `- [${formatTimestamp(w.start)} -> ${formatTimestamp(w.end)}] ${speakerPrefix(w.speaker)}${w.text}`,
      );
    }
  }

  lines.push("", "---", "", "*Generated by Concord pipeline*");
  return lines.join("\n");
}
