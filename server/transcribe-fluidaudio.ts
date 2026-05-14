import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import type { TranscriptionResult } from "./transcribe";
import {
  mergeSpeakers,
  spansFromFluidAudio,
  normalizeFluidAudioSpeakerId,
  type SpeakerSpan,
} from "./diarize-merge";
import {
  groupWordsIntoSegments,
  type Word as SplitWord,
  type Segment as SplitSegment,
} from "./segment-split";
import {
  findClosestSpeaker,
  upsertVideoSpeakerAssignment,
  SPEAKER_AUTOMATCH_THRESHOLD,
} from "./db";

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
  /** Used to persist cross-video speaker identity. When both are provided,
   *  the wrapper aggregates per-local-speaker centroids from FluidAudio's
   *  per-segment embeddings, then auto-matches against existing global
   *  speakers via findClosestSpeaker. */
  videoId?: string;
  channelId?: string;
}

function defaultBinaryPath(): string {
  // Resolution order:
  //   1. FLUIDAUDIO_BIN env var — explicit override, wins everything.
  //   2. Packaged .app's bundled binary at Contents/Resources/binaries/
  //      — what the YouTuber friend gets out-of-the-box. Signed as part
  //      of the .app codesign so notarization covers it.
  //   3. Local dev clone at ~/GitHub/FluidAudio/.build/release/fluidaudiocli
  //      — what we use when running `pnpm dev`.
  if (process.env.FLUIDAUDIO_BIN) return process.env.FLUIDAUDIO_BIN;
  // process.resourcesPath is set by Electron when running inside a
  // packaged .app. It's undefined when running under `tsx` directly,
  // so the dev path is the natural fallback for dev mode.
  const bundled = typeof process.resourcesPath === "string"
    ? path.join(process.resourcesPath, "binaries", "fluidaudiocli")
    : null;
  if (bundled && fs.existsSync(bundled)) return bundled;
  return path.join(os.homedir(), "GitHub", "FluidAudio", ".build", "release", "fluidaudiocli");
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
  const { model = "fluid-parakeet-tdt-v3", binaryPath, diarize = true, videoId, channelId } = options;
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

  const result = postProcess({ jsonPath, diarPath, outputMdPath, audioPath, model, diarize, videoId, channelId });
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
  videoId?: string;
  channelId?: string;
}): TranscriptionResult {
  const { jsonPath, diarPath, outputMdPath, audioPath, model, diarize, videoId, channelId } = args;
  const raw = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as FluidAudioJSON;

  // Load diarization spans if it ran. spansFromFluidAudio strips embeddings
  // and normalizes "1"/"2" → "S0"/"S1" so the merge module can stay
  // engine-agnostic.
  let speakerSpans: SpeakerSpan[] = [];
  // Raw diarization segments — kept around so we can aggregate per-local-speaker
  // centroids from the per-segment embeddings before discarding diarPath.
  let diarSegments: DiarizationJSON["segments"] = [];
  if (diarize && fs.existsSync(diarPath)) {
    try {
      const diar = JSON.parse(fs.readFileSync(diarPath, "utf-8")) as DiarizationJSON;
      diarSegments = diar.segments || [];
      speakerSpans = spansFromFluidAudio(diarSegments);
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

  // Persist per-video speaker centroids + auto-match against the global
  // speakers table for cross-video identity. Mirrors transcribe-parakeet's
  // postProcess but does the aggregation in TS because FluidAudio's CLI
  // emits per-segment embeddings rather than a per-speaker rollup.
  // Skipped silently if videoId/channelId weren't plumbed through (CLI
  // smoke tests) or if no segments had embeddings (older fluidaudiocli).
  if (diarize && videoId && channelId && diarSegments.length > 0) {
    persistFluidAudioSpeakers(diarSegments, videoId, channelId);
  }

  // The .diar.json holds embeddings (large) and is fully merged into the
  // main JSON now. Drop it to avoid leaving hundreds of KB of unused
  // float arrays alongside every transcript.
  try { fs.unlinkSync(diarPath); } catch { /* ignore */ }

  return metadata;
}

interface SpeakerAggregate {
  airtimeSeconds: number;
  // Airtime-weighted sum (not yet normalized) of segment embeddings.
  centroidSum: Float32Array | null;
  // Longest single turn — used as the sample clip for the "play sample" UX.
  longestTurnDuration: number;
  sampleStart: number | null;
  sampleEnd: number | null;
}

function persistFluidAudioSpeakers(
  segments: DiarizationJSON["segments"],
  videoId: string,
  channelId: string,
): void {
  // Bucket by normalized local speaker label ("S0", "S1", ...).
  const buckets = new Map<string, SpeakerAggregate>();
  for (const seg of segments) {
    if (!seg.embedding || seg.embedding.length === 0) continue;
    const localSpeaker = normalizeFluidAudioSpeakerId(seg.speakerId);
    const duration = Math.max(0, seg.endTimeSeconds - seg.startTimeSeconds);
    if (duration <= 0) continue;

    let bucket = buckets.get(localSpeaker);
    if (!bucket) {
      bucket = {
        airtimeSeconds: 0,
        centroidSum: new Float32Array(seg.embedding.length),
        longestTurnDuration: 0,
        sampleStart: null,
        sampleEnd: null,
      };
      buckets.set(localSpeaker, bucket);
    }
    if (bucket.centroidSum && bucket.centroidSum.length === seg.embedding.length) {
      for (let i = 0; i < seg.embedding.length; i++) {
        bucket.centroidSum[i] += seg.embedding[i] * duration;
      }
    }
    bucket.airtimeSeconds += duration;
    if (duration > bucket.longestTurnDuration) {
      bucket.longestTurnDuration = duration;
      bucket.sampleStart = seg.startTimeSeconds;
      bucket.sampleEnd = seg.endTimeSeconds;
    }
  }

  let matched = 0;
  let unidentified = 0;
  for (const [localSpeaker, bucket] of Array.from(buckets.entries())) {
    if (!bucket.centroidSum || bucket.airtimeSeconds <= 0) continue;
    // L2-normalize so cosine distance to the global speakers table is on
    // the same footing as Sortformer's already-normalized centroids.
    const centroid = new Float32Array(bucket.centroidSum.length);
    let norm = 0;
    for (let i = 0; i < bucket.centroidSum.length; i++) {
      norm += bucket.centroidSum[i] * bucket.centroidSum[i];
    }
    norm = Math.sqrt(norm);
    if (norm === 0) continue;
    for (let i = 0; i < bucket.centroidSum.length; i++) {
      centroid[i] = bucket.centroidSum[i] / norm;
    }

    const match = findClosestSpeaker(centroid, SPEAKER_AUTOMATCH_THRESHOLD);
    upsertVideoSpeakerAssignment({
      videoId,
      channelId,
      localSpeaker,
      speakerId: match ? match.speaker_id : null,
      centroid,
      confidence: match ? 1.0 - match.distance : null,
      sampleStart: bucket.sampleStart,
      sampleEnd: bucket.sampleEnd,
      airtimeSeconds: bucket.airtimeSeconds,
    });
    if (match) matched++;
    else unidentified++;
  }
  if (matched > 0 || unidentified > 0) {
    console.log(
      `[fluidaudio] Speaker profiles persisted: ${matched} auto-matched, ${unidentified} unidentified`,
    );
  }
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
