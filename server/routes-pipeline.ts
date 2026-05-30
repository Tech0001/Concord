import type { Express, Request, Response } from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { channelFolderName } from "./naming";
import { enqueueVideo, getDb, updateChannelCategory, updateQueueStatus } from "./db";
import type { Pipeline } from "./pipeline";

/**
 * Pipeline lifecycle + channel management endpoints — start / stop /
 * check / process / events SSE, the transcripts file list, channels
 * CRUD (configured + virtual), import-folder, retranscribe,
 * transcribe-file, and archive. Everything that drives the Pipeline
 * page in the UI and the background pipeline loop.
 */
export function registerPipelineRoutes(app: Express, pipeline: Pipeline): void {
  app.post("/api/pipeline/start", (_req, res) => {
    pipeline.start();
    res.json({ success: true, status: pipeline.getState().status });
  });

  app.post("/api/pipeline/stop", (_req, res) => {
    pipeline.stop();
    res.json({ success: true, status: pipeline.getState().status });
  });

  // Trigger an immediate channel check (without starting the loop).
  app.post("/api/pipeline/check-now", async (_req, res) => {
    try {
      const result = await pipeline.checkNow();
      res.json({ success: true, message: "Check complete. New videos were queued but downloads were not started.", ...result });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Check failed" });
    }
  });

  // Process a single video by URL — manual transcription path.
  // Returns immediately; the job runs in the background and progress
  // flows over the /api/pipeline/events SSE stream below.
  app.post("/api/pipeline/process", async (req, res) => {
    try {
      const { url, quality } = req.body;
      if (!url) return res.status(400).json({ error: "URL is required" });

      res.json({ accepted: true, message: "Processing started" });

      try {
        await pipeline.processSingleVideo(url, quality);
      } catch (error) {
        console.error("[pipeline] Manual process failed:", error);
      }
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to process video" });
    }
  });

  // SSE stream of pipeline events — the Pipeline page subscribes for
  // live job + state updates. Each event is also broadcast separately
  // (jobStarted / jobUpdated / etc.) so the UI can pick what to render.
  app.get("/api/pipeline/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const onStateChange = () => {
      res.write(`event: state\ndata: ${JSON.stringify(pipeline.getState())}\n\n`);
    };
    const onJobUpdate = (job: unknown) => {
      res.write(`event: job\ndata: ${JSON.stringify(job)}\n\n`);
    };

    pipeline.on("jobStarted", onJobUpdate);
    pipeline.on("jobUpdated", onJobUpdate);
    pipeline.on("jobComplete", onJobUpdate);
    pipeline.on("jobError", onJobUpdate);
    pipeline.on("checkComplete", onStateChange);
    pipeline.on("configChanged", onStateChange);

    // Initial snapshot so the page renders before the first real event.
    res.write(`event: state\ndata: ${JSON.stringify(pipeline.getState())}\n\n`);

    req.on("close", () => {
      pipeline.off("jobStarted", onJobUpdate);
      pipeline.off("jobUpdated", onJobUpdate);
      pipeline.off("jobComplete", onJobUpdate);
      pipeline.off("jobError", onJobUpdate);
      pipeline.off("checkComplete", onStateChange);
      pipeline.off("configChanged", onStateChange);
    });
  });

  // List transcript files in the transcriptDir. The Library and Search
  // pages use this for the file-browser-style transcript picker.
  app.get("/api/pipeline/transcripts", (_req, res) => {
    const config = pipeline.getConfig();
    const transcriptDir = config.transcriptDir;
    try {
      if (!fs.existsSync(transcriptDir)) return res.json([]);

      const files = fs.readdirSync(transcriptDir)
        .filter(f => f.endsWith(".md") || f.endsWith(".json"))
        .map(f => ({
          name: f,
          path: path.join(transcriptDir, f),
          size: fs.statSync(path.join(transcriptDir, f)).size,
          modified: fs.statSync(path.join(transcriptDir, f)).mtime.toISOString(),
        }))
        .sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());

      res.json(files);
    } catch (error) {
      res.status(500).json({ error: "Failed to list transcripts" });
    }
  });

  // Serve a specific transcript file by basename. Path is hardened
  // against directory-traversal: the resolved path must sit inside the
  // resolved transcriptDir.
  app.get("/api/pipeline/transcripts/:filename", (req, res) => {
    const config = pipeline.getConfig();
    const filePath = path.join(config.transcriptDir, req.params.filename);

    const resolved = path.resolve(filePath);
    const resolvedDir = path.resolve(config.transcriptDir);
    if (!resolved.startsWith(resolvedDir)) {
      return res.status(403).json({ error: "Access denied" });
    }
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "File not found" });
    }

    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.send(fs.readFileSync(filePath, "utf-8"));
  });

  // ---- Channel management (configured + virtual) ----

  app.post("/api/pipeline/channels", (req, res) => {
    try {
      const { name, url, diarize, category } = req.body;
      if (!name || !url) return res.status(400).json({ error: "Name and URL are required" });

      const config = pipeline.getConfig();
      const newChannel = {
        id: `ch-${Date.now()}`,
        name,
        url,
        enabled: true,
        diarize: diarize === false ? false : true,
        category: category === "work" ? "work" as const : "personal" as const,
      };

      config.channels.push(newChannel);
      pipeline.updateConfig(config);

      res.json({ success: true, channel: newChannel });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to add channel" });
    }
  });

  app.delete("/api/pipeline/channels/:channelId", (req, res) => {
    const config = pipeline.getConfig();
    const idx = config.channels.findIndex(c => c.id === req.params.channelId);
    if (idx === -1) return res.status(404).json({ error: "Channel not found" });

    config.channels.splice(idx, 1);
    pipeline.updateConfig(config);
    res.json({ success: true });
  });

  app.patch("/api/pipeline/channels/:channelId", (req, res) => {
    const config = pipeline.getConfig();
    const channel = config.channels.find(c => c.id === req.params.channelId);
    if (!channel) return res.status(404).json({ error: "Channel not found" });

    if (req.body.enabled !== undefined) channel.enabled = req.body.enabled;
    if (req.body.diarize !== undefined) channel.diarize = !!req.body.diarize;
    if (req.body.include_shorts !== undefined) channel.include_shorts = !!req.body.include_shorts;
    if (req.body.category === "personal" || req.body.category === "work") {
      // Cascade onto the channel's existing videos so the queue filter
      // doesn't lag behind the channel-level change.
      const next = req.body.category;
      channel.category = next;
      // updateChannelCategory writes to both tables in one txn.
      try { updateChannelCategory(req.params.channelId, next); } catch { /* falls through to updateConfig */ }
    }
    if (typeof req.body.name === "string" && req.body.name.trim()) {
      // The folder on disk uses the OLD name as its name. We don't move
      // the folder here because every video's video_path is absolute —
      // the path keeps working regardless of channel display name. New
      // videos go to a folder built from the new name, which can create
      // a second folder for the channel; the user can manually merge
      // those if they care, but functionally everything resolves fine.
      channel.name = req.body.name.trim();
    }
    pipeline.updateConfig(config);
    res.json({ success: true, channel });
  });

  /**
   * Scan a channel's local save folder for video files not yet tracked
   * in video_queue, and queue them as local-import entries. Use case:
   * user has a manually-downloaded video sitting in the channel folder
   * that should be indexed/transcribed alongside the rest.
   *
   * The channel's expected folder is
   *   `<videoSaveDir>/<channelFolderName(channel.name)>/`
   * For "virtual" channels (one-off downloads without a channels-table
   * row), the channelId string itself is used as the folder name.
   */
  app.post("/api/pipeline/channels/:channelId/import-folder", (req, res) => {
    try {
      const config = pipeline.getConfig();
      const configured = config.channels.find(c => c.id === req.params.channelId);

      // Fall back to treating channelId itself as the channel name when
      // no channels-table row exists. This covers virtual channels.
      const channelIdKey = configured?.id ?? req.params.channelId;
      const channelName = configured?.name ?? req.params.channelId;

      const channelFolder = channelFolderName(channelName);
      const folder = path.join(config.videoSaveDir, channelFolder);
      if (!fs.existsSync(folder)) {
        return res.status(404).json({ error: `Channel folder not found: ${folder}` });
      }

      // Pull existing paths once so the per-file lookup is in-memory.
      const existing = new Set<string>(
        (getDb()
          .prepare("SELECT video_path FROM video_queue WHERE channel_id = ? AND video_path IS NOT NULL AND video_path <> ''")
          .all(channelIdKey) as { video_path: string }[])
          .map(r => r.video_path),
      );

      // Filter passes:
      //   1. Skip dotfiles and non-media extensions.
      //   2. Skip our own derivative files: <stem>.playback.<ext>
      //      (browser-friendly AAC sidecar) and <stem>.vp9.bak
      //      (rollback file from the VP9→H.264 transcode script).
      //   3. Skip audio files whose stem matches an existing video file
      //      in the same folder — that's a keepAudio sidecar
      //      (<videoStem>.m4a alongside <videoStem>.mp4), not a
      //      standalone audio item the user wants to import.
      const VIDEO_EXTS = new Set([".mp4", ".mkv", ".mov", ".webm", ".avi", ".m4v"]);
      const AUDIO_EXTS = new Set([".mp3", ".m4a", ".wav", ".flac", ".aac", ".opus", ".ogg"]);

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(folder, { withFileTypes: true });
      } catch (err) {
        return res.status(500).json({ error: `Read folder failed: ${err instanceof Error ? err.message : String(err)}` });
      }

      // Two-pass: collect video-file stems so the audio pass can skip
      // any with a matching video sibling.
      const videoStems = new Set<string>();
      for (const e of entries) {
        if (!e.isFile() || e.name.startsWith(".")) continue;
        const ext = path.extname(e.name).toLowerCase();
        if (!VIDEO_EXTS.has(ext)) continue;
        const stem = path.basename(e.name, ext);
        if (stem.toLowerCase().endsWith(".playback")) continue;
        if (stem.toLowerCase().endsWith(".vp9.bak")) continue;
        videoStems.add(stem);
      }

      const found: string[] = [];
      for (const e of entries) {
        if (!e.isFile() || e.name.startsWith(".")) continue;
        const ext = path.extname(e.name).toLowerCase();
        const stem = path.basename(e.name, ext);
        const stemLower = stem.toLowerCase();
        if (stemLower.endsWith(".playback")) continue;
        if (stemLower.endsWith(".vp9.bak")) continue;
        if (VIDEO_EXTS.has(ext)) {
          // pass
        } else if (AUDIO_EXTS.has(ext)) {
          if (videoStems.has(stem)) continue;
        } else {
          continue;
        }
        const full = path.join(folder, e.name);
        if (existing.has(full)) continue;
        found.push(full);
      }

      const added: { videoId: string; title: string; videoPath: string }[] = [];
      const skipped: { videoPath: string; reason: string }[] = [];
      for (const full of found) {
        const stem = path.basename(full, path.extname(full));
        // Filename pattern is `YYYY-MM-DD - Title` (datedBaseName output).
        // Strip the prefix when present; fall back to the bare stem.
        const dateMatch = stem.match(/^(\d{4})-(\d{2})-(\d{2})\s+-\s+(.+)$/);
        const uploadDate = dateMatch ? `${dateMatch[1]}${dateMatch[2]}${dateMatch[3]}` : null;
        const title = dateMatch ? dateMatch[4].replace(/_/g, " ") : stem;

        // Stable id derived from the absolute path; same scheme as
        // local-folder channels so a path-based dedup still works.
        const hash = crypto.createHash("sha256").update(full).digest("hex");
        const videoId = `local-${hash.substring(0, 11)}`;

        const inserted = enqueueVideo({
          videoId,
          channelId: channelIdKey,
          title,
          url: `file://${full}`,
          duration: null,
          isLive: false,
          isShorts: false,
          uploadDate,
        });
        if (!inserted) {
          skipped.push({ videoPath: full, reason: "Already queued under this id" });
          continue;
        }
        updateQueueStatus(videoId, channelIdKey, { videoPath: full });
        added.push({ videoId, title, videoPath: full });
      }

      res.json({
        ok: true,
        folder,
        scanned: found.length,
        added: added.length,
        skipped: skipped.length,
        details: { added, skipped },
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Import folder failed" });
    }
  });

  /**
   * "Virtual" channels: distinct channel_id values in video_queue that
   * don't correspond to a configured channels-table row. These appear
   * when a user does a one-off manual download — the download flow
   * stamps the readable channel name into video_queue.channel_id
   * without creating a channels row (which would have triggered
   * auto-archive). The UI surfaces these so Rename / Import-folder
   * stay reachable.
   */
  app.get("/api/pipeline/channels/virtual", (_req, res) => {
    try {
      const configuredIds = new Set(pipeline.getConfig().channels.map(c => c.id));
      const rows = getDb()
        .prepare(`
          SELECT channel_id, COUNT(*) AS video_count
          FROM video_queue
          GROUP BY channel_id
        `)
        .all() as { channel_id: string; video_count: number }[];
      const virtual = rows
        .filter(r => !configuredIds.has(r.channel_id))
        .map(r => ({ channelId: r.channel_id, videoCount: r.video_count }))
        .sort((a, b) => b.videoCount - a.videoCount);
      res.json({ channels: virtual });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Virtual channel list failed" });
    }
  });

  /**
   * Rename a virtual channel — UPDATEs video_queue rows referencing
   * the old channel_id string. Used to fix UC... → "Rick Joyner" after
   * a manual download captured the wrong identifier.
   */
  app.patch("/api/pipeline/channels/virtual/:channelId", (req, res) => {
    try {
      const oldId = req.params.channelId;
      const newName = (req.body?.name ?? "").toString().trim();
      if (!newName) return res.status(400).json({ error: "name required" });
      if (newName === oldId) return res.json({ ok: true, updated: 0 });

      const configuredIds = new Set(pipeline.getConfig().channels.map(c => c.id));
      if (configuredIds.has(oldId)) {
        return res.status(400).json({ error: "Use /api/pipeline/channels/:id PATCH for configured channels" });
      }

      const r = getDb()
        .prepare("UPDATE video_queue SET channel_id = ? WHERE channel_id = ?")
        .run(newName, oldId);
      res.json({ ok: true, updated: r.changes });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Virtual channel rename failed" });
    }
  });

  // Re-transcribe a video with an optional different model. The work
  // runs in the background queue (pipeline.retranscribeVideo returns a
  // stub job immediately); the client watches /api/pipeline/state /
  // events for progress.
  app.post("/api/pipeline/retranscribe", async (req, res) => {
    try {
      const { videoId, channelId, model } = req.body;
      if (!videoId || !channelId) return res.status(400).json({ error: "videoId and channelId required" });
      const job = await pipeline.retranscribeVideo(videoId, channelId, model);
      res.json(job);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Re-transcribe failed" });
    }
  });

  // Retry a failed video from scratch — deletes any partial/corrupt
  // download and re-runs the full pipeline (download → transcribe →
  // embed → summarize). Unlike retranscribe (which reuses the existing
  // file), this re-downloads, so it's the right tool for download
  // failures like a truncated container ("moov atom not found"). Returns
  // a stub job immediately; progress watched via /api/pipeline/state.
  app.post("/api/pipeline/retry", async (req, res) => {
    try {
      const { videoId, channelId } = req.body;
      if (!videoId || !channelId) return res.status(400).json({ error: "videoId and channelId required" });
      const job = await pipeline.retryVideo(videoId, channelId);
      res.json(job);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Retry failed" });
    }
  });

  // Transcribe an already-downloaded video file. Used by the
  // Manual trigger for the channel UC-id backfill. Same job that
  // runs in the background at server startup, exposed so the user
  // can re-run after adding new channels without restarting.
  app.post("/api/pipeline/resolve-channel-ucs", async (_req, res) => {
    try {
      const { backfillChannelUcIds } = await import("./db");
      const { resolveChannelUcId } = await import("./channel-monitor");
      const result = await backfillChannelUcIds(resolveChannelUcId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Failed to resolve channel UC ids" });
    }
  });

  // file-import flow when the user drops a local video into the app
  // without going through a YouTube download.
  app.post("/api/pipeline/transcribe-file", async (req, res) => {
    try {
      const { filePath, title, uploadDate, videoId, channelId, channelName } = req.body;
      if (!filePath) return res.status(400).json({ error: "filePath required" });

      res.json({ accepted: true, message: "Transcription started" });

      try {
        await pipeline.processDownloadedFile(filePath, title || path.basename(filePath), uploadDate, videoId, channelId, channelName);
      } catch (error) {
        console.error("[pipeline] Transcribe-file failed:", error);
      }
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Transcription failed" });
    }
  });

  // Full archive scan — fetch every video the channel ever uploaded
  // and enqueue any not already in video_queue. Slow for big channels;
  // the UI shows progress via archiveProgress events on the SSE stream.
  app.post("/api/pipeline/archive/:channelId", async (req, res) => {
    try {
      const result = await pipeline.archiveChannel(req.params.channelId);
      res.json({ success: true, ...result });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Archive failed" });
    }
  });
}
