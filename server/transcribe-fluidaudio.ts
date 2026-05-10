import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import type { TranscriptionResult } from "./transcribe";

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

interface Word { start: number; end: number; text: string }
interface Segment { start: number; end: number; text: string }

export interface FluidAudioOptions {
  model?: string;
  binaryPath?: string;
}

function defaultBinaryPath(): string {
  return process.env.FLUIDAUDIO_BIN
    || path.join(os.homedir(), "GitHub", "FluidAudio", ".build", "release", "fluidaudiocli");
}

// Mirrors group_words_into_segments() in server/transcribe-parakeet.py:144
// so segment boundaries feel the same across engines (1.2s gap, 30s cap).
function groupWordsIntoSegments(words: Word[], maxGap = 1.2, maxDuration = 30.0): Segment[] {
  const segments: Segment[] = [];
  let current: Word[] = [];
  const flush = () => {
    if (current.length === 0) return;
    segments.push({
      start: current[0].start,
      end: current[current.length - 1].end,
      text: current.map((w) => w.text).join(" "),
    });
  };
  for (const word of words) {
    if (current.length === 0) {
      current = [word];
      continue;
    }
    const gap = word.start - current[current.length - 1].end;
    const duration = word.end - current[0].start;
    if (gap > maxGap || duration > maxDuration) {
      flush();
      current = [word];
    } else {
      current.push(word);
    }
  }
  flush();
  return segments;
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

export function transcribeWithFluidAudio(
  audioPath: string,
  outputMdPath: string,
  options: FluidAudioOptions = {},
): Promise<TranscriptionResult> {
  const { model = "fluid-parakeet-tdt-v3", binaryPath } = options;
  const bin = binaryPath || defaultBinaryPath();

  if (!fs.existsSync(bin)) {
    return Promise.reject(new Error(
      `FluidAudio binary not found at ${bin}. Set FLUIDAUDIO_BIN or build it:\n`
      + "  cd ~/GitHub/FluidAudio && swift build -c release",
    ));
  }

  const parsed = path.parse(outputMdPath);
  const jsonPath = path.join(parsed.dir, parsed.name + ".json");

  const args = ["transcribe", audioPath, "--word-timestamps", "--output-json", jsonPath];
  const versionFlag = deriveModelVersionFlag(model);
  if (versionFlag) args.push("--model-version", versionFlag);

  console.log(`[fluidaudio] Spawning: ${bin} ${args.join(" ")}`);

  return new Promise<TranscriptionResult>((resolve, reject) => {
    fs.mkdirSync(parsed.dir, { recursive: true });

    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";

    proc.stdout.on("data", (d: Buffer) => {
      for (const line of d.toString().split("\n")) {
        if (line.trim()) console.log(`[fluidaudio] ${line.trim()}`);
      }
    });

    proc.stderr.on("data", (d: Buffer) => {
      const text = d.toString();
      stderr += text;
      for (const line of text.split("\n")) {
        if (line.trim()) console.error(`[fluidaudio:err] ${line.trim()}`);
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn FluidAudio: ${err.message}`));
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        const summary = stderr.slice(-500) || "(no stderr)";
        reject(new Error(`FluidAudio failed (exit ${code}): ${summary}`));
        return;
      }
      try {
        const result = postProcess({ jsonPath, outputMdPath, audioPath, model });
        resolve(result);
      } catch (err) {
        reject(new Error(`FluidAudio post-process failed: ${(err as Error).message}`));
      }
    });
  });
}

function postProcess(args: {
  jsonPath: string;
  outputMdPath: string;
  audioPath: string;
  model: string;
}): TranscriptionResult {
  const { jsonPath, outputMdPath, audioPath, model } = args;
  const raw = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as FluidAudioJSON;

  const words: Word[] = (raw.wordTimings || []).map((w) => ({
    start: w.startTime,
    end: w.endTime,
    text: w.word,
  }));
  const segments = groupWordsIntoSegments(words);
  const fullText = (raw.text || segments.map((s) => s.text).join(" ")).trim();
  const wordCount = fullText ? fullText.split(/\s+/).length : 0;
  const duration = raw.durationSeconds;
  const transcriptionTime = raw.processingTimeSeconds;
  const realtimeFactor = raw.rtfx
    || (transcriptionTime > 0 ? duration / transcriptionTime : 0);
  const language = "auto";

  const metadata = {
    schema_version: 2,
    model,
    language,
    language_probability: 1,
    duration_seconds: duration,
    duration_formatted: formatTimestamp(duration),
    segment_count: segments.length,
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
    audioPath, model, language, duration, segments, words, fullText,
  }));

  console.log(`[fluidaudio] Saved transcript: ${outputMdPath}`);
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
}): string {
  const { audioPath, model, language, duration, segments, words, fullText } = args;
  const audioBasename = path.parse(audioPath).name;
  const transcribedAt = new Date().toISOString().replace("T", " ").slice(0, 19);
  const lines: string[] = [
    `# Transcript: ${audioBasename}`,
    "",
    `- **Model**: ${model}`,
    `- **Language**: ${language}`,
    `- **Duration**: ${formatTimestamp(duration)}`,
    `- **Segments**: ${segments.length}`,
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
  ];
  for (const seg of segments) {
    lines.push(`- [${formatTimestamp(seg.start)} -> ${formatTimestamp(seg.end)}] ${seg.text}`);
  }
  if (words.length > 0) {
    lines.push("", "---", "", "## Word Timestamps", "");
    for (const word of words) {
      lines.push(`- [${formatTimestamp(word.start)} -> ${formatTimestamp(word.end)}] ${word.text}`);
    }
  }
  lines.push("", "---", "", "*Generated by YouTube_Ripper pipeline*");
  return lines.join("\n");
}
