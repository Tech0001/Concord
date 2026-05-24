import type { ChannelConfig } from "./channel-monitor";
import type { TranscriptionResult } from "./transcribe";

export interface PipelineConfig {
  channels: ChannelConfig[];
  /** Local working directory for downloads & extraction */
  workingDir: string;
  /** Final destination for downloaded videos (can be on another drive) */
  videoSaveDir: string;
  /** Where transcript markdown files go */
  transcriptDir: string;
  /** QMD vault path (if set, transcripts are also copied here) */
  qmdVaultDir: string | null;
  /** How often to poll for new videos (minutes) */
  checkIntervalMinutes: number;
  /** Skip YouTube Shorts */
  skipShorts: boolean;
  /** Video quality: "1080", "720", "480", "best" */
  videoQuality: string;
  /** Preferred video codec: "av01" | "vp9" | "avc1" | "any" */
  videoCodec: string;
  /** Preferred audio language for downloads — ISO 639-1 code (e.g.
   *  "en", "es", "ja"). When a video has multiple audio tracks (a
   *  common pattern on YouTube for international creators), yt-dlp
   *  picks the track matching this language; falls back to bestaudio
   *  when no track matches. Empty string = no preference (yt-dlp's
   *  default selection, which is unpredictable for multi-track
   *  videos). */
  audioLanguage: string;
  /** Source for the YouTube auth cookies that defeat bot-detection.
   *  Empty string = no cookies (anonymous, will hit "Sign in to confirm
   *  you're not a bot" eventually). Pass through to yt-dlp's
   *  `--cookies-from-browser <browser>` flag. */
  youtubeCookiesFromBrowser: string;
  /** Path to a Netscape-format cookies.txt file. Takes precedence over
   *  youtubeCookiesFromBrowser when set — pass through to yt-dlp's
   *  `--cookies <file>` flag. Use this when the browser DB is locked
   *  (Chromium-based browsers running) or you'd rather not grant
   *  Keychain access. */
  youtubeCookiesFile: string;
  /** Politeness preset for yt-dlp's --sleep-interval / --max-sleep-interval.
   *  Conservative is the safe default for new installs — fewer rate-limit
   *  hits at the cost of slower downloads. Fast trades safety for speed
   *  (use when you have cookies set and a small queue). */
  youtubeSpeedPreset: "fast" | "balanced" | "conservative";
  /** Soft daily cap on YouTube downloads. Once today's count reaches the
   *  cap the pipeline stops pulling new YouTube videos; resets at local
   *  midnight. Local-folder channels don't count. 0 disables the cap. */
  dailyDownloadCap: number;
  /** When true, the HTTP server binds to 0.0.0.0 (LAN-reachable) so the
   *  user can browse the app from a phone/tablet on the same WiFi.
   *  Default false → binds to 127.0.0.1 only. Requires server restart
   *  to take effect (binding happens once at boot). */
  lanAccess: boolean;
  transcription: {
    model: string;
    language: string;
    device: string;
    computeType: string;
    beamSize: number;
    pythonVenv: string;
    /** Engine the wizard installed. Empty string before the wizard has
     *  run; "parakeet" or "whisper" once chosen. Read by transcribe.ts
     *  to route between the GPU NeMo path and the CPU faster-whisper
     *  path independently of model name heuristics. */
    engine: "parakeet" | "whisper" | "";
    /** Absolute path to the wizard-installed venv directory (the dir,
     *  not the python binary). Empty string falls back to the legacy
     *  cwd-relative resolution. */
    venvPath: string;
  };
  llm: {
    /** OpenAI-compatible base URL, e.g. http://localhost:8000/v1 (oMLX) or http://localhost:11434/v1 (Ollama) */
    baseUrl: string;
    /** Optional bearer token; sent as Authorization header iff non-empty */
    apiKey: string;
    /** Chat/instruct model id, e.g. qwen3-7b-instruct-4bit-mlx */
    chatModel: string;
    /** Embedding model id, e.g. bge-m3-mlx */
    embeddingModel: string;
  };
  processing: {
    keepVideo: boolean;
    keepAudio: boolean;
    waitForLiveToFinish: boolean;
    maxRetries: number;
    retryDelayMinutes: number;
    /** Master switch for speaker diarization. When false, no diarization
     *  runs regardless of per-channel settings — saves the GPU time and
     *  produces transcripts with `speaker: null` everywhere. UI greys out
     *  per-channel diarize toggles when this is false. */
    diarizationEnabled: boolean;
  };
}

export interface PipelineJob {
  id: string;
  channelId: string;
  channelName: string;
  videoId: string;
  videoTitle: string;
  videoUrl: string;
  status: string;
  progress: number;
  error?: string;
  startedAt: string;
  completedAt?: string;
  videoPath?: string;
  audioPath?: string;
  mdPath?: string;
  transcriptionResult?: TranscriptionResult;
  /** The transcription model this specific job is using. Stamped before
   *  the transcribe step starts so the UI can show accurate "Transcribing
   *  with X" labels without guessing from the global config default
   *  (which may have been changed mid-flight or differ per re-transcribe). */
  model?: string;
  retries: number;
}

export type PipelineStatus = "idle" | "running" | "sleeping" | "stopped";

export interface PipelineState {
  status: PipelineStatus;
  lastCheck: string | null;
  nextCheck: string | null;
  totalCompleted: number;
  pendingCount: number;
  jobs: PipelineJob[];
  monitoredChannels: ChannelConfig[];
  /** Today's YouTube download count (resets at local midnight). */
  dailyDownloadCount: number;
  /** Configured cap. 0 = no cap. */
  dailyDownloadCap: number;
}

/**
 * Thrown when the daily download cap has been reached. The error
 * propagates up through processVideo's catch block — the job is reset
 * to pending (so it'll retry tomorrow when getTodayDownloadCount rolls
 * over) rather than marked failed.
 */
export class DailyCapReachedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DailyCapReachedError";
  }
}

export type SpeedPreset = "fast" | "balanced" | "conservative";
