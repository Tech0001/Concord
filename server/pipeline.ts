import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath, pathToFileURL } from "url";
import { EventEmitter } from "events";
import youtubedl from "youtube-dl-exec";
import {
  getChannelVideosPage,
  getAllChannelVideos,
  isVideoCurrentlyLive,
  ChannelConfig,
  ChannelVideo,
} from "./channel-monitor";
import { getYouTubeVideoInfo } from "./youtube-dl";
import { extractAudio, copyAudioTrack } from "./audio";
import { transcribeAudio, TranscriptionResult } from "./transcribe";
import {
  enqueueVideo,
  enqueueVideos,
  countChannelQueueEntries,
  getQueueEntryByVideoId,
  getNextPending,
  getConfigValues,
  getChannels,
  replaceChannels,
  setConfigValues,
  updateQueueStatus,
  countByStatus,
  getTotalCompleted,
  getChannelQueue,
  getDb,
  videoExists,
  closeDb,
  QueueEntry,
} from "./db";
import { channelFolderName, datedBaseName, replaceExtension } from "./naming";

// ---- Types ----

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
  transcription: {
    model: string;
    language: string;
    device: string;
    computeType: string;
    beamSize: number;
    pythonVenv: string;
  };
  processing: {
    keepVideo: boolean;
    keepAudio: boolean;
    waitForLiveToFinish: boolean;
    maxRetries: number;
    retryDelayMinutes: number;
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
}

function isNonRetryableTranscriptionError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("no cuda-capable device is detected") ||
    lower.includes("can't initialize nvml") ||
    lower.includes("cuda driver") ||
    lower.includes("cuda failed")
  );
}

// ---- Local-folder channel helpers ----
//
// A channel whose `url` starts with `file://` is a local folder rather than a
// YouTube channel. Scanning walks the folder for media files; "downloading"
// is a no-op because the file's already on disk; everything else (audio
// extraction, transcription, FTS indexing, clips/tags/links) reuses the same
// pipeline as YouTube videos.

const VIDEO_FILE_EXTS = new Set([".mp4", ".mkv", ".mov", ".webm", ".avi", ".m4v"]);
const AUDIO_FILE_EXTS = new Set([".mp3", ".m4a", ".wav", ".flac", ".aac", ".opus", ".ogg"]);

export function isLocalChannel(channel: { url: string }): boolean {
  return typeof channel.url === "string" && channel.url.startsWith("file://");
}

function isLocalVideoUrl(url: string): boolean {
  return typeof url === "string" && url.startsWith("file://");
}

function fileUrlToPath(fileUrl: string): string {
  // Node's fileURLToPath handles all the cross-platform pain: Windows drive
  // letters, percent-decoding, separator normalization. Falls back to a
  // crude strip for malformed inputs so we never throw.
  try {
    return fileURLToPath(fileUrl);
  } catch {
    return fileUrl.replace(/^file:\/\//, "");
  }
}

function pathToFileUrl(absPath: string): string {
  return pathToFileURL(absPath).toString();
}

function isMediaFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return VIDEO_FILE_EXTS.has(ext) || AUDIO_FILE_EXTS.has(ext);
}

function isAudioOnlyPath(filePath: string): boolean {
  return AUDIO_FILE_EXTS.has(path.extname(filePath).toLowerCase());
}

/** Stable per-file ID. SHA-256 of the absolute path, prefixed with "local-"
 *  so it's distinguishable from YouTube IDs at a glance. Same path always
 *  produces the same ID across rescans. */
function localStableId(absPath: string): string {
  const hash = crypto.createHash("sha256").update(absPath).digest("hex");
  return `local-${hash.substring(0, 11)}`;
}

