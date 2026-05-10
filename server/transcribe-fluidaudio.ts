import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import type { TranscriptionResult } from "./transcribe";
import {
  mergeSpeakers,
  spansFromFluidAudio,
  type SpeakerSpan,
} from "./diarize-merge";
import {
  groupWordsIntoSegments,
  type Word as SplitWord,
  type Segment as SplitSegment,
} from "./segment-split";

interface FluidAudioJSON {
  audioFile: string;
  confidence?: number;
  durationSeconds: number;
  mode: string;
  modelVersion: string;
  processingTimeSeconds: number;
  rtfx: number;
  text: string;
  wordTimings: { word: string; startTime: number; endTime: number; confidence: number }[];
  timingsConfirmed?: boolean;
}

interface DiarizationJSON {
  audioFile: string;
  durationSeconds: number;
  processingTimeSeconds: number;
  speakerCount: number;
  segments: {
    speakerId: string;
    startTimeSeconds: number;
    endTimeSeconds: number;
    qualityScore: number;
    embedding?: number[];
  }[];
}

// Local aliases — the shared types in segment-split.ts already match this
// shape; we re-name only to keep the rest of this file's call sites short.
type Word = SplitWord;
type Segment = SplitSegment;

export interface FluidAudioOptions {
  model?: string;
  binaryPath?: string;
  /** Skip diarization (single-speaker audio, faster). Default: enabled. */
  diarize?: boolean;
}

function defaultBinaryPath(): string {
  return process.env.FLUIDAUDIO_BIN
    || path.join(os.homedir(), "GitHub", "FluidAudio", ".build", "release", "fluidaudiocli");
}

function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function deriveModelVersionFlag(model: string): string | null {
  const m = model.toLowerCase();
  if (/(^|[-_])v2($|[-_])/.test(m)) return "v2";
  if (/(^|[-_])v3($|[-_])/.test(m)) return "v3";
  if (m.includes("tdt-ctc-110m") || m.includes("110m")) return "tdt-ctc-110m";
  return null;
}

export async function transcribeWithFluidAudio(
  audioPath: string,
  outputMdPath: string,
  options: FluidAudioOptions = {},
): Promise<TranscriptionResult> {
  const { model = "fluid-parakeet-tdt-v3", binaryPath, diarize = true } = options;
  const bin = binaryPath || defaultBinaryPath();

  if (!fs.existsSync(bin)) {
    throw new Error(
      `FluidAudio binary not found at ${bin}. Set FLUIDAUDIO_BIN or build it:\n`
      + "  cd ~/GitHub/FluidAudio && swift build -c release",
    );
  }

  const parsed = path.parse(outputMdPath);
  const jsonPath = path.join(parsed.dir, parsed.name + ".json");
  const diarPath = path.join(parsed.dir, parsed.name + ".diar.json");
  fs.mkdirSync(parsed.dir, { recursive: true });

  const transcribeArgs = ["transcribe", audioPath, "--word-timestamps", "--output-json", jsonPath];
  const versionFlag = deriveModelVersionFlag(model);
  if (versionFlag) transcribeArgs.push("--model-version", versionFlag);

  // Diarization runs in offline mode for best quality on a finished file.
  // Streaming mode is for live audio and trades accuracy for latency.
  const diarArgs = ["process", audioPath, "--mode", "offline", "--output", diarPath];

  // Spawn both in parallel — they're independent CPU work on different parts
  // of the model stack. Transcription is ~80-150x realtime, diarization is
  // ~2-5x realtime, so total wall time ≈ diarization time when both run.
  const tasks: Promise<void>[] = [
    runFluidAudio(bin, transcribeArgs, "fluidaudio"),
  ];
  if (diarize) tasks.push(runFluidAudio(bin, diarArgs, "fluidaudio:diar"));

  await Promise.all(tasks);

  const result = postProcess({ jsonPath, diarPath, outputMdPath, audioPath, model, diarize });
  console.log(`[fluidaudio] Saved transcript: ${outputMdPath}`);
  return result;
}

