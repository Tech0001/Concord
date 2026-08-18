import path from "path";
import fs from "fs";
import { EventEmitter } from "events";
import youtubedl from "./yt-dlp-bin";
import {
  getChannelVideosPage,
  getAllChannelVideos,
  isVideoCurrentlyLive,
  ChannelConfig,
  ChannelVideo,
} from "./channel-monitor";
import { getYouTubeVideoInfo } from "./youtube-dl";
import { extractAudio, copyAudioTrack, encodeAacSidecar } from "./audio";
import { transcribeAudio, TranscriptionResult } from "./transcribe";
import { embedSegmentsForVideo } from "./embed-segments";
import { summarizeVideo } from "./summarize-video";
import {
  enqueueVideo,
  enqueueVideos,
  countChannelQueueEntries,
  findChannelByYouTubeInfo,
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
  getTodayDownloadCount,
  incrementTodayDownloadCount,
  QueueEntry,
} from "./db";
import { channelFolderName, datedBaseName, replaceExtension } from "./naming";
import {
  DailyCapReachedError,
  type PipelineConfig,
  type PipelineJob,
  type PipelineState,
  type PipelineStatus,
  type SpeedPreset,
} from "./pipeline-types";
import {
  buildLocalFileMatcher,
  fileUrlToPath,
  isAudioOnlyPath,
  isLiveFlagStale,
  isLocalChannel,
  isLocalVideoUrl,
  isNonRetryableTranscriptionError,
  parseConfigBoolean,
  parseConfigNumber,
  parseSpeedPreset,
  scanLocalFolder,
  speedPresetToSleepInterval,
  type LocalFileMatcher,
} from "./pipeline-utils";

export { DailyCapReachedError, isLocalChannel, speedPresetToSleepInterval };
export type { PipelineConfig, PipelineJob, PipelineState, PipelineStatus };

/** Map a model name to its engine family. Used by loadConfig to detect
 *  stale (engine, model) pairings — e.g. wizard installed Parakeet but
 *  the saved model is `large-v3` — and migrate to a compatible default. */
function inferModelEngine(model: string): "parakeet" | "whisper" | "fluid" | null {
  if (!model) return null;
  const m = model.toLowerCase();
  if (m.startsWith("fluid-")) return "fluid";
  if (m.includes("parakeet")) return "parakeet";
  // The whisper family — large-v3, large-v3-turbo, medium, small, tiny.
  if (m === "large-v3" || m === "large-v3-turbo" || m === "medium" || m === "small" || m === "tiny") return "whisper";
  return null;
}

/** YouTube player clients to fall back to when the default ones hand
 *  back media URLs that 403 (YouTube's PO-token experiment). Verified
 *  against a gated video: both still serve plain, downloadable URLs,
 *  though only the legacy progressive format. */
const POT_FALLBACK_CLIENTS = "tv_simply,mweb";

// ---- Pipeline ----

export class Pipeline extends EventEmitter {
  private config: PipelineConfig;
  private jobs: PipelineJob[] = [];
  private timer: NodeJS.Timeout | null = null;
  private watcherTimer: NodeJS.Timeout | null = null;
  private status: PipelineStatus = "idle";
  private lastCheck: string | null = null;
  private nextCheck: string | null = null;
  private activeJobs = 0;
  private maxConcurrent = 1;

  // Retranscribe sequencing — see retranscribeVideo. Without these:
  //   * Two clicks for the same video would race: both extract audio to
  //     the same path with ffmpeg -y, one clobbering the other mid-read.
  //   * Multiple different videos all start audio extraction in parallel,
  //     then queue up at the Python lock in whatever order ffmpeg
  //     finished — not click order. Looks like "weird order".
  // The queue chains all retranscribes through one promise; the inflight
  // map coalesces rapid duplicate clicks for the same (videoId, channelId).
  private retranscribeQueue: Promise<unknown> = Promise.resolve();
  private inflightRetranscribe = new Map<string, Promise<PipelineJob>>();

  constructor(_configPath: string = "./pipeline.config.json") {
    super();
    this.config = this.loadConfig();
    this.persistConfig(this.config);
    this.recoverStuckJobs();
    this.resumeWaitingLive();
  }

  /** Reset any rows left in an in-flight status (downloading, transcribing,
   *  etc.) back to "pending" so they get re-picked-up on the next scan.
   *  Runs once on pipeline boot. Safe because the pipeline is the only
   *  process that drives those statuses — if we just booted, nothing else
   *  is in the middle of anything. Without this, rows stay stuck forever
   *  any time the server crashes or the user closes the app mid-job. */
  /** Fire-and-forget embedding generation after a transcript completes.
   *  Best-effort: skips silently if no embedding model is configured, and
   *  logs (without throwing) when the LLM is unreachable. The transcribe
   *  pipeline never waits on or fails because of embedding errors. */
  private maybeEmbedSegments(videoId: string, channelId: string): void {
    const model = this.config.llm.embeddingModel;
    if (!model) return;
    embedSegmentsForVideo(videoId, channelId, model)
      .then((r) => {
        if (r.skipped) console.log(`[embed] ${videoId}: ${r.skipped}`);
        else console.log(`[embed] ${videoId}: indexed ${r.segmentCount} segments (${model})`);
      })
      .catch((err) => console.error(`[embed] ${videoId} failed:`, err));
  }

  /** Fire-and-forget AI summary into the video's notes field. Same
   *  best-effort envelope as embedding — the transcribe pipeline never
   *  waits on or fails because of summarization. Skips when notes are
   *  already populated (user-authored content takes priority). */
  private maybeSummarizeVideo(videoId: string, channelId: string): void {
    const model = this.config.llm.chatModel;
    if (!model) return;
    summarizeVideo(videoId, channelId, model)
      .then((r) => {
        if (r.skipped) console.log(`[summarize] ${videoId}: ${r.skipped}`);
        else console.log(`[summarize] ${videoId}: ${r.charsIn} → ${r.charsOut} chars (${model})`);
      })
      .catch((err) => console.error(`[summarize] ${videoId} failed:`, err));
  }

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