function mtimeToYYYYMMDD(mtimeMs: number): string {
  const d = new Date(mtimeMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${dd}`;
}

/** Recursively walk a folder and return one ChannelVideo per media file
 *  found. Doesn't ffprobe (would be slow on big folders); duration is
 *  resolved later during processing. */
function scanLocalFolder(folderUrl: string): ChannelVideo[] {
  const folder = fileUrlToPath(folderUrl);
  if (!fs.existsSync(folder)) {
    console.error(`[pipeline] Local channel folder not found: ${folder}`);
    return [];
  }

  const out: ChannelVideo[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      console.error(`[pipeline] Cannot read directory ${dir}:`, err);
      return;
    }
    for (const entry of entries) {
      // Skip hidden / system files
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && isMediaFile(entry.name)) {
        try {
          const stat = fs.statSync(fullPath);
          out.push({
            id: localStableId(fullPath),
            title: path.basename(entry.name, path.extname(entry.name)),
            url: pathToFileUrl(fullPath),
            duration: null,
            isLive: false,
            isShorts: false,
            uploadDate: mtimeToYYYYMMDD(stat.mtimeMs),
            thumbnail: null,
          });
        } catch (err) {
          console.error(`[pipeline] Stat failed for ${fullPath}:`, err);
        }
      }
    }
  };
  walk(folder);
  return out;
}

// ---- Pipeline ----

export class Pipeline extends EventEmitter {
  private config: PipelineConfig;
  private jobs: PipelineJob[] = [];
  private timer: NodeJS.Timeout | null = null;
  private status: PipelineStatus = "idle";
  private lastCheck: string | null = null;
  private nextCheck: string | null = null;
  private activeJobs = 0;
  private maxConcurrent = 1;

  constructor(_configPath: string = "./pipeline.config.json") {
    super();
    this.config = this.loadConfig();
    this.persistConfig(this.config);
    this.recoverStuckJobs();
  }

  /** Reset any rows left in an in-flight status (downloading, transcribing,
   *  etc.) back to "pending" so they get re-picked-up on the next scan.
   *  Runs once on pipeline boot. Safe because the pipeline is the only
   *  process that drives those statuses — if we just booted, nothing else
   *  is in the middle of anything. Without this, rows stay stuck forever
   *  any time the server crashes or the user closes the app mid-job. */
  private recoverStuckJobs(): void {
    const stuck = ["downloading", "extracting_audio", "transcribing", "saving_md"];
    const placeholders = stuck.map(() => "?").join(",");
    const result = getDb()
      .prepare(`
        UPDATE video_queue
        SET status = 'pending', updated_at = datetime('now')
        WHERE status IN (${placeholders})
      `)
      .run(...stuck);
    if (result.changes > 0) {
      console.log(
        `[pipeline] Recovered ${result.changes} stuck job${result.changes === 1 ? "" : "s"} from a previous run`,
      );
    }
  }

  // ---- Config ----

  private loadConfig(): PipelineConfig {
    const defaults: PipelineConfig = {
      channels: [],
      workingDir: "./downloads",
      videoSaveDir: "/media/pc/Maac/YouTube/saved_videos",
      transcriptDir: "/media/pc/Maac/YouTube/transcripts",
      qmdVaultDir: null,
      checkIntervalMinutes: 15,
      skipShorts: true,
      videoQuality: "1080",
      videoCodec: "any",
      transcription: {
        model: "large-v3",
        language: "en",
        device: "cuda",
        computeType: "float16",
        beamSize: 5,
        pythonVenv: "./venv/bin/python",
      },
      processing: {
        keepVideo: true,
        keepAudio: false,
        waitForLiveToFinish: true,
        maxRetries: 3,
        retryDelayMinutes: 5,
      },
    };

    const stored = getConfigValues();

    return {
      ...defaults,
      channels: getChannels(),
      workingDir: stored.workingDir || defaults.workingDir,
      videoSaveDir: stored.videoSaveDir || defaults.videoSaveDir,
      transcriptDir: stored.transcriptDir || defaults.transcriptDir,
      qmdVaultDir: stored.qmdVaultDir || null,
      checkIntervalMinutes: parseConfigNumber(stored.checkIntervalMinutes, defaults.checkIntervalMinutes),
      skipShorts: parseConfigBoolean(stored.skipShorts, defaults.skipShorts),
      videoQuality: stored.videoQuality || defaults.videoQuality,
      videoCodec: stored.videoCodec || defaults.videoCodec,
      transcription: {
        model: stored["transcription.model"] || defaults.transcription.model,
        language: stored["transcription.language"] || defaults.transcription.language,
        device: stored["transcription.device"] || defaults.transcription.device,
        computeType: stored["transcription.computeType"] || defaults.transcription.computeType,
        beamSize: parseConfigNumber(stored["transcription.beamSize"], defaults.transcription.beamSize),
        pythonVenv: stored["transcription.pythonVenv"] || defaults.transcription.pythonVenv,
      },
      processing: {
        keepVideo: parseConfigBoolean(stored["processing.keepVideo"], defaults.processing.keepVideo),
        keepAudio: parseConfigBoolean(stored["processing.keepAudio"], defaults.processing.keepAudio),
        waitForLiveToFinish: parseConfigBoolean(stored["processing.waitForLiveToFinish"], defaults.processing.waitForLiveToFinish),
        maxRetries: parseConfigNumber(stored["processing.maxRetries"], defaults.processing.maxRetries),
        retryDelayMinutes: parseConfigNumber(stored["processing.retryDelayMinutes"], defaults.processing.retryDelayMinutes),
      },
    };
  }

  reloadConfig(): void {
    this.config = this.loadConfig();
    this.emit("configChanged", this.config);
  }

  getState(): PipelineState {
    const counts = countByStatus();
    return {
      status: this.status,
      lastCheck: this.lastCheck,
      nextCheck: this.nextCheck,
      totalCompleted: getTotalCompleted(),
      pendingCount: counts.pending || 0,
      jobs: [...this.jobs],
      monitoredChannels: this.config.channels,
    };
  }

  getConfig(): PipelineConfig { return { ...this.config }; }

  updateConfig(updates: Partial<PipelineConfig>): void {
    this.config = {
      ...this.config,
      ...updates,
      transcription: { ...this.config.transcription, ...(updates.transcription || {}) },
      processing: { ...this.config.processing, ...(updates.processing || {}) },
      channels: updates.channels || this.config.channels,
    };
    this.persistConfig(this.config);
    this.emit("configChanged", this.config);
  }

  private persistConfig(config: PipelineConfig): void {
    setConfigValues({
      workingDir: config.workingDir,
      videoSaveDir: config.videoSaveDir,
      transcriptDir: config.transcriptDir,
      qmdVaultDir: config.qmdVaultDir,
      checkIntervalMinutes: config.checkIntervalMinutes,
      skipShorts: config.skipShorts,
      videoQuality: config.videoQuality,
      videoCodec: config.videoCodec,
      "transcription.model": config.transcription.model,
      "transcription.language": config.transcription.language,
      "transcription.device": config.transcription.device,
      "transcription.computeType": config.transcription.computeType,
      "transcription.beamSize": config.transcription.beamSize,
      "transcription.pythonVenv": config.transcription.pythonVenv,
      "processing.keepVideo": config.processing.keepVideo,
      "processing.keepAudio": config.processing.keepAudio,
      "processing.waitForLiveToFinish": config.processing.waitForLiveToFinish,
      "processing.maxRetries": config.processing.maxRetries,
      "processing.retryDelayMinutes": config.processing.retryDelayMinutes,
    });
    replaceChannels(config.channels);
  }

  // ---- Start / Stop ----

  start(): void {
    if (this.status === "running") return;

    this.status = "running";
    console.log(`[pipeline] Started — processing queued videos and checking every ${this.config.checkIntervalMinutes}min`);

    setTimeout(() => this.processNextInQueue(), 500);

    const intervalMs = this.config.checkIntervalMinutes * 60 * 1000;
    this.timer = setInterval(() => this.checkAllChannels(), intervalMs);

    this.emit("started");
  }

  stop(): void {
    this.status = "stopped";
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    console.log("[pipeline] Stopped");
    this.emit("stopped");
  }

  // ---- Periodic check: scan recent videos, enqueue new ones ----

  private async checkAllChannels(): Promise<void> {
    if (this.status !== "running") return;
    await this.scanEnabledChannels(true, false);
  }

  async checkNow(): Promise<{ scannedChannels: number; newVideos: number; processingStarted: boolean }> {
    this.reloadConfig();
    return this.scanEnabledChannels(false, true);
  }

  private async scanEnabledChannels(processQueue: boolean, allowInitialInventory: boolean): Promise<{ scannedChannels: number; newVideos: number; processingStarted: boolean }> {

    this.lastCheck = new Date().toISOString();
    const intervalMs = this.config.checkIntervalMinutes * 60 * 1000;
    this.nextCheck = new Date(Date.now() + intervalMs).toISOString();

    const enabled = this.config.channels.filter(c => c.enabled);
    console.log(`[pipeline] Checking ${enabled.length} channels...`);

    let newVideos = 0;
    for (const ch of enabled) {
      newVideos += await this.scanRecent(ch, allowInitialInventory);
    }

    if (processQueue) {
      await this.processNextInQueue();
    }

    this.emit("checkComplete", this.getState());
    return { scannedChannels: enabled.length, newVideos, processingStarted: processQueue };
  }

  /** Fetch recent videos from one channel and enqueue new ones. */
  private async scanRecent(channel: ChannelConfig, allowInitialInventory: boolean): Promise<number> {
    try {
      if (isLocalChannel(channel)) {
        const videos = scanLocalFolder(channel.url);
        let added = 0;
        for (const v of videos) {
          if (videoExists(v.id)) continue;
          if (enqueueVideo({
            videoId: v.id, channelId: channel.id, title: v.title, url: v.url,
            duration: v.duration, isLive: v.isLive, isShorts: v.isShorts, uploadDate: v.uploadDate,
          })) added++;
        }
        if (added > 0) {
          console.log(`[pipeline] ${channel.name}: +${added} new local file${added === 1 ? "" : "s"}`);
        }
        return added;
      }

      if (countChannelQueueEntries(channel.id) === 0) {
        if (!allowInitialInventory) {
          console.log(`[pipeline] ${channel.name}: no inventory yet; run Check or Full Scan before Start`);
          return 0;
        }
        console.log(`[pipeline] ${channel.name}: first scan, fetching full channel inventory...`);
        const allVideos = await getAllChannelVideos(channel.url, (info) => {
          this.emit("archiveProgress", { channelId: channel.id, channelName: channel.name, ...info });
        });
        const toEnqueue = allVideos
          .filter(v => !(this.config.skipShorts && v.isShorts))
          .map(v => ({
            videoId: v.id, channelId: channel.id, title: v.title, url: v.url,
            duration: v.duration, isLive: v.isLive, isShorts: v.isShorts, uploadDate: v.uploadDate,
          }));
        const added = enqueueVideos(toEnqueue);
        console.log(`[pipeline] ${channel.name}: first scan queued ${added}/${toEnqueue.length} videos`);
        return added;
      }

      const batchSize = 25;
      let start = 1;
      let added = 0;

      while (start <= 5000) {
        const videos = await getChannelVideosPage(channel.url, start, batchSize);
        if (!videos.length) break;

        let foundKnownVideo = false;
        for (const v of videos) {
          if (videoExists(v.id)) {
            foundKnownVideo = true;
            continue;
          }

          if (this.config.skipShorts && v.isShorts) continue;
          if (enqueueVideo({
            videoId: v.id, channelId: channel.id, title: v.title, url: v.url,
            duration: v.duration, isLive: v.isLive, isShorts: v.isShorts, uploadDate: v.uploadDate,
          })) added++;
        }

        if (foundKnownVideo) {
          console.log(`[pipeline] ${channel.name}: found known video, stopping monitor scan`);
          break;
        }

        if (videos.length < batchSize) break;
        start += videos.length;
      }

      console.log(`[pipeline] ${channel.name}: +${added} new videos`);
      return added;
    } catch (e) {
      console.error(`[pipeline] Error scanning ${channel.name}:`, e);
      return 0;
    }
  }

  // ---- Full scan: scan ALL videos and enqueue missing records ----

  async archiveChannel(channelId: string): Promise<{ scanned: number; newVideos: number }> {
    const channel = this.config.channels.find(c => c.id === channelId);
    if (!channel) throw new Error(`Channel not found: ${channelId}`);

    console.log(`[pipeline] Full scan for channel: ${channel.name} — fetching all videos...`);

    const videos = isLocalChannel(channel)
      ? scanLocalFolder(channel.url)
      : await getAllChannelVideos(channel.url, (info) => {
          this.emit("archiveProgress", { channelId, channelName: channel.name, ...info });
        });

    let newVideos = 0;
    const toEnqueue = videos
      .filter(v => !(this.config.skipShorts && v.isShorts))
      .map(v => ({
        videoId: v.id, channelId: channel.id, title: v.title, url: v.url,
        duration: v.duration, isLive: v.isLive, isShorts: v.isShorts, uploadDate: v.uploadDate,
      }));

    newVideos = enqueueVideos(toEnqueue);

    const skipped = videos.length - toEnqueue.length;
    console.log(`[pipeline] Full scan done: ${videos.length} total, ${newVideos} new, ${skipped} skipped`);

    return { scanned: videos.length, newVideos };
  }

  // ---- Queue processor: pick next video and run the pipeline ----

  private async processNextInQueue(): Promise<void> {
    if (this.activeJobs >= this.maxConcurrent) {
      // Already busy — the active job's `finally` will call this again
      return;
    }

    // Process queued inventory oldest-first by upload date.
    const next = getNextPending();

    if (!next) {
      return;
    }

    // Translate QueueEntry to ChannelVideo for processVideo
    const video: ChannelVideo = {
      id: next.video_id,
      title: next.title,
      url: next.url,
      duration: next.duration,
      isLive: !!next.is_live,
      isShorts: !!next.is_shorts,
      uploadDate: next.upload_date,
      thumbnail: null,
    };

    const channel = this.config.channels.find(c => c.id === next.channel_id) || {
      id: next.channel_id,
      name: next.channel_id,
      url: "",
      enabled: true,
    };

    await this.processVideo(channel, video, next);
  }

  // ---- Process a single video through the pipeline ----

  private async processVideo(
    channel: ChannelConfig,
    video: ChannelVideo,
    queueEntry: QueueEntry,
  ): Promise<void> {
    const job: PipelineJob = {
      id: `${channel.id}-${video.id}-${Date.now()}`,
      channelId: channel.id,
      channelName: channel.name,
      videoId: video.id,
      videoTitle: video.title,
      videoUrl: video.url,
      status: "pending",
      progress: 0,
      startedAt: new Date().toISOString(),
      retries: queueEntry.retries,
    };

    this.jobs.unshift(job);
    if (this.jobs.length > 100) this.jobs = this.jobs.slice(0, 100);

    this.activeJobs++;
    this.emit("jobStarted", job);

    try {
      // Step 1: Check if live
      if (video.isLive && this.config.processing.waitForLiveToFinish) {
        job.status = "waiting_live";
        updateQueueStatus(video.id, channel.id, { status: "waiting_live" });
        this.emit("jobUpdated", job);
        console.log(`[pipeline] ⏳ ${video.title} is live. Deferring...`);
        // Schedule re-check later
        setTimeout(() => this.recheckLive(video, channel), 5 * 60 * 1000);
        return;
      }

      const isLocal = isLocalVideoUrl(video.url);
      const localFilePath = isLocal ? fileUrlToPath(video.url) : null;
      const audioOnlyLocal = !!localFilePath && isAudioOnlyPath(localFilePath);

      // Step 2: Download (skipped for local-folder channels — file is already on disk)
      job.status = "downloading";
      updateQueueStatus(video.id, channel.id, { status: "downloading" });
      this.emit("jobUpdated", job);

      const safeName = datedBaseName(video.title, video.uploadDate);
      const channelFolder = channelFolderName(channel.name);

      // Channel-specific subdirectories. saveChannelDir is irrelevant for
      // local channels (we never move the user's file), but the working
      // and transcript dirs are still used for intermediate audio + the
      // produced markdown.
      const workChannelDir  = path.join(this.config.workingDir,    channelFolder);
      const saveChannelDir  = path.join(this.config.videoSaveDir, channelFolder);
      const transChannelDir = path.join(this.config.transcriptDir, channelFolder);

      [workChannelDir, transChannelDir].forEach(d => {
        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
      });
      if (!isLocal && !fs.existsSync(saveChannelDir)) {
        fs.mkdirSync(saveChannelDir, { recursive: true });
      }

      const workVideoPath = isLocal && localFilePath
        ? localFilePath
        : path.join(workChannelDir, `${safeName}.mp4`);

      if (isLocal) {
        if (!fs.existsSync(workVideoPath)) {
          throw new Error(`Local file no longer exists: ${workVideoPath}`);
        }
        job.videoPath = workVideoPath;
        job.progress = 40;
        this.emit("jobUpdated", job);
      } else {
        await this.downloadVideo(video.id, workVideoPath, (pct) => {
          job.progress = Math.floor(pct * 0.4);
          this.emit("jobUpdated", job);
        });

        job.videoPath = workVideoPath;
        job.progress = 40;
        this.emit("jobUpdated", job);
      }

      // Step 3: Extract audio — stream-copy m4a first (instant), then convert to wav
      job.status = "extracting_audio";
      updateQueueStatus(video.id, channel.id, { status: "extracting_audio" });
      this.emit("jobUpdated", job);

      const m4aPath = path.join(workChannelDir, `${safeName}.m4a`);
      const audioPath = path.join(workChannelDir, `${safeName}.wav`);

      if (audioOnlyLocal) {
        // The "video" file is already audio (mp3/m4a/wav/flac/etc).
        // Skip the demux step and re-encode straight to whisper-ready WAV.
        await extractAudio(workVideoPath, audioPath, { sampleRate: 16000, channels: 1, format: "wav" });
      } else {
        // Stream-copy the audio track (nearly instant — just demuxes)
        if (!fs.existsSync(m4aPath)) {
          await copyAudioTrack(workVideoPath, m4aPath);
        }
        // Convert m4a to 16kHz mono WAV for whisper (audio-only, no video decode overhead)
        await extractAudio(m4aPath, audioPath, { sampleRate: 16000, channels: 1, format: "wav" });
      }

      job.audioPath = audioPath;
      job.progress = 55;
      this.emit("jobUpdated", job);

      // Step 4: Transcribe
      job.status = "transcribing";
      updateQueueStatus(video.id, channel.id, { status: "transcribing" });
      this.emit("jobUpdated", job);

      const mdFileName = `${safeName}.md`;
      const mdPath = path.join(transChannelDir, mdFileName);

      const result = await transcribeAudio(audioPath, mdPath, {
        model: this.config.transcription.model,
        language: this.config.transcription.language,
        device: this.config.transcription.device,
        computeType: this.config.transcription.computeType,
        beamSize: this.config.transcription.beamSize,
        pythonPath: this.config.transcription.pythonVenv,
      });

      job.mdPath = mdPath;
      job.transcriptionResult = result;
      job.progress = 80;
      this.emit("jobUpdated", job);

      // Step 5: Copy to QMD vault if configured
      if (this.config.qmdVaultDir) {
        try {
          const qmdChannelDir = path.join(this.config.qmdVaultDir, channelFolder);
          const qmdPath = path.join(qmdChannelDir, mdFileName);
          if (!fs.existsSync(qmdChannelDir)) fs.mkdirSync(qmdChannelDir, { recursive: true });
          fs.copyFileSync(mdPath, qmdPath);
          console.log(`[pipeline] Transcript copied to QMD vault: ${qmdPath}`);
        } catch (e) { console.error("[pipeline] QMD copy failed:", e); }
      }

      // Step 6: Move video to save directory (skipped for local channels —
      // the file already lives wherever the user pointed the channel at).
      job.status = "saving_md";
      this.emit("jobUpdated", job);

      const savePath = path.join(saveChannelDir, `${safeName}.mp4`);
      const saveM4aPath = path.join(saveChannelDir, `${safeName}.m4a`);
      if (!isLocal && fs.existsSync(workVideoPath) && this.config.workingDir !== this.config.videoSaveDir) {
        try {
          // Handle cross-device moves by copy+delete
          fs.copyFileSync(workVideoPath, savePath);
          fs.unlinkSync(workVideoPath);
          job.videoPath = savePath;
          console.log(`[pipeline] Video moved to: ${savePath}`);
        } catch (e) {
          console.error(`[pipeline] Failed to move video to ${savePath}:`, e);
          // Keep working path
        }
      }
      if (!isLocal && this.config.processing.keepAudio && fs.existsSync(m4aPath) && m4aPath !== saveM4aPath) {
        try {
          fs.copyFileSync(m4aPath, saveM4aPath);
          fs.unlinkSync(m4aPath);
          job.audioPath = saveM4aPath;
          console.log(`[pipeline] Audio moved to: ${saveM4aPath}`);
        } catch (e) {
          console.error(`[pipeline] Failed to move audio to ${saveM4aPath}:`, e);
        }
      } else if (fs.existsSync(m4aPath)) {
        try { fs.unlinkSync(m4aPath); } catch {}
      }

      // Step 7: Cleanup temporary whisper WAV
      if (audioPath) {
        try { fs.unlinkSync(audioPath); } catch {}
      }

      // Complete!
      job.status = "complete";
      job.progress = 100;
      job.completedAt = new Date().toISOString();

      updateQueueStatus(video.id, channel.id, {
        status: "complete",
        videoPath: job.videoPath || null,
        mdPath: job.mdPath || null,
        wordCount: result.word_count,
      });

      console.log(`[pipeline] ✅ ${video.title} (${result.word_count} words, ${result.realtime_factor}x realtime)`);
      this.emit("jobUpdated", job);
      this.emit("jobComplete", job);

    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[pipeline] ❌ ${video.title} — ${errMsg}`);

      const retries = queueEntry.retries + 1;
      if (isNonRetryableTranscriptionError(errMsg)) {
        updateQueueStatus(video.id, channel.id, { status: "failed", retries, error: errMsg });
        job.status = "failed";
        job.completedAt = new Date().toISOString();
      } else if (retries <= this.config.processing.maxRetries) {
        updateQueueStatus(video.id, channel.id, { status: "pending", retries, error: errMsg });
        job.status = "pending";
      } else {
        updateQueueStatus(video.id, channel.id, { status: "failed", retries, error: errMsg });
        job.status = "failed";
        job.completedAt = new Date().toISOString();
      }

      job.error = errMsg;
      job.retries = retries;
      this.emit("jobUpdated", job);
      this.emit("jobError", job, error);

    } finally {
      this.activeJobs--;

      // Process next in queue
      if (this.status === "running") {
        setTimeout(() => this.processNextInQueue(), 1000);
      }
    }
  }

  /** Re-check a live video to see if it's finished. */
  private async recheckLive(video: ChannelVideo, channel: ChannelConfig): Promise<void> {
    try {
      const stillLive = await isVideoCurrentlyLive(video.url);
      if (stillLive) {
        console.log(`[pipeline] ⏳ ${video.title} still live. Checking again in 5min...`);
        setTimeout(() => this.recheckLive(video, channel), 5 * 60 * 1000);
      } else {
        console.log(`[pipeline] 🎬 ${video.title} live stream ended. Re-queuing...`);
        updateQueueStatus(video.id, channel.id, { status: "pending" });
        await this.processNextInQueue();
      }
    } catch {
      updateQueueStatus(video.id, channel.id, { status: "pending" });
      await this.processNextInQueue();
    }
  }

  /** Build a yt-dlp format string from the configured resolution + codec.
   *  `codecOverride` lets the auto-fallback retry logic force a different
   *  codec without mutating the user's saved preference. Falls back through
   *  other codecs/containers so we always get something even if the chosen
   *  codec isn't published for a given video. */
  private buildFormatString(codecOverride?: string): string {
    const q = this.config.videoQuality;
    const codec = codecOverride || this.config.videoCodec || "any";
    const heightCap = q === "best" ? "" : `[height<=${parseInt(q) || 1080}]`;

    // Per-codec selectors. AV1/VP9 ship in WebM, H.264 in MP4.
    const av1   = `bestvideo${heightCap}[vcodec^=av01]+bestaudio[ext=m4a]/bestvideo${heightCap}[vcodec^=av01]+bestaudio`;
    const vp9   = `bestvideo${heightCap}[vcodec^=vp9]+bestaudio[ext=m4a]/bestvideo${heightCap}[vcodec^=vp9]+bestaudio`;
    const avc1  = `bestvideo${heightCap}[ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]/best${heightCap}[ext=mp4][vcodec^=avc1]`;
    const anyMp4 = `bestvideo${heightCap}[ext=mp4]+bestaudio[ext=m4a]`;
    const anyAny = `best${heightCap}/best`;

    let order: string[];
    switch (codec) {
      case "av01":
        order = [av1, vp9, avc1, anyMp4, anyAny];
        break;
      case "vp9":
        order = [vp9, av1, avc1, anyMp4, anyAny];
        break;
      case "avc1":
        order = [avc1, anyMp4, vp9, av1, anyAny];
        break;
      default: // "any" — let yt-dlp pick the best by size/bitrate
        order = [
          `bestvideo${heightCap}+bestaudio[ext=m4a]/bestvideo${heightCap}+bestaudio`,
          anyMp4,
          anyAny,
        ];
    }
    return order.join("/");
  }

  // ---- Helper: Download video ----

  private async downloadVideo(
    videoId: string,
    outputPath: string,
    onProgress: (pct: number) => void,
  ): Promise<void> {
    const url = `https://www.youtube.com/watch?v=${videoId}`;

    // If the user's preferred codec hits HTTP 5xx mid-download (a known
    // YouTube CDN issue on specific AV1 transcodes), automatically retry
    // with the next codec down. Audio works in those failures, only the
    // video fragment URLs are bad — so a different codec usually succeeds.
    const chain = this.codecFallbackChain();
    let lastErr: Error | null = null;
    for (let i = 0; i < chain.length; i++) {
      const codec = chain[i];
      if (i > 0) {
        this.cleanPartialFiles(outputPath);
        console.log(
          `[pipeline] Retrying ${videoId} with codec="${codec}" after CDN 5xx`,
        );
      }
      try {
        await this.runYtdlp(videoId, outputPath, onProgress, codec);
        return;
      } catch (err) {
        lastErr = err as Error;
        const cdn5xx = (err as { cdn5xx?: boolean }).cdn5xx === true;
        if (!cdn5xx || i === chain.length - 1) throw err;
      }
    }
    if (lastErr) throw lastErr;
  }

  /** Single yt-dlp invocation with one specific codec preference. */
  private runYtdlp(
    videoId: string,
    outputPath: string,
    onProgress: (pct: number) => void,
    codec: string,
  ): Promise<void> {
    const url = `https://www.youtube.com/watch?v=${videoId}`;

    return new Promise((resolve, reject) => {
      const dl = youtubedl.exec(url, {
        output: outputPath,
        format: this.buildFormatString(codec),
        mergeOutputFormat: "mp4",
        cacheDir: "./youtube-dl-cache",
        limitRate: "3M",
        retries: 10,
        noWarnings: true,
        // See youtube-dl.ts — unlocks AV1/VP9 streams via Node JS runtime.
        jsRuntimes: "node",
      } as Parameters<typeof youtubedl>[1]);

      // youtube-dl-exec returns a Promise that auto-rejects on non-zero
      // exit. We already handle the exit via the "close" event below, so
      // swallow the promise rejection here to avoid an unhandled rejection
      // crashing the dev server when YouTube returns a 5xx mid-download.
      Promise.resolve(dl).catch(() => {});

      const parsePct = (text: string) => {
        const m = text.match(/(\d+\.\d+)%/);
        if (m) onProgress(Math.min(parseFloat(m[1]), 100));
      };

      let combinedOutput = "";

      dl.stdout?.on("data", (d: Buffer) => {
        const text = d.toString();
        combinedOutput += text;
        console.log(`yt-dlp stdout: ${text.trimEnd()}`);
        parsePct(text);
      });
      dl.stderr?.on("data", (d: Buffer) => {
        const text = d.toString();
        combinedOutput += text;
        console.error(`yt-dlp stderr: ${text.trimEnd()}`);
        parsePct(text);
      });

      dl.on("close", (code) => {
        console.log(`[pipeline] yt-dlp exited with code ${code} for ${videoId} (codec=${codec})`);
        if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
          onProgress(100);
          resolve();
        } else {
          // Detect the YouTube-CDN-mid-download failure mode so the outer
          // retry loop knows whether a different codec is worth trying.
          const cdn5xx = /HTTP Error 5\d\d/.test(combinedOutput)
            || /Giving up after \d+ retries/.test(combinedOutput);
          const err = new Error(`Download failed (exit ${code})`) as Error & { cdn5xx?: boolean };
          err.cdn5xx = cdn5xx;
          reject(err);
        }
      });

      dl.on("error", reject);
    });
  }

  /** Order of codecs to try when the user's choice fails with HTTP 5xx.
   *  Always starts with the user's pick, then steps down to broader
   *  alternatives. If the user explicitly chose H.264 or "any", there's
   *  no useful alternative — return just that one. */
  private codecFallbackChain(): string[] {
    const codec = this.config.videoCodec || "any";
    switch (codec) {
      case "av01": return ["av01", "vp9", "avc1"];
      case "vp9":  return ["vp9", "avc1"];
      case "avc1": return ["avc1"];
      default:     return ["any"];
    }
  }

  /** yt-dlp writes per-format intermediate files like `name.f398.mp4`,
   *  `name.f140.m4a`, and `*.part` next to the merged output. After a
   *  failed attempt, these stick around and yt-dlp's `--continue` logic
   *  will try to resume the broken AV1 URL on the next invocation. Wipe
   *  them so the codec swap actually takes effect. */
  private cleanPartialFiles(outputPath: string): void {
    const dir = path.dirname(outputPath);
    const base = path.basename(outputPath, path.extname(outputPath));
    if (!fs.existsSync(dir)) return;
    try {
      for (const file of fs.readdirSync(dir)) {
        if (file === path.basename(outputPath)) continue;
        if (file.startsWith(`${base}.f`) || file.startsWith(`${base}.`) && file.endsWith(".part")) {
          try {
            fs.unlinkSync(path.join(dir, file));
            console.log(`[pipeline] Cleaned partial: ${file}`);
          } catch {}
        }
      }
    } catch {}
  }

  /** Re-transcribe a previously processed video with a different model. */
  async retranscribeVideo(videoId: string, channelId: string, model?: string): Promise<PipelineJob> {
    const entry = getDb()
      .prepare("SELECT * FROM video_queue WHERE video_id = ? AND channel_id = ?")
      .get(videoId, channelId) as QueueEntry | undefined;

    if (!entry) throw new Error(`Video not found in queue: ${videoId}`);

    const channel = this.config.channels.find(c => c.id === channelId) || {
      id: channelId, name: channelId, url: "", enabled: true,
    };

    const job: PipelineJob = {
      id: `retrans-${videoId}-${Date.now()}`,
      channelId: channel.id,
      channelName: channel.name,
      videoId,
      videoTitle: entry.title,
      videoUrl: entry.url,
      status: "transcribing",
      progress: 0,
      startedAt: new Date().toISOString(),
      retries: 0,
    };

    this.jobs.unshift(job);
    this.activeJobs++;
    this.emit("jobStarted", job);

    try {
      const transModel = model || this.config.transcription.model;
      const safeName = datedBaseName(entry.title, entry.upload_date);
      const channelFolder = channelFolderName(channel.name);
      const transChannelDir = path.join(this.config.transcriptDir, channelFolder);
      if (!fs.existsSync(transChannelDir)) fs.mkdirSync(transChannelDir, { recursive: true });

      const mdFileName = `${safeName}.md`;
      const mdPath = path.join(transChannelDir, mdFileName);

      const videoPath = entry.video_path;
      const retainedM4aPath = videoPath ? replaceExtension(videoPath, ".m4a") : null;
      let audioPath: string | null = retainedM4aPath ? replaceExtension(retainedM4aPath, ".wav") : null;

      if (!audioPath || !fs.existsSync(audioPath)) {
        if (!videoPath || !fs.existsSync(videoPath)) {
          throw new Error("Video file no longer available for re-extraction");
        }
        job.status = "extracting_audio";
        this.emit("jobUpdated", job);

        const workChannelDir = path.join(this.config.workingDir, channelFolder);
        if (!fs.existsSync(workChannelDir)) fs.mkdirSync(workChannelDir, { recursive: true });

        const m4aRetPath = retainedM4aPath || path.join(workChannelDir, `${safeName}.m4a`);
        if (!fs.existsSync(m4aRetPath)) {
          await copyAudioTrack(videoPath, m4aRetPath);
        }
        audioPath = replaceExtension(m4aRetPath, ".wav");
        await extractAudio(m4aRetPath, audioPath, { sampleRate: 16000, channels: 1, format: "wav" });
      }

      // Transcribe
      job.status = "transcribing";
      this.emit("jobUpdated", job);

      const result = await transcribeAudio(audioPath, mdPath, {
        model: transModel,
        language: this.config.transcription.language,
        device: this.config.transcription.device,
        computeType: this.config.transcription.computeType,
        beamSize: this.config.transcription.beamSize,
        pythonPath: this.config.transcription.pythonVenv,
      });

      job.mdPath = mdPath;
      job.transcriptionResult = result;
      job.status = "complete";
      job.progress = 100;
      job.completedAt = new Date().toISOString();

      updateQueueStatus(videoId, channelId, { mdPath, wordCount: result.word_count, status: "complete" });
      if (audioPath) {
        try { fs.unlinkSync(audioPath); } catch {}
      }

      // Copy to QMD if needed
      if (this.config.qmdVaultDir) {
        const qmdChannelDir = path.join(this.config.qmdVaultDir, channelFolder);
        if (!fs.existsSync(qmdChannelDir)) fs.mkdirSync(qmdChannelDir, { recursive: true });
        fs.copyFileSync(mdPath, path.join(qmdChannelDir, mdFileName));
      }

      console.log(`[pipeline] 🔄 Re-transcribed with ${transModel}: ${entry.title}`);
      this.emit("jobUpdated", job);
      this.emit("jobComplete", job);

    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      job.completedAt = new Date().toISOString();
      console.error(`[pipeline] ❌ Re-transcribe failed: ${entry.title} — ${job.error}`);
      this.emit("jobUpdated", job);
      this.emit("jobError", job, error);
    } finally {
      this.activeJobs--;
    }

    return job;
  }

  /** Transcribe an already-downloaded video without re-downloading. */
  async processDownloadedFile(filePath: string, title: string, uploadDate?: string, videoId?: string, channelId?: string, channelName?: string): Promise<PipelineJob> {
    const existingEntry = videoId ? getQueueEntryByVideoId(videoId) : undefined;
    const monitoredChannel = channelId
      ? this.config.channels.find(c => c.id === channelId)
      : undefined;
    const namedChannel = channelName
      ? this.config.channels.find(c => c.name.toLowerCase() === channelName.toLowerCase())
      : undefined;
    const channel: ChannelConfig =
      monitoredChannel ||
      namedChannel ||
      (existingEntry ? { id: existingEntry.channel_id, name: channelName || existingEntry.channel_id, url: "", enabled: true } : undefined) ||
      { id: channelId || "manual", name: channelName || "Manual", url: "", enabled: true };
    const realVideoId = videoId || `file-${Date.now()}`;

    // Record in DB so pipeline won't re-download it
    if (videoId) {
      const dbChannelId = existingEntry?.channel_id || channel.id;
      // enqueueVideo returns false if already exists — we just need it in the DB
      enqueueVideo({
        videoId,
        channelId: dbChannelId,
        title,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        duration: null,
        isLive: false,
        isShorts: false,
        uploadDate: uploadDate || null,
      });
      // Override status to downloading so pipeline knows it's being processed
      updateQueueStatus(videoId, dbChannelId, { status: "downloading" });
    }

    const safeName = datedBaseName(title, uploadDate);

    const job: PipelineJob = {
      id: `transcribe-file-${Date.now()}`,
      channelId: channel.id,
      channelName: channel.name,
      videoId: realVideoId,
      videoTitle: title,
      videoUrl: "",
      status: "extracting_audio",
      progress: 0,
      startedAt: new Date().toISOString(),
      retries: 0,
    };

    this.jobs.unshift(job);
    this.activeJobs++;
    this.emit("jobStarted", job);

    try {
      const channelFolder = channelFolderName(channel.name);
      const workChannelDir = path.join(this.config.workingDir, channelFolder);
      const transChannelDir = path.join(this.config.transcriptDir, channelFolder);
      [workChannelDir, transChannelDir].forEach(d => {
        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
      });

      // Step 1: Fast extract audio — stream-copy an m4a temp, then convert to wav
      const m4aPath = replaceExtension(filePath, ".m4a");
      
      // Check if an m4a already exists (from a previous download)
      let sourceAudioPath = m4aPath;
      if (!fs.existsSync(m4aPath)) {
        // Stream-copy from the video (nearly instant, just demuxes)
        await copyAudioTrack(filePath, m4aPath);
      } else {
        console.log(`[pipeline] Using existing audio track: ${m4aPath}`);
      }

      // Convert m4a to 16kHz mono WAV for whisper
      job.status = "extracting_audio";
      this.emit("jobUpdated", job);

      const audioPath = replaceExtension(m4aPath, ".wav");
      // Extract from the m4a (audio-only, much faster than re-decoding the full video)
      await extractAudio(m4aPath, audioPath, { sampleRate: 16000, channels: 1, format: "wav" });

      job.audioPath = audioPath;
      job.progress = 40;
      this.emit("jobUpdated", job);

      // Step 2: Transcribe
      job.status = "transcribing";
      this.emit("jobUpdated", job);

      const mdFileName = `${safeName}.md`;
      const mdPath = path.join(transChannelDir, mdFileName);

      const result = await transcribeAudio(audioPath, mdPath, {
        model: this.config.transcription.model,
        language: this.config.transcription.language,
        device: this.config.transcription.device,
        computeType: this.config.transcription.computeType,
        beamSize: this.config.transcription.beamSize,
        pythonPath: this.config.transcription.pythonVenv,
      });

      job.mdPath = mdPath;
      job.transcriptionResult = result;
      job.progress = 90;
      this.emit("jobUpdated", job);

      // Copy to QMD
      if (this.config.qmdVaultDir) {
        const qmdChannelDir = path.join(this.config.qmdVaultDir, channelFolder);
        if (!fs.existsSync(qmdChannelDir)) fs.mkdirSync(qmdChannelDir, { recursive: true });
        fs.copyFileSync(mdPath, path.join(qmdChannelDir, mdFileName));
      }

      // Move video into the channel folder under videoSaveDir
      const videoSaveChannelDir = path.join(this.config.videoSaveDir, channelFolder);
      if (!fs.existsSync(videoSaveChannelDir)) fs.mkdirSync(videoSaveChannelDir, { recursive: true });
      const destVideoPath = path.join(videoSaveChannelDir, `${safeName}.mp4`);
      const destM4aPath = path.join(videoSaveChannelDir, `${safeName}.m4a`);
      if (filePath !== destVideoPath) {
        fs.copyFileSync(filePath, destVideoPath);
        try { fs.unlinkSync(filePath); } catch {}
        job.videoPath = destVideoPath;
        console.log(`[pipeline] Moved video to: ${destVideoPath}`);
      } else {
        job.videoPath = destVideoPath;
      }
      if (this.config.processing.keepAudio && m4aPath !== destM4aPath && fs.existsSync(m4aPath)) {
        fs.copyFileSync(m4aPath, destM4aPath);
        try { fs.unlinkSync(m4aPath); } catch {}
        job.audioPath = destM4aPath;
        console.log(`[pipeline] Moved audio to: ${destM4aPath}`);
      } else if (fs.existsSync(destM4aPath)) {
        job.audioPath = destM4aPath;
      } else if (fs.existsSync(m4aPath)) {
        try { fs.unlinkSync(m4aPath); } catch {}
      }

      try { fs.unlinkSync(audioPath); } catch {}

      job.status = "complete";
      job.progress = 100;
      job.completedAt = new Date().toISOString();

      console.log(`[pipeline] ✅ Transcribed downloaded file: ${title} (${result.word_count} words, ${result.realtime_factor}x realtime)`);
      this.emit("jobUpdated", job);
      this.emit("jobComplete", job);

      // Mark as complete in DB
      if (realVideoId && !realVideoId.startsWith("file-")) {
        const dbCh = existingEntry?.channel_id || channel.id;
        updateQueueStatus(realVideoId, dbCh, {
          status: "complete",
          videoPath: job.videoPath || filePath,
          mdPath: mdPath,
          wordCount: result.word_count,
          error: null,
        });
      }

    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      job.completedAt = new Date().toISOString();
      console.error(`[pipeline] ❌ File transcription failed: ${title} — ${job.error}`);
      this.emit("jobUpdated", job);
      this.emit("jobError", job, error);
    } finally {
      this.activeJobs--;
    }

    return job;
  }

  // ---- Manual single-video processing ----

  async processSingleVideo(url: string, quality?: string): Promise<PipelineJob> {
    // Override quality if specified
    if (quality) {
      this.config.videoQuality = quality;
    }

    // Fetch info first
    const info = await getYouTubeVideoInfo(url);

    const video: ChannelVideo = {
      id: info.id,
      title: info.title,
      url,
      duration: info.duration,
      isLive: false,
      isShorts: (info.duration ?? 0) <= 60,
      uploadDate: info.upload_date || null,
      thumbnail: info.thumbnail,
    };

    const channel: ChannelConfig = { id: "manual", name: "Manual", url: "", enabled: true };

    const inserted = enqueueVideo({
      videoId: video.id, channelId: channel.id, title: video.title, url: video.url,
      duration: video.duration, isLive: false, isShorts: video.isShorts, uploadDate: video.uploadDate,
    });

    const existing = getQueueEntryByVideoId(video.id);
    if (!inserted && existing?.status === "complete") {
      const job: PipelineJob = {
        id: `manual-skip-${video.id}-${Date.now()}`,
        channelId: existing.channel_id,
        channelName: existing.channel_id,
        videoId: video.id,
        videoTitle: video.title,
        videoUrl: url,
        status: "complete",
        progress: 100,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        videoPath: existing.video_path || undefined,
        mdPath: existing.md_path || undefined,
        retries: existing.retries,
      };
      this.jobs.unshift(job);
      this.emit("jobComplete", job);
      return job;
    }

    const entry = existing || getQueueEntryByVideoId(video.id) || {
      video_id: video.id,
      channel_id: channel.id,
      title: video.title,
      url: video.url,
      duration: video.duration,
      is_live: 0,
      is_shorts: video.isShorts ? 1 : 0,
      upload_date: video.uploadDate,
      status: "pending",
      video_path: null,
      md_path: null,
      word_count: 0,
      error: null,
      retries: 0,
      notes: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await this.processVideo(channel, video, entry);

    return this.jobs[0]; // Return the latest job
  }
}

function parseConfigNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseConfigBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return value === "true" || value === "1";
}

// ---- Singleton ----

let pipelineInstance: Pipeline | null = null;

export function getPipeline(configPath?: string): Pipeline {
  if (!pipelineInstance) {
    pipelineInstance = new Pipeline(configPath);
  }
  return pipelineInstance;
}