function runFluidAudio(bin: string, args: string[], tag: string): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`[${tag}] Spawning: ${bin} ${args.join(" ")}`);
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
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
  const raw = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as FluidAudioJSON;

  // Load diarization spans if it ran. spansFromFluidAudio strips embeddings
  // and normalizes "1"/"2" → "S0"/"S1" so the merge module can stay
  // engine-agnostic.
  let speakerSpans: SpeakerSpan[] = [];
  if (diarize && fs.existsSync(diarPath)) {
    try {
      const diar = JSON.parse(fs.readFileSync(diarPath, "utf-8")) as DiarizationJSON;
      speakerSpans = spansFromFluidAudio(diar.segments || []);
    } catch (err) {
      console.warn(`[fluidaudio] Diarization JSON malformed, continuing without speakers: ${(err as Error).message}`);
    }
  }

  const words: Word[] = (raw.wordTimings || []).map((w) => ({
    start: w.startTime,
    end: w.endTime,
    text: w.word,
  }));
  const segments = groupWordsIntoSegments(words);
  const { speakerCount } = mergeSpeakers(words, segments, speakerSpans);

  const fullText = (raw.text || segments.map((s) => s.text).join(" ")).trim();
  const wordCount = fullText ? fullText.split(/\s+/).length : 0;
  // FluidAudio sometimes emits durationSeconds:0 when it can't read the
  // audio container's duration header (some YouTube-extracted streams).
  // Fall back to the last word's end timestamp — that's the speech-end
  // and the Library / clip UI care about that, not silent tail.
  const lastWordEnd = words.length > 0 ? words[words.length - 1].end : 0;
  const duration = raw.durationSeconds > 0 ? raw.durationSeconds : lastWordEnd;
  const transcriptionTime = raw.processingTimeSeconds;
  const realtimeFactor = raw.rtfx
    || (transcriptionTime > 0 ? duration / transcriptionTime : 0);
  const language = "auto";

  const metadata = {
    schema_version: 3,
    model,
    language,
    language_probability: 1,
    duration_seconds: duration,
    duration_formatted: formatTimestamp(duration),
    segment_count: segments.length,
    speaker_count: speakerCount,
    load_time_seconds: 0,
    transcription_time_seconds: Math.round(transcriptionTime * 10) / 10,
    realtime_factor: Math.round(realtimeFactor * 10) / 10,
    word_count: wordCount,
    text: fullText,
    segments,
    words,
  };

  fs.writeFileSync(jsonPath, JSON.stringify(metadata, null, 2));
  fs.writeFileSync(outputMdPath, buildMarkdown({
    audioPath, model, language, duration, segments, words, fullText, speakerCount,
  }));

  // The .diar.json holds embeddings (large) and is fully merged into the
  // main JSON now. Drop it to avoid leaving hundreds of KB of unused
  // float arrays alongside every transcript.
  try { fs.unlinkSync(diarPath); } catch { /* ignore */ }

  return metadata;
}


function buildMarkdown(args: {
  audioPath: string;
  model: string;
  language: string;
  duration: number;
  segments: Segment[];
  words: Word[];
  fullText: string;
  speakerCount: number;
}): string {
  const { audioPath, model, language, duration, segments, words, fullText, speakerCount } = args;
  const audioBasename = path.parse(audioPath).name;
  const speakerPrefix = (s: string | null | undefined) => (s ? `**${s}:** ` : "");
  const transcribedAt = new Date().toISOString().replace("T", " ").slice(0, 19);
  const lines: string[] = [
    `# Transcript: ${audioBasename}`,
    "",
    `- **Model**: ${model}`,
    `- **Language**: ${language}`,
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
    lines.push(`- [${formatTimestamp(seg.start)} -> ${formatTimestamp(seg.end)}] ${speakerPrefix(seg.speaker)}${seg.text}`);
  }
  if (words.length > 0) {
    lines.push("", "---", "", "## Word Timestamps", "");
    for (const word of words) {
      lines.push(`- [${formatTimestamp(word.start)} -> ${formatTimestamp(word.end)}] ${speakerPrefix(word.speaker)}${word.text}`);
    }
  }
  lines.push("", "---", "", "*Generated by Concord pipeline*");
  return lines.join("\n");
}