  /** Re-establish 5-minute live-recheck timers for any rows left in
   *  `waiting_live` from a previous session. The original timers were
   *  in-memory setTimeouts and lost on every restart, leaving rows
   *  orphaned forever. Staggered with jitter across a 30-minute window
   *  so a hundred resumed rows don't all fire yt-dlp calls at the same
   *  moment on boot. Skips channels that are disabled — re-checking
   *  there would consume YouTube quota for nothing. */
  private resumeWaitingLive(): void {
    interface Row {
      video_id: string; channel_id: string; title: string; url: string;
      upload_date: string | null; is_live: number;
      c_id: string; c_name: string; c_url: string;
      c_enabled: number; c_diarize: number; c_category: string;
    }
    const rows = getDb().prepare(`
      SELECT q.video_id, q.channel_id, q.title, q.url, q.upload_date, q.is_live,
             c.id AS c_id, c.name AS c_name, c.url AS c_url,
             c.enabled AS c_enabled, c.diarize AS c_diarize, c.category AS c_category
      FROM video_queue q
      JOIN channels c ON c.id = q.channel_id
      WHERE q.status = 'waiting_live' AND c.enabled = 1
    `).all() as Row[];

    if (rows.length === 0) return;

    const windowMs = 30 * 60 * 1000;
    console.log(
      `[pipeline] Resuming ${rows.length} live-stream recheck${rows.length === 1 ? "" : "s"} from previous run (staggered over 30min)`,
    );

    for (const row of rows) {
      const video: ChannelVideo = {
        id: row.video_id,
        title: row.title,
        url: row.url,
        duration: null,
        isLive: !!row.is_live,
        isShorts: false,
        uploadDate: row.upload_date,
        thumbnail: null,
      };
      const channel: ChannelConfig = {
        id: row.c_id,
        name: row.c_name,
        url: row.c_url,
        enabled: !!row.c_enabled,
        diarize: !!row.c_diarize,
        category: row.c_category === "work" ? "work" : "personal",
      };
      const jitterMs = Math.random() * windowMs;
      setTimeout(() => this.recheckLive(video, channel), jitterMs);
    }
  }

  // ---- Config ----

