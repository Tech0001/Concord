import path from "path";
import fs from "fs";
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

    const videos = await getAllChannelVideos(channel.url, (info) => {
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

      // Step 2: Download
      job.status = "downloading";
      updateQueueStatus(video.id, channel.id, { status: "downloading" });
      this.emit("jobUpdated", job);

      const safeName = datedBaseName(video.title, video.uploadDate);
      const channelFolder = channelFolderName(channel.name);

      // Channel-specific subdirectories
      const workChannelDir  = path.join(this.config.workingDir,    channelFolder);
      const saveChannelDir  = path.join(this.config.videoSaveDir, channelFolder);
      const transChannelDir = path.join(this.config.transcriptDir, channelFolder);

      [workChannelDir, saveChannelDir, transChannelDir].forEach(d => {
        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
      });

      const workVideoPath = path.join(workChannelDir, `${safeName}.mp4`);

      await this.downloadVideo(video.id, workVideoPath, (pct) => {
        job.progress = Math.floor(pct * 0.4);
        this.emit("jobUpdated", job);
      });

      job.videoPath = workVideoPath;
      job.progress = 40;
      this.emit("jobUpdated", job);

      // Step 3: Extract audio — stream-copy m4a first (instant), then convert to wav
      job.status = "extracting_audio";
      updateQueueStatus(video.id, channel.id, { status: "extracting_audio" });
      this.emit("jobUpdated", job);

      const m4aPath = path.join(workChannelDir, `${safeName}.m4a`);
      const audioPath = path.join(workChannelDir, `${safeName}.wav`);

      // Stream-copy the audio track (nearly instant — just demuxes)
      if (!fs.existsSync(m4aPath)) {
        await copyAudioTrack(workVideoPath, m4aPath);
      }
      
      // Convert m4a to 16kHz mono WAV for whisper (audio-only, no video decode overhead)
      await extractAudio(m4aPath, audioPath, { sampleRate: 16000, channels: 1, format: "wav" });

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

      // Step 6: Move video to save directory
      job.status = "saving_md";
      this.emit("jobUpdated", job);

      const savePath = path.join(saveChannelDir, `${safeName}.mp4`);
      const saveM4aPath = path.join(saveChannelDir, `${safeName}.m4a`);
      if (fs.existsSync(workVideoPath) && this.config.workingDir !== this.config.videoSaveDir) {
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
      if (this.config.processing.keepAudio && fs.existsSync(m4aPath) && m4aPath !== saveM4aPath) {
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

  /** Build yt-dlp format string from config. */
  private buildFormatString(): string {
    const q = this.config.videoQuality;
    if (q === "best") {
      return [
        "bestvideo[ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]",
        "best[ext=mp4][vcodec^=avc1]",
        "bestvideo[ext=mp4]+bestaudio[ext=m4a]",
        "best",
      ].join("/");
    }
    const height = parseInt(q) || 1080;
    return [
      `bestvideo[height<=${height}][ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]`,
      `best[height<=${height}][ext=mp4][vcodec^=avc1]`,
      `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]`,
      `best[height<=${height}]`,
      "best",
    ].join("/");
  }

  // ---- Helper: Download video ----

  private downloadVideo(
    videoId: string,
    outputPath: string,
    onProgress: (pct: number) => void,
  ): Promise<void> {
    const url = `https://www.youtube.com/watch?v=${videoId}`;

    return new Promise((resolve, reject) => {
      const dl = youtubedl.exec(url, {
        output: outputPath,
        format: this.buildFormatString(),
        mergeOutputFormat: "mp4",
        cacheDir: "./youtube-dl-cache",
        limitRate: "3M",
        retries: 10,
        noWarnings: true,
      });

      const parsePct = (text: string) => {
        const m = text.match(/(\d+\.\d+)%/);
        if (m) onProgress(Math.min(parseFloat(m[1]), 100));
      };

      dl.stdout?.on("data", (d: Buffer) => {
        const text = d.toString();
        console.log(`yt-dlp stdout: ${text.trimEnd()}`);
        parsePct(text);
      });
      dl.stderr?.on("data", (d: Buffer) => {
        const text = d.toString();
        console.error(`yt-dlp stderr: ${text.trimEnd()}`);
        parsePct(text);
      });

      dl.on("close", (code) => {
        console.log(`[pipeline] yt-dlp exited with code ${code} for ${videoId}`);
        if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
          onProgress(100);
          resolve();
        } else {
          reject(new Error(`Download failed (exit ${code})`));
        }
      });

      dl.on("error", reject);
    });
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