  private loadConfig(): PipelineConfig {
    const defaults: PipelineConfig = {
      channels: [],
      workingDir: "./downloads",
      // Intentionally blank — old defaults pointed at a Linux-specific path
      // (/media/pc/Maac/...) that doesn't exist on a fresh Mac install and
      // would silently misroute downloads on a new machine. Force the user
      // to pick a folder in Settings (the Pipeline page surfaces a banner
      // when these are unset).
      videoSaveDir: "",
      transcriptDir: "",
      qmdVaultDir: null,
      checkIntervalMinutes: 1440,
      skipShorts: true,
      videoQuality: "1080",
      videoCodec: "any",
      audioLanguage: "en",
      youtubeCookiesFromBrowser: "",
      youtubeCookiesFile: "",
      youtubeSpeedPreset: "conservative",
      dailyDownloadCap: 200,
      lanAccess: false,
      transcription: {
        // Platform-aware default. Mac uses FluidAudio (ships with the app);
        // Linux uses NeMo Parakeet via Python. Whisper isn't a great default
        // anywhere — it's slower than Parakeet on CUDA and not installed
        // by default on Mac. The wizard / Settings can still switch.
        model: process.platform === "darwin"
          ? "fluid-parakeet-tdt-v3"
          : "nvidia/parakeet-tdt-0.6b-v3",
        language: "en",
        device: "cuda",
        computeType: "float16",
        beamSize: 5,
        pythonVenv: "./venv/bin/python",
        engine: "",
        venvPath: "",
      },
      llm: {
        baseUrl: "http://localhost:8000/v1",
        apiKey: "",
        chatModel: "",
        embeddingModel: "",
      },
      processing: {
        keepVideo: true,
        keepAudio: false,
        waitForLiveToFinish: true,
        diarizationEnabled: true,
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
      audioLanguage: stored.audioLanguage ?? defaults.audioLanguage,
      youtubeCookiesFromBrowser: stored.youtubeCookiesFromBrowser || defaults.youtubeCookiesFromBrowser,
      youtubeCookiesFile: stored.youtubeCookiesFile || defaults.youtubeCookiesFile,
      youtubeSpeedPreset: parseSpeedPreset(stored.youtubeSpeedPreset, defaults.youtubeSpeedPreset),
      dailyDownloadCap: parseConfigNumber(stored.dailyDownloadCap, defaults.dailyDownloadCap),
      lanAccess: parseConfigBoolean(stored.lanAccess, defaults.lanAccess),
      transcription: (() => {
        const engine = (stored["transcription.engine"] as "parakeet" | "whisper" | "") || (defaults.transcription.engine ?? "");
        let model = stored["transcription.model"] || defaults.transcription.model;
        // Heal stale config: if the wizard installed Parakeet but the
        // saved model is a Whisper variant (or vice versa), the spawn
        // would fail with "venv not found" — auto-migrate to a sensible
        // default for the installed engine so retranscribe just works.
        const modelEngine = inferModelEngine(model);
        if (engine && modelEngine && engine !== modelEngine) {
          model = engine === "parakeet"
            ? (process.platform === "darwin" ? "fluid-parakeet-tdt-v3" : "nvidia/parakeet-tdt-0.6b-v3")
            : "large-v3";
        }
        return {
          model,
          language: stored["transcription.language"] || defaults.transcription.language,
          device: stored["transcription.device"] || defaults.transcription.device,
          computeType: stored["transcription.computeType"] || defaults.transcription.computeType,
          beamSize: parseConfigNumber(stored["transcription.beamSize"], defaults.transcription.beamSize),
          pythonVenv: stored["transcription.pythonVenv"] || defaults.transcription.pythonVenv,
          // Wizard-managed fields. engine = "" until the wizard runs (or
          // explicitly set via Settings); venvPath = "" → fall back to the
          // legacy cwd-relative resolution in transcribe.ts.
          engine,
          venvPath: stored["transcription.venvPath"] || (defaults.transcription.venvPath ?? ""),
        };
      })(),
      llm: {
        baseUrl: stored["llm.baseUrl"] || defaults.llm.baseUrl,
        apiKey: stored["llm.apiKey"] ?? defaults.llm.apiKey,
        chatModel: stored["llm.chatModel"] ?? defaults.llm.chatModel,
        embeddingModel: stored["llm.embeddingModel"] ?? defaults.llm.embeddingModel,
      },
      processing: {
        keepVideo: parseConfigBoolean(stored["processing.keepVideo"], defaults.processing.keepVideo),
        keepAudio: parseConfigBoolean(stored["processing.keepAudio"], defaults.processing.keepAudio),
        waitForLiveToFinish: parseConfigBoolean(stored["processing.waitForLiveToFinish"], defaults.processing.waitForLiveToFinish),
        diarizationEnabled: parseConfigBoolean(stored["processing.diarizationEnabled"], defaults.processing.diarizationEnabled),
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
      dailyDownloadCount: getTodayDownloadCount(),
      dailyDownloadCap: this.config.dailyDownloadCap,
    };
  }

  getConfig(): PipelineConfig { return { ...this.config }; }

  updateConfig(updates: Partial<PipelineConfig>): void {
    this.config = {
      ...this.config,
      ...updates,
      transcription: { ...this.config.transcription, ...(updates.transcription || {}) },
      llm: { ...this.config.llm, ...(updates.llm || {}) },
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
      audioLanguage: config.audioLanguage,
      youtubeCookiesFromBrowser: config.youtubeCookiesFromBrowser,
      youtubeCookiesFile: config.youtubeCookiesFile,
      youtubeSpeedPreset: config.youtubeSpeedPreset,
      dailyDownloadCap: config.dailyDownloadCap,
      lanAccess: config.lanAccess,
      "transcription.model": config.transcription.model,
      "transcription.language": config.transcription.language,
      "transcription.device": config.transcription.device,
      "transcription.computeType": config.transcription.computeType,
      "transcription.beamSize": config.transcription.beamSize,
      "transcription.pythonVenv": config.transcription.pythonVenv,
      "transcription.engine": config.transcription.engine,
      "transcription.venvPath": config.transcription.venvPath,
      "llm.baseUrl": config.llm.baseUrl,
      "llm.apiKey": config.llm.apiKey,
      "llm.chatModel": config.llm.chatModel,
      "llm.embeddingModel": config.llm.embeddingModel,
      "processing.keepVideo": config.processing.keepVideo,
      "processing.keepAudio": config.processing.keepAudio,
      "processing.waitForLiveToFinish": config.processing.waitForLiveToFinish,
      "processing.diarizationEnabled": config.processing.diarizationEnabled,
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

    // YouTube Discover watchers tick on the same channel-scan cadence —
    // each watcher has its own poll_interval_hours so this just gives
    // them a chance to fire. Background work, errors don't kill the
    // pipeline.
    void this.tickWatchers();
    this.watcherTimer = setInterval(() => this.tickWatchers(), intervalMs);

    this.emit("started");
  }

  stop(): void {
    this.status = "stopped";
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.watcherTimer) { clearInterval(this.watcherTimer); this.watcherTimer = null; }
    console.log("[pipeline] Stopped");
    this.emit("stopped");
  }

  private async tickWatchers(): Promise<void> {
    try {
      const { pollDueWatchers } = await import("./youtube-discover");
      await pollDueWatchers();
    } catch (err) {
      // Missing API key etc. is a configuration issue — log it once per
      // tick instead of crashing the loop.
      console.warn("[pipeline] Watcher tick failed:", err instanceof Error ? err.message : err);
    }
  }

  /** Build a matcher rooted at this channel's expected save folder, so
   *  the next batch of scanned videos can be checked against local files
   *  already on disk. Returns a noop matcher when the folder is missing
   *  (covers fresh installs / channels with no downloads yet). */
  private buildLocalMatcherForChannel(channel: ChannelConfig): LocalFileMatcher {
    if (isLocalChannel(channel)) {
      // Local channels already track files by path — the matcher would
      // double up. Return a noop and let scanLocalFolder do its thing.
      return { match: () => null };
    }
    const folder = path.join(this.config.videoSaveDir, channelFolderName(channel.name));
    return buildLocalFileMatcher(folder, datedBaseName);
  }

  /** Attach an existing on-disk video file to a freshly-enqueued row so
   *  the pipeline skips re-downloading. Probes for a sibling transcript
   *  at the canonical path; if found, marks the row complete (truly done).
   *  If not, leaves status="pending" so processVideo will pick it up,
   *  detect the preset videoPath, skip the download step, and transcribe
   *  + embed + summarize like any other queued video. */
  private linkExistingDownload(
    videoId: string,
    channel: ChannelConfig,
    video: ChannelVideo,
    videoPath: string,
  ): void {
    if (this.config.transcriptDir) {
      const safeName = datedBaseName(video.title, video.uploadDate);
      const channelFolder = channelFolderName(channel.name);
      const mdPath = path.join(this.config.transcriptDir, channelFolder, `${safeName}.md`);
      if (fs.existsSync(mdPath)) {
        updateQueueStatus(videoId, channel.id, {
          videoPath,
          mdPath,
          status: "complete",
          error: null,
        });
        console.log(`[pipeline] Linked existing file + transcript: ${videoPath}`);
        return;
      }
    }
    // Video on disk but no transcript yet — let the pipeline process it.
    updateQueueStatus(videoId, channel.id, {
      videoPath,
      status: "pending",
      error: null,
    });
    console.log(`[pipeline] Linked existing file (will transcribe): ${videoPath}`);
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
            thumbnailUrl: v.thumbnail,
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
        const filtered = allVideos.filter(v => !v.isShorts || !!channel.include_shorts);
        const toEnqueue = filtered.map(v => ({
          videoId: v.id, channelId: channel.id, title: v.title, url: v.url,
          duration: v.duration, isLive: v.isLive, isShorts: v.isShorts, uploadDate: v.uploadDate,
          thumbnailUrl: v.thumbnail,
        }));
        const added = enqueueVideos(toEnqueue);

        // After enqueue, link any rows whose file is already on disk
        // (previously downloaded by Concord OR a yt-dlp default-template
        // download). Skips the download phase for those entries.
        const matcher = this.buildLocalMatcherForChannel(channel);
        let linked = 0;
        for (const v of filtered) {
          const hit = matcher.match({ id: v.id, title: v.title, uploadDate: v.uploadDate });
          if (hit) { this.linkExistingDownload(v.id, channel, v, hit); linked++; }
        }
        console.log(`[pipeline] ${channel.name}: first scan queued ${added}/${toEnqueue.length} videos${linked ? ` (${linked} already on disk)` : ""}`);
        return added;
      }

      const batchSize = 25;
      let start = 1;
      let added = 0;
      let linked = 0;
      // Build the matcher once per scan — readdir cost shouldn't be paid
      // on every page.
      const matcher = this.buildLocalMatcherForChannel(channel);

      while (start <= 5000) {
        const videos = await getChannelVideosPage(channel.url, start, batchSize);
        if (!videos.length) break;

        let foundKnownVideo = false;
        for (const v of videos) {
          if (videoExists(v.id)) {
            foundKnownVideo = true;
            continue;
          }

          if (v.isShorts && !channel.include_shorts) continue;
          const inserted = enqueueVideo({
            videoId: v.id, channelId: channel.id, title: v.title, url: v.url,
            duration: v.duration, isLive: v.isLive, isShorts: v.isShorts, uploadDate: v.uploadDate,
            thumbnailUrl: v.thumbnail,
          });
          if (inserted) {
            added++;
            const hit = matcher.match({ id: v.id, title: v.title, uploadDate: v.uploadDate });
            if (hit) { this.linkExistingDownload(v.id, channel, v, hit); linked++; }
          }
        }

        if (foundKnownVideo) {
          console.log(`[pipeline] ${channel.name}: found known video, stopping monitor scan`);
          break;
        }

        if (videos.length < batchSize) break;
        start += videos.length;
      }

      console.log(`[pipeline] ${channel.name}: +${added} new videos${linked ? ` (${linked} already on disk)` : ""}`);
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

    const filtered = videos.filter(v => !v.isShorts || !!channel.include_shorts);
    const toEnqueue = filtered.map(v => ({
      videoId: v.id, channelId: channel.id, title: v.title, url: v.url,
      duration: v.duration, isLive: v.isLive, isShorts: v.isShorts, uploadDate: v.uploadDate,
      thumbnailUrl: v.thumbnail,
    }));

    const newVideos = enqueueVideos(toEnqueue);

    // After enqueue, link any rows whose file already exists in the
    // channel save folder. Same matcher used by scanRecent — covers
    // prior Concord downloads (exact basename) and stock yt-dlp
    // template downloads ([VideoId] in the filename).
    const matcher = this.buildLocalMatcherForChannel(channel);
    let linked = 0;
    for (const v of filtered) {
      const hit = matcher.match({ id: v.id, title: v.title, uploadDate: v.uploadDate });
      if (hit) { this.linkExistingDownload(v.id, channel, v, hit); linked++; }
    }

    const skipped = videos.length - toEnqueue.length;
    console.log(`[pipeline] Full scan done: ${videos.length} total, ${newVideos} new, ${skipped} skipped${linked ? `, ${linked} already on disk` : ""}`);

    return { scanned: videos.length, newVideos };
  }

  // ---- Queue processor: pick next video and run the pipeline ----

  /** Public nudge — tells the pipeline "there might be a new pending row,
   *  please look." Used by voice-notes finalize and any other code path
   *  that drops a row in via SQL without going through scanEnabledChannels.
   *  Fire-and-forget: returns immediately; processing happens on the
   *  microtask queue and re-arms itself via the activeJobs `finally`. */
  kickQueue(): void {
    void this.processNextInQueue();
  }

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
      // Step 1: Check if live (ignoring stale is_live flags on old uploads)
      if (
        video.isLive
        && this.config.processing.waitForLiveToFinish
        && !isLiveFlagStale(video.uploadDate)
      ) {
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

      // If a previous scan linked an on-disk file via linkExistingDownload,
      // the queue entry already carries the absolute videoPath. Re-use it
      // directly and skip download — same as the `isLocal` branch, just for
      // YouTube-sourced channels where the file landed on disk before
      // Concord knew about it.
      const linkedExistingPath = !isLocal
        && queueEntry.video_path
        && fs.existsSync(queueEntry.video_path)
        ? queueEntry.video_path
        : null;

      const workVideoPath = isLocal && localFilePath
        ? localFilePath
        : linkedExistingPath ?? path.join(workChannelDir, `${safeName}.mp4`);

      if (isLocal || linkedExistingPath) {
        if (!fs.existsSync(workVideoPath)) {
          throw new Error(`Local file no longer exists: ${workVideoPath}`);
        }
        job.videoPath = workVideoPath;
        job.progress = 40;
        this.emit("jobUpdated", job);
      } else {
        // Soft daily cap on YouTube downloads. Resets at local midnight
        // (date comparison, no scheduler). 0 disables the cap. Local-
        // folder channels don't count (only YouTube videos hit this).
        const cap = this.config.dailyDownloadCap;
        if (cap > 0) {
          const today = getTodayDownloadCount();
          if (today >= cap) {
            throw new DailyCapReachedError(
              `Daily download cap reached (${today}/${cap}). Resets at midnight.`,
            );
          }
        }

        await this.downloadVideo(video.id, workVideoPath, (pct) => {
          job.progress = Math.floor(pct * 0.4);
          this.emit("jobUpdated", job);
        });
        incrementTodayDownloadCount();

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

      // Some audio containers/codecs Firefox can't decode (Ogg-Speex,
      // Ogg-FLAC, etc.). Pre-encode an AAC sidecar for browser playback.
      // Cheap: ffmpeg encodes in < 1× realtime; happens once at ingestion.
      let playbackPath: string | null = null;
      const BROWSER_FRIENDLY_AUDIO_EXTS = new Set([".mp3", ".m4a", ".aac"]);

      if (audioOnlyLocal) {
        const srcExt = path.extname(workVideoPath).toLowerCase();
        if (!BROWSER_FRIENDLY_AUDIO_EXTS.has(srcExt)) {
          // Pre-transcode to .m4a (AAC) so the drawer can stream it
          // universally. Live next to the source file — for a local file
          // /media/.../2025-09-11.ogg the sidecar is /media/.../2025-09-11.playback.m4a.
          // Keeps related files together and makes the app's working dir
          // pure scratch space. Falls back to workChannelDir if the source
          // folder isn't writable (read-only mount, permission denied).
          const sourceStem = path.basename(workVideoPath, srcExt);
          const beside = path.join(path.dirname(workVideoPath), `${sourceStem}.playback.m4a`);
          const fallback = path.join(workChannelDir, `${safeName}.playback.m4a`);
          try {
            if (!fs.existsSync(beside)) await encodeAacSidecar(workVideoPath, beside);
            playbackPath = beside;
          } catch (err) {
            console.warn(`[audio] Could not write sidecar beside source (${err instanceof Error ? err.message : err}); using ${fallback}`);
            if (!fs.existsSync(fallback)) await encodeAacSidecar(workVideoPath, fallback);
            playbackPath = fallback;
          }
        }
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
      job.model = this.config.transcription.model;
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
        diarize: this.config.processing.diarizationEnabled !== false && channel.diarize !== false,
        videoId: video.id,
        channelId: channel.id,
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
      if (!isLocal && !linkedExistingPath && fs.existsSync(workVideoPath) && this.config.workingDir !== this.config.videoSaveDir) {
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

      // Persist the new paths BEFORE kicking off embed/summary. Both helpers
      // read `md_path` off the queue row to locate the transcript file
      // (getTranscriptSegmentsForVideo → entry.md_path), so calling them
      // before this updateQueueStatus would have them silently bail with
      // "no segments" on every first-time transcribe. Retranscribe didn't
      // hit this because the prior run's md_path was already persisted.
      updateQueueStatus(video.id, channel.id, {
        status: "complete",
        videoPath: job.videoPath || null,
        playbackPath,
        mdPath: job.mdPath || null,
        wordCount: result.word_count,
        // Clear any error from a prior failed attempt — without this a
        // video that failed once (e.g. a truncated download) keeps
        // showing the stale error text in the Library even after a
        // successful retry.
        error: null,
      });

      this.maybeEmbedSegments(video.id, channel.id);
      this.maybeSummarizeVideo(video.id, channel.id);

      console.log(`[pipeline] ✅ ${video.title} (${result.word_count} words, ${result.realtime_factor}x realtime)`);
      this.emit("jobUpdated", job);
      this.emit("jobComplete", job);

    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);

      // Daily cap is a *deferral*, not a failure — reset to pending and
      // don't bump retries (this isn't the video's fault, and we want it
      // to try first thing tomorrow when the date rolls over). Also stop
      // the pipeline loop entirely — pulling the next video would just
      // re-hit the cap immediately.
      if (error instanceof DailyCapReachedError) {
        console.log(`[pipeline] ⏸  ${video.title} — ${errMsg}`);
        updateQueueStatus(video.id, channel.id, { status: "pending" });
        job.status = "pending";
        job.error = errMsg;
        this.emit("jobUpdated", job);
        this.status = "sleeping";
        return;
      }

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
    const codec = codecOverride || this.config.videoCodec || "any";

    // No [height<=N] filter here on purpose — the quality cap rides on
    // --format-sort instead (see qualitySort()). Height is the wrong axis
    // for vertical videos: YouTube's "720p" rung on a portrait clip is
    // 720x1280, so a height filter rejects it and silently settles for the
    // 360-wide rung below it.

    // Audio selector — when audioLanguage is set, prefer that
    // language's track; fall back to any audio. Solves the
    // multi-language-channel case (YouTube creators who publish
    // dubbed tracks in several languages and yt-dlp picks one at
    // random without this filter).
    const lang = this.config.audioLanguage;
    const audioLangM4a = lang ? `bestaudio[language=${lang}][ext=m4a]` : "bestaudio[ext=m4a]";
    const audioLangAny = lang ? `bestaudio[language=${lang}]` : "bestaudio";

    // Per-codec selectors. AV1/VP9 ship in WebM, H.264 in MP4.
    const av1   = `bestvideo[vcodec^=av01]+${audioLangM4a}/bestvideo[vcodec^=av01]+${audioLangAny}/bestvideo[vcodec^=av01]+bestaudio`;
    const vp9   = `bestvideo[vcodec^=vp9]+${audioLangM4a}/bestvideo[vcodec^=vp9]+${audioLangAny}/bestvideo[vcodec^=vp9]+bestaudio`;
    const avc1  = `bestvideo[ext=mp4][vcodec^=avc1]+${audioLangM4a}/bestvideo[ext=mp4][vcodec^=avc1]+${audioLangAny}/best[ext=mp4][vcodec^=avc1]`;
    const anyMp4 = `bestvideo[ext=mp4]+${audioLangM4a}/bestvideo[ext=mp4]+${audioLangAny}`;
    const anyAny = `best`;

    let order: string[];
    switch (codec) {
      case "av01":
        // AV1 → H.264 → VP9 (last resort). H.264 sits ahead of VP9 so
        // older YouTube uploads that lack AV1 still land in an
        // iPhone-playable codec; VP9 only takes over for videos that
        // YouTube literally only serves in VP9 (rare).
        order = [av1, avc1, vp9, anyMp4, anyAny];
        break;
      case "vp9":
        order = [vp9, av1, avc1, anyMp4, anyAny];
        break;
      case "avc1":
        order = [avc1, anyMp4, vp9, av1, anyAny];
        break;
      default: // "any" — let yt-dlp pick the best by size/bitrate
        order = [
          `bestvideo+${audioLangM4a}/bestvideo+${audioLangAny}/bestvideo+bestaudio`,
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
    let potBlocked = false;
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
        const flags = err as { cdn5xx?: boolean; potBlocked?: boolean };
        if (flags.potBlocked === true) { potBlocked = true; break; }
        if (flags.cdn5xx !== true || i === chain.length - 1) break;
      }
    }

    // YouTube is rolling out an experiment that binds a "PO token" to the
    // video for the default player clients. Without a token provider their
    // formats either carry no URL at all (SABR) or 403 partway through the
    // media fetch, so yt-dlp silently falls back to android_vr — whose URLs
    // 403 too. These clients still hand out plain, downloadable URLs. The
    // catch is they only expose the legacy progressive stream (format 18,
    // 360p H.264), so this is a deliberate quality-for-success trade and we
    // only take it after the normal path has already failed.
    if (potBlocked) {
      this.cleanPartialFiles(outputPath);
      console.log(
        `[pipeline] ${videoId}: HTTP 403 on media (YouTube wants a PO token) — `
        + `retrying with player_client=${POT_FALLBACK_CLIENTS}. Expect reduced quality.`,
      );
      await this.runYtdlp(videoId, outputPath, onProgress, chain[0], POT_FALLBACK_CLIENTS);
      return;
    }

    if (lastErr) throw lastErr;
  }

  /** Single yt-dlp invocation with one specific codec preference.
   *  `playerClient` overrides yt-dlp's default YouTube client list —
   *  only set by the PO-token fallback in downloadVideo(). */
  private runYtdlp(
    videoId: string,
    outputPath: string,
    onProgress: (pct: number) => void,
    codec: string,
    playerClient?: string,
  ): Promise<void> {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const cookiesBrowser = (this.config.youtubeCookiesFromBrowser || "").trim();
    const cookiesFile = (this.config.youtubeCookiesFile || "").trim();
    const sleep = speedPresetToSleepInterval(this.config.youtubeSpeedPreset);

    return new Promise((resolve, reject) => {
      const dl = youtubedl.exec(url, {
        output: outputPath,
        format: this.buildFormatString(codec),
        ...(this.qualitySort() ? { formatSort: this.qualitySort() } : {}),
        mergeOutputFormat: "mp4",
        cacheDir: "./youtube-dl-cache",
        limitRate: "3M",
        retries: 10,
        noWarnings: true,
        // See youtube-dl.ts — unlocks AV1/VP9 streams via Node JS runtime.
        jsRuntimes: "node",
        ...(playerClient ? { extractorArgs: `youtube:player_client=${playerClient}` } : {}),
        // Auth cookies: prefer a Netscape cookies.txt file when set
        // (skips Keychain prompts and works while the browser is open);
        // fall back to --cookies-from-browser otherwise. Either defeats
        // the "Sign in to confirm you're not a bot" gate.
        ...(cookiesFile
          ? { cookies: cookiesFile }
          : cookiesBrowser
            ? { cookiesFromBrowser: cookiesBrowser }
            : {}),
        // Politeness: random sleep between requests reduces rate-limit
        // and bot-detection hits. Maps the user's speed preset.
        sleepInterval: sleep.min,
        maxSleepInterval: sleep.max,
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
          // A 403 on the media fetch means the format's URL was rejected —
          // in practice YouTube demanding a PO token we can't mint. Worth
          // retrying with clients that still serve plain URLs. Skipped when
          // we already are one of those, so we don't loop.
          const potBlocked = !playerClient && /HTTP Error 403/.test(combinedOutput);
          const err = new Error(`Download failed (exit ${code})`) as Error & {
            cdn5xx?: boolean;
            potBlocked?: boolean;
          };
          err.cdn5xx = cdn5xx;
          err.potBlocked = potBlocked;
          reject(err);
        }
      });

      dl.on("error", reject);
    });
  }

  /** `--format-sort` expression that caps download quality at the user's
   *  videoQuality setting. Uses yt-dlp's `res` field, which is the
   *  *smallest* dimension of a stream, so it tracks YouTube's own quality
   *  label in both orientations: a 1280x720 landscape rung and a 720x1280
   *  vertical rung both read as res=720. Verified not to overshoot — on a
   *  video offering 1080p, `res:720` still selects the 720p rung.
   *  Undefined when the user asked for "best" (no cap). */
  private qualitySort(): string | undefined {
    const q = this.config.videoQuality;
    if (!q || q === "best") return undefined;
    return `res:${parseInt(q) || 1080}`;
  }

  /** Order of codecs to try when the user's choice fails with HTTP 5xx.
   *  Always starts with the user's pick, then steps down to broader
   *  alternatives. If the user explicitly chose H.264 or "any", there's
   *  no useful alternative — return just that one. */
  private codecFallbackChain(): string[] {
    const codec = this.config.videoCodec || "any";
    switch (codec) {
      case "av01": return ["av01", "avc1", "vp9"];
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
  /** Public retranscribe entrypoint. Returns IMMEDIATELY with a stub
   *  job (status = "queued"); the actual work runs in the background
   *  through a single FIFO queue. The HTTP layer doesn't have to hold a
   *  request open for the whole transcription — the client watches
   *  progress via /api/pipeline/state polling like any other job.
   *
   *  Coalesces duplicate clicks for the same (videoId, channelId): a
   *  second click while the first is still queued/running returns the
   *  existing job stub instead of enqueueing a duplicate. */
  async retranscribeVideo(videoId: string, channelId: string, model?: string): Promise<PipelineJob> {
    const key = `${channelId}:${videoId}`;
    const existing = this.inflightRetranscribe.get(key);
    if (existing) return existing;

    // Look up the entry so the stub job carries real metadata for the UI.
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
      status: "queued",
      progress: 0,
      startedAt: new Date().toISOString(),
      retries: 0,
    };
    this.jobs.unshift(job);
    this.emit("jobStarted", job);

    // Reflect the queued state in the DB so the Library button can show
    // a spinner immediately (without waiting for the work to start).
    // Stash the prior status so we can revert if the retranscribe fails
    // and the original transcript is still on disk.
    updateQueueStatus(videoId, channelId, { status: "queued" });

    // Take the next queue slot and chain our work behind whatever's there.
    const previous = this.retranscribeQueue;
    let releaseSlot: () => void = () => {};
    this.retranscribeQueue = new Promise<void>((resolve) => { releaseSlot = resolve; });

    // Fire-and-forget: stash the Promise in the inflight map so a
    // duplicate click can dedup, but don't await it — the response to
    // the HTTP caller is the stub job above, returned right away.
    const work = (async () => {
      try { await previous; } catch { /* swallow — we want the slot, not the result */ }
      try {
        await this.runRetranscribeJob(job, entry, channel, model);
      } catch (err) {
        console.error(`[retranscribe] background failure for ${videoId}:`, err);
      } finally {
        this.inflightRetranscribe.delete(key);
        releaseSlot();
      }
    })();

    // Store the JOB (not the Promise) so dedup returns the stub instantly.
    this.inflightRetranscribe.set(key, Promise.resolve(job));
    // Track work too so a future shutdown handler could await pending jobs.
    void work;

    return job;
  }

  /** Retry a failed (or stuck) video FROM SCRATCH: delete any partial /
   *  corrupt download, reset the queue row to a clean state, and run the
   *  full pipeline again (download → transcribe → embed → summarize).
   *
   *  This is the fix for download failures like a truncated container
   *  ("moov atom not found"). Re-transcribe and the auto-retry loop both
   *  REUSE the existing on-disk file (processVideo skips download when
   *  video_path exists), so they re-hit the same corrupt bytes forever.
   *  Deleting the file first forces a fresh download.
   *
   *  Shares the retranscribe FIFO queue + inflight-dedup map so manual
   *  reprocessing never runs concurrently and overwhelms the machine.
   *  Returns a stub job immediately; progress is watched via the same
   *  /api/pipeline/state polling as every other job. */
  async retryVideo(videoId: string, channelId: string): Promise<PipelineJob> {
    const key = `${channelId}:${videoId}`;
    const existing = this.inflightRetranscribe.get(key);
    if (existing) return existing;

    const entry = getDb()
      .prepare("SELECT * FROM video_queue WHERE video_id = ? AND channel_id = ?")
      .get(videoId, channelId) as QueueEntry | undefined;
    if (!entry) throw new Error(`Video not found in queue: ${videoId}`);

    const channel = this.config.channels.find(c => c.id === channelId) || {
      id: channelId, name: channelId, url: "", enabled: true,
    };

    // Local-folder channels own their source file (we never downloaded
    // it and must not delete it) — only the derived audio is ours to
    // clean. YouTube-sourced channels: wipe the (possibly corrupt) mp4
    // plus its sibling .m4a / .wav so processVideo re-downloads fresh.
    const isLocal = isLocalVideoUrl(entry.url);
    const toRemove = new Set<string>();
    if (entry.video_path) {
      if (!isLocal) toRemove.add(entry.video_path);
      toRemove.add(replaceExtension(entry.video_path, ".m4a"));
      toRemove.add(replaceExtension(entry.video_path, ".wav"));
    }
    if (!isLocal && entry.playback_path) toRemove.add(entry.playback_path);

    // CRUCIAL: a video that failed *during* download/extraction never
    // got its video_path persisted (that only happens on "complete"),
    // so the sibling-deletion above misses the orphaned working-dir
    // artifacts. processVideo reuses an existing working-dir .m4a
    // (line ~874: `if (!fs.existsSync(m4aPath))`), so a stale corrupt
    // .m4a would be reused and reproduce the exact same failure
    // ("moov atom not found"). Reconstruct the working-dir paths the
    // same way processVideo does and wipe them too. Local channels
    // skip the .mp4 (it's the user's source) but still clear derived
    // audio.
    if (!isLocal) {
      const safeName = datedBaseName(entry.title, entry.upload_date);
      const channelFolder = channelFolderName(channel.name);
      const workDir = path.join(this.config.workingDir, channelFolder);
      for (const ext of [".mp4", ".m4a", ".wav", ".playback.m4a"]) {
        toRemove.add(path.join(workDir, `${safeName}${ext}`));
      }
    }

    toRemove.forEach((f) => {
      try { fs.unlinkSync(f); } catch { /* already gone — fine */ }
    });

    // Reset the row: queued state, error cleared, retry counter zeroed,
    // and (for non-local) the file pointers dropped so the download-skip
    // shortcut in processVideo doesn't fire on the stale path.
    updateQueueStatus(videoId, channelId, {
      status: "queued",
      error: null,
      retries: 0,
      mdPath: null,
      wordCount: 0,
      ...(isLocal ? {} : { videoPath: null, playbackPath: null }),
    });

    const video: ChannelVideo = {
      id: entry.video_id,
      title: entry.title,
      url: entry.url,
      duration: entry.duration,
      isLive: !!entry.is_live,
      isShorts: !!entry.is_shorts,
      uploadDate: entry.upload_date,
      thumbnail: null,
    };

    const job: PipelineJob = {
      id: `retry-${videoId}-${Date.now()}`,
      channelId: channel.id,
      channelName: channel.name,
      videoId,
      videoTitle: entry.title,
      videoUrl: entry.url,
      status: "queued",
      progress: 0,
      startedAt: new Date().toISOString(),
      retries: 0,
    };
    this.jobs.unshift(job);
    this.emit("jobStarted", job);

    const previous = this.retranscribeQueue;
    let releaseSlot: () => void = () => {};
    this.retranscribeQueue = new Promise<void>((resolve) => { releaseSlot = resolve; });

    const work = (async () => {
      try { await previous; } catch { /* swallow — we want the slot */ }
      try {
        // Re-read the row so processVideo sees the freshly-reset state
        // (null file paths in particular) rather than the stale entry.
        const fresh = getDb()
          .prepare("SELECT * FROM video_queue WHERE video_id = ? AND channel_id = ?")
          .get(videoId, channelId) as QueueEntry | undefined;
        await this.processVideo(channel, video, fresh ?? entry);
      } catch (err) {
        console.error(`[retry] background failure for ${videoId}:`, err);
      } finally {
        this.inflightRetranscribe.delete(key);
        releaseSlot();
      }
    })();

    this.inflightRetranscribe.set(key, Promise.resolve(job));
    void work;

    return job;
  }

  /** Worker invoked from retranscribeVideo's queue. Receives the
   *  pre-built stub job + entry + channel (all looked up by the
   *  enqueueing call) so we don't double-fetch. Mutates the job in
   *  place — its identity is what the UI is already polling. */
  private async runRetranscribeJob(
    job: PipelineJob,
    entry: QueueEntry,
    channel: ChannelConfig,
    model?: string,
  ): Promise<PipelineJob> {
    const videoId = entry.video_id;
    const channelId = entry.channel_id;
    // Remember the previous DB status so we can revert on failure: a
    // failed retranscribe shouldn't mark a previously-good entry as
    // "failed" — its existing transcript is still on disk.
    const previousStatus = entry.status || "complete";
    job.status = "transcribing";
    this.activeJobs++;
    this.emit("jobUpdated", job);
    updateQueueStatus(videoId, channelId, { status: "transcribing" });

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

      // Retranscribe ALWAYS forces a fresh extract from the source —
      // otherwise a redownload (e.g. picking a different audio track
      // for a multi-language video) silently keeps using the cached
      // .wav from the prior run and reproduces the same transcript.
      // Cheap: ffmpeg copy/extract is seconds for typical videos.
      if (audioPath && fs.existsSync(audioPath)) {
        try { fs.unlinkSync(audioPath); } catch { /* ignore */ }
      }
      if (retainedM4aPath && fs.existsSync(retainedM4aPath)) {
        try { fs.unlinkSync(retainedM4aPath); } catch { /* ignore */ }
      }

      if (!audioPath || !fs.existsSync(audioPath)) {
        if (!videoPath || !fs.existsSync(videoPath)) {
          throw new Error("Video file no longer available for re-extraction");
        }
        job.status = "extracting_audio";
        this.emit("jobUpdated", job);

        const workChannelDir = path.join(this.config.workingDir, channelFolder);
        if (!fs.existsSync(workChannelDir)) fs.mkdirSync(workChannelDir, { recursive: true });

        // If the source is already audio (mp3 / ogg / flac / etc.), the
        // m4a stream-copy step doesn't apply — m4a containers only carry
        // AAC, so demuxing Vorbis/Opus/FLAC into m4a fails. Skip straight
        // to whisper-ready WAV from the source.
        if (isAudioOnlyPath(videoPath)) {
          audioPath = path.join(workChannelDir, `${safeName}.wav`);
          await extractAudio(videoPath, audioPath, { sampleRate: 16000, channels: 1, format: "wav" });
        } else {
          const m4aRetPath = retainedM4aPath || path.join(workChannelDir, `${safeName}.m4a`);
          if (!fs.existsSync(m4aRetPath)) {
            await copyAudioTrack(videoPath, m4aRetPath);
          }
          audioPath = replaceExtension(m4aRetPath, ".wav");
          await extractAudio(m4aRetPath, audioPath, { sampleRate: 16000, channels: 1, format: "wav" });
        }
      }

      // Transcribe
      job.status = "transcribing";
      job.model = transModel;
      this.emit("jobUpdated", job);

      const result = await transcribeAudio(audioPath, mdPath, {
        model: transModel,
        language: this.config.transcription.language,
        device: this.config.transcription.device,
        computeType: this.config.transcription.computeType,
        beamSize: this.config.transcription.beamSize,
        pythonPath: this.config.transcription.pythonVenv,
        diarize: this.config.processing.diarizationEnabled !== false && channel.diarize !== false,
        videoId,
        channelId,
      });

      job.mdPath = mdPath;
      job.transcriptionResult = result;
      job.status = "complete";
      job.progress = 100;
      job.completedAt = new Date().toISOString();

      // Persist md_path before embed/summary — see auto-pipeline comment;
      // same ordering bug bit the third call site for fresh rows.
      updateQueueStatus(videoId, channelId, { mdPath, wordCount: result.word_count, status: "complete" });

      this.maybeEmbedSegments(videoId, channelId);
      this.maybeSummarizeVideo(videoId, channelId);
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
      // Restore the prior queue status (usually "complete") so the
      // existing-on-disk transcript stays accessible from the Library.
      // The job's own `error` carries the failure detail for the UI.
      updateQueueStatus(videoId, channelId, { status: previousStatus, error: job.error });
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
    // findChannelByYouTubeInfo runs the full match cascade (stored
    // UC id, UC-in-URL, @handle, normalized URL, name). When the
    // caller passed a UC id as channelId, this catches it; when
    // they passed only a display name, this catches the @handle /
    // normalized URL cases the simpler name-equality check missed.
    const matchedChannel = !monitoredChannel
      ? findChannelByYouTubeInfo(channelId, channelName, null)
      : undefined;
    const namedChannel = !matchedChannel && channelName
      ? this.config.channels.find(c => c.name.toLowerCase() === channelName.toLowerCase())
      : undefined;
    const channel: ChannelConfig =
      monitoredChannel ||
      (matchedChannel as ChannelConfig | undefined) ||
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

      job.status = "extracting_audio";
      this.emit("jobUpdated", job);

      const audioPath = replaceExtension(filePath, ".wav");
      // m4aPath: only meaningful for video sources (where we stream-copy a
      // demuxed AAC track to skip re-decoding the full video). Audio
      // sources go straight to WAV — m4a containers can only carry AAC, so
      // demuxing Vorbis/Opus/FLAC into m4a fails. Downstream cleanup code
      // checks for null before touching it.
      const m4aPath: string | null = isAudioOnlyPath(filePath)
        ? null
        : replaceExtension(filePath, ".m4a");

      if (m4aPath === null) {
        await extractAudio(filePath, audioPath, { sampleRate: 16000, channels: 1, format: "wav" });
      } else {
        if (!fs.existsSync(m4aPath)) {
          await copyAudioTrack(filePath, m4aPath);
        } else {
          console.log(`[pipeline] Using existing audio track: ${m4aPath}`);
        }
        await extractAudio(m4aPath, audioPath, { sampleRate: 16000, channels: 1, format: "wav" });
      }

      job.audioPath = audioPath;
      job.progress = 40;
      this.emit("jobUpdated", job);

      // Step 2: Transcribe
      job.status = "transcribing";
      job.model = this.config.transcription.model;
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
        diarize: this.config.processing.diarizationEnabled !== false && channel.diarize !== false,
        videoId: realVideoId,
        channelId: channel.id,
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
      if (m4aPath && this.config.processing.keepAudio && m4aPath !== destM4aPath && fs.existsSync(m4aPath)) {
        fs.copyFileSync(m4aPath, destM4aPath);
        try { fs.unlinkSync(m4aPath); } catch {}
        job.audioPath = destM4aPath;
        console.log(`[pipeline] Moved audio to: ${destM4aPath}`);
      } else if (fs.existsSync(destM4aPath)) {
        job.audioPath = destM4aPath;
      } else if (m4aPath && fs.existsSync(m4aPath)) {
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
        this.maybeEmbedSegments(realVideoId, dbCh);
        this.maybeSummarizeVideo(realVideoId, dbCh);
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
      thumbnailUrl: video.thumbnail,
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
      playback_path: null,
      md_path: null,
      word_count: 0,
      error: null,
      retries: 0,
      notes: null,
      ai_summary: null,
      ai_summary_model: null,
      starred: 0,
      thumbnail_url: video.thumbnail || null,
      last_position_seconds: 0,
      last_opened_at: null,
      review_state: "unreviewed",
      category: channel.category ?? "personal",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await this.processVideo(channel, video, entry);

    return this.jobs[0]; // Return the latest job
  }
}

// ---- Singleton ----

let pipelineInstance: Pipeline | null = null;

export function getPipeline(configPath?: string): Pipeline {
  if (!pipelineInstance) {
    pipelineInstance = new Pipeline(configPath);
  }
  return pipelineInstance;
}
