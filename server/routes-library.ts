import type { Express, Request, Response } from "express";
import { spawn, execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";
import {
  countByStatus,
  getChannelQueue,
  getDb,
  getQueueEntry,
  getQueueList,
  getTranscriptSegmentsForVideo,
  getTranscriptSearchIndexStats,
  refreshTranscriptSearchIndex,
  searchTranscriptSegments,
  setVideoNotes,
  updateQueueStatus,
  getVideoSpeakerSummary,
  getVideoSpeakerSummariesBatch,
  type QueueEntry,
} from "./db";
import { copyAudioTrack, encodeAacSidecar, ffmpegBin, getVideoStreamInfo } from "./audio";
import type { Pipeline } from "./pipeline";

// execFile (argv-style, NOT shell exec) wrapped as a Promise. Used only
// to call `gio trash` / `osascript` with fixed argument vectors — no
// user input is interpolated into a shell string.
const execFileAsync = promisify(execFile);

/** Move a file to the OS trash (restorable). Linux uses `gio trash`
 *  (freedesktop trash spec, what Files / Nautilus respects). macOS uses
 *  Finder via AppleScript so "Put Back" works. */
async function moveToTrash(absPath: string): Promise<void> {
  if (process.platform === "linux") {
    try {
      await execFileAsync("gio", ["trash", absPath]);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`gio trash failed — install gvfs-bin / glib2.0-bin? (${msg})`);
    }
  }
  if (process.platform === "darwin") {
    const escaped = absPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const script = `tell application "Finder" to delete POSIX file "${escaped}"`;
    await execFileAsync("osascript", ["-e", script]);
    return;
  }
  throw new Error(`Trash is not implemented on ${process.platform}`);
}

type ExportMode = "fast" | "accurate";

function formatSecondsForFile(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  return [hours, minutes, secs].map(part => String(part).padStart(2, "0")).join("-");
}

function uniquePath(filePath: string): string {
  if (!fs.existsSync(filePath)) return filePath;
  const parsed = path.parse(filePath);
  for (let i = 2; i < 1000; i++) {
    const candidate = path.join(parsed.dir, `${parsed.name}-${i}${parsed.ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(parsed.dir, `${parsed.name}-${Date.now()}${parsed.ext}`);
}

function exportVideoSegment(options: {
  inputPath: string;
  outputPath: string;
  startSeconds: number;
  duration: number;
  mode: ExportMode;
  quality: string;
}): Promise<void> {
  const start = String(Math.max(0, options.startSeconds));
  const duration = String(Math.max(0.1, options.duration));
  const args =
    options.mode === "fast"
      ? [
          "-ss", start,
          "-i", options.inputPath,
          "-t", duration,
          "-map", "0:v:0?",
          "-map", "0:a:0?",
          "-c", "copy",
          "-avoid_negative_ts", "make_zero",
          "-y",
          options.outputPath,
        ]
      : [
          "-ss", start,
          "-i", options.inputPath,
          "-t", duration,
          "-map", "0:v:0?",
          "-map", "0:a:0?",
          ...(options.quality !== "same" ? ["-vf", `scale=-2:${options.quality}`] : []),
          "-c:v", "libx264",
          "-preset", "veryfast",
          "-crf", "20",
          "-c:a", "aac",
          "-b:a", "160k",
          "-movflags", "+faststart",
          "-y",
          options.outputPath,
        ];

  console.log(`[export] ffmpeg ${args.join(" ")}`);

  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", data => {
      stderr += data.toString();
      if (stderr.length > 12000) stderr = stderr.slice(-12000);
    });
    proc.on("error", err => reject(new Error(`Failed to start ffmpeg: ${err.message}`)));
    proc.on("close", code => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-1000)}`));
    });
  });
}

/**
 * Library / transcript / search / stream / export / orphan endpoints —
 * everything that operates on a specific (channelId, videoId) record
 * plus the transcript FTS search, the rename / trash / orphan repair
 * helpers, the byte-range video stream, and the export-segment clip
 * cutter. Pipeline-control / channel-management endpoints stay in
 * routes.ts.
 */
export function registerLibraryRoutes(app: Express, pipeline: Pipeline): void {
  app.get("/api/transcripts/search", (req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      const query = String(req.query.q || "");
      const liveFilter = String(req.query.type || "all");
      const tagsParam = typeof req.query.tags === "string" ? req.query.tags : "";
      const tags = tagsParam.split(",").map(t => t.trim()).filter(Boolean);
      const speakerIdParam = typeof req.query.speakerId === "string" && req.query.speakerId ? req.query.speakerId : undefined;
      const results = searchTranscriptSegments(query, {
        channelId: String(req.query.channelId || "all"),
        status: String(req.query.status || "complete"),
        isLive: liveFilter === "live" ? true : liveFilter === "video" ? false : undefined,
        dateFrom: req.query.dateFrom ? String(req.query.dateFrom) : undefined,
        dateTo: req.query.dateTo ? String(req.query.dateTo) : undefined,
        tags,
        speakerId: speakerIdParam,
        limit: req.query.limit ? Number(req.query.limit) : 100,
      });
      res.json({ results, index: getTranscriptSearchIndexStats() });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Transcript search failed" });
    }
  });

  app.get(
    "/api/videos/library/:channelId/:videoId/speakers",
    (req: Request<{ channelId: string; videoId: string }>, res) => {
      res.json({ speakers: getVideoSpeakerSummary(req.params.videoId, req.params.channelId) });
    },
  );

  app.post("/api/videos/library/speakers-batch", (req, res) => {
    try {
      const items = Array.isArray(req.body?.videos) ? req.body.videos : [];
      const pairs = items
        .map((v: any) => ({ video_id: String(v?.videoId || ""), channel_id: String(v?.channelId || "") }))
        .filter((p: any) => p.video_id && p.channel_id);
      res.json({ speakers: getVideoSpeakerSummariesBatch(pairs) });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed" });
    }
  });

  app.post("/api/transcripts/search/reindex", (_req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json({ success: true, ...refreshTranscriptSearchIndex() });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Transcript reindex failed" });
    }
  });

  app.get("/api/transcripts/search/stats", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(getTranscriptSearchIndexStats());
  });

  app.get(
    "/api/videos/library/:channelId/:videoId/transcript",
    async (req: Request<{ channelId: string; videoId: string }>, res: Response) => {
      try {
        res.setHeader("Cache-Control", "no-store");
        const entry = getQueueEntry(req.params.videoId, req.params.channelId);
        if (!entry) return res.status(404).json({ error: "Video not found" });

        // Probe the file for codec / resolution / size so the drawer can
        // show a "Decoder" badge. Best-effort.
        let video = null;
        if (entry.video_path && fs.existsSync(entry.video_path)) {
          try { video = await getVideoStreamInfo(entry.video_path); } catch {}
        }

        res.json({
          videoId: entry.video_id,
          channelId: entry.channel_id,
          segments: getTranscriptSegmentsForVideo(entry.video_id, entry.channel_id),
          notes: entry.notes ?? "",
          aiSummary: entry.ai_summary ?? "",
          aiSummaryModel: entry.ai_summary_model ?? null,
          video,
        });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : "Transcript load failed" });
      }
    },
  );

  registerLibraryMutators(app, pipeline);
}

/** Mutators + streamers split out so the public function stays readable. */
function registerLibraryMutators(app: Express, pipeline: Pipeline): void {
  app.post(
    "/api/videos/library/:channelId/:videoId/rename",
    async (req: Request<{ channelId: string; videoId: string }, unknown, { newBasename?: string }>, res: Response) => {
      try {
        const entry = getQueueEntry(req.params.videoId, req.params.channelId);
        if (!entry) return res.status(404).json({ error: "Video not found" });

        const rawNewName = (req.body?.newBasename ?? "").trim();
        if (!rawNewName) return res.status(400).json({ error: "newBasename required" });
        if (rawNewName.length > 200) return res.status(400).json({ error: "Name too long (max 200 chars)" });
        if (/[\\\/]/.test(rawNewName)) return res.status(400).json({ error: "Name may not contain / or \\" });
        if (rawNewName.startsWith(".")) return res.status(400).json({ error: "Name may not start with ." });
        // eslint-disable-next-line no-control-regex
        if (/[\x00-\x1f]/.test(rawNewName)) return res.status(400).json({ error: "Name contains control characters" });

        if (!entry.video_path) return res.status(400).json({ error: "Entry has no video_path" });
        if (!fs.existsSync(entry.video_path)) return res.status(404).json({ error: `Video file missing: ${entry.video_path}` });

        const videoDir = path.dirname(entry.video_path);
        const videoExt = path.extname(entry.video_path);
        const oldVideoStem = path.basename(entry.video_path, videoExt);
        if (oldVideoStem === rawNewName) return res.status(400).json({ error: "New name matches existing name" });

        const newVideoPath = path.join(videoDir, `${rawNewName}${videoExt}`);
        if (fs.existsSync(newVideoPath)) return res.status(409).json({ error: `A file already exists at ${newVideoPath}` });

        type Move = { from: string; to: string };
        const planned: Move[] = [{ from: entry.video_path, to: newVideoPath }];

        if (entry.md_path && fs.existsSync(entry.md_path)) {
          const mdDir = path.dirname(entry.md_path);
          const mdExt = path.extname(entry.md_path);
          const newMdPath = path.join(mdDir, `${rawNewName}${mdExt}`);
          if (fs.existsSync(newMdPath)) return res.status(409).json({ error: `Transcript already exists at ${newMdPath}` });
          planned.push({ from: entry.md_path, to: newMdPath });
        }

        if (entry.playback_path && fs.existsSync(entry.playback_path)) {
          const pbDir = path.dirname(entry.playback_path);
          const pbBase = path.basename(entry.playback_path);
          const stripStem = pbBase.startsWith(oldVideoStem) ? pbBase.slice(oldVideoStem.length) : pbBase;
          const newPlaybackPath = path.join(pbDir, `${rawNewName}${stripStem}`);
          if (fs.existsSync(newPlaybackPath)) return res.status(409).json({ error: `Sidecar already exists at ${newPlaybackPath}` });
          planned.push({ from: entry.playback_path, to: newPlaybackPath });
        }

        const completed: Move[] = [];
        try {
          for (const move of planned) {
            fs.renameSync(move.from, move.to);
            completed.push(move);
          }
        } catch (renameErr) {
          for (const m of completed.reverse()) {
            try { fs.renameSync(m.to, m.from); } catch { /* best effort */ }
          }
          const msg = renameErr instanceof Error ? renameErr.message : String(renameErr);
          return res.status(500).json({ error: `Rename failed and rolled back: ${msg}` });
        }

        const updates: { videoPath?: string; mdPath?: string; playbackPath?: string } = {};
        updates.videoPath = planned[0].to;
        let nextIdx = 1;
        if (entry.md_path && fs.existsSync(planned[nextIdx]?.to ?? "")) {
          updates.mdPath = planned[nextIdx].to;
          nextIdx++;
        }
        if (entry.playback_path && planned[nextIdx]) {
          updates.playbackPath = planned[nextIdx].to;
        }
        updateQueueStatus(entry.video_id, entry.channel_id, updates);

        res.json({ ok: true, videoPath: updates.videoPath, mdPath: updates.mdPath, playbackPath: updates.playbackPath });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : "Rename failed" });
      }
    },
  );

  app.get("/api/videos/library/orphans", (_req, res) => {
    try {
      const rows = getDb()
        .prepare(`SELECT * FROM video_queue WHERE video_path IS NOT NULL AND video_path <> ''`)
        .all() as QueueEntry[];
      const orphans = rows
        .filter((r) => r.video_path && !fs.existsSync(r.video_path))
        .map((r) => ({
          videoId: r.video_id,
          channelId: r.channel_id,
          title: r.title,
          uploadDate: r.upload_date,
          videoPath: r.video_path,
          mdPath: r.md_path,
          mdExists: !!r.md_path && fs.existsSync(r.md_path),
          status: r.status,
          wordCount: r.word_count,
        }));
      res.json({ orphans, total: orphans.length });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Orphan scan failed" });
    }
  });

  app.post(
    "/api/videos/library/:channelId/:videoId/relink",
    (req: Request<{ channelId: string; videoId: string }, unknown, { newVideoPath?: string }>, res: Response) => {
      try {
        const entry = getQueueEntry(req.params.videoId, req.params.channelId);
        if (!entry) return res.status(404).json({ error: "Video not found" });

        const newVideoPath = (req.body?.newVideoPath ?? "").trim();
        if (!newVideoPath) return res.status(400).json({ error: "newVideoPath required" });
        if (!path.isAbsolute(newVideoPath)) return res.status(400).json({ error: "Path must be absolute" });
        if (!fs.existsSync(newVideoPath)) return res.status(404).json({ error: `File does not exist: ${newVideoPath}` });

        const stat = fs.statSync(newVideoPath);
        if (!stat.isFile()) return res.status(400).json({ error: "Path is not a regular file" });

        updateQueueStatus(entry.video_id, entry.channel_id, { videoPath: newVideoPath });
        res.json({ ok: true, videoPath: newVideoPath });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : "Relink failed" });
      }
    },
  );

  app.post(
    "/api/videos/library/:channelId/:videoId/forget",
    (req: Request<{ channelId: string; videoId: string }>, res: Response) => {
      try {
        const entry = getQueueEntry(req.params.videoId, req.params.channelId);
        if (!entry) return res.status(404).json({ error: "Video not found" });
        getDb()
          .prepare("DELETE FROM video_queue WHERE video_id = ? AND channel_id = ?")
          .run(entry.video_id, entry.channel_id);
        res.json({ ok: true });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : "Forget failed" });
      }
    },
  );

  app.post(
    "/api/videos/library/:channelId/:videoId/trash",
    async (req: Request<{ channelId: string; videoId: string }>, res: Response) => {
      try {
        const entry = getQueueEntry(req.params.videoId, req.params.channelId);
        if (!entry) return res.status(404).json({ error: "Video not found" });

        const targets: string[] = [];
        if (entry.video_path && fs.existsSync(entry.video_path)) targets.push(entry.video_path);
        if (entry.md_path && fs.existsSync(entry.md_path)) targets.push(entry.md_path);
        if (entry.playback_path && fs.existsSync(entry.playback_path)) targets.push(entry.playback_path);

        // The transcript engines (FluidAudio / Parakeet / Whisper) write a
        // JSON sidecar next to the .md with the same basename. We don't
        // track its path in the DB but the convention is stable, so derive
        // it from md_path — orphan JSONs are dead bytes and confuse later
        // re-import scans that look for "transcript exists?" hints.
        if (entry.md_path && entry.md_path.endsWith(".md")) {
          const jsonPath = entry.md_path.slice(0, -3) + ".json";
          if (fs.existsSync(jsonPath)) targets.push(jsonPath);
        }

        if (targets.length === 0) {
          return res.status(400).json({ error: "No files on disk to trash (entry already orphaned?)" });
        }

        const trashed: string[] = [];
        const failed: { path: string; error: string }[] = [];
        for (const target of targets) {
          try {
            await moveToTrash(target);
            trashed.push(target);
          } catch (err) {
            failed.push({ path: target, error: err instanceof Error ? err.message : String(err) });
          }
        }

        // If we got every file to the trash, drop the queue row entirely.
        // The previous behavior left the row at status="archived" with the
        // file paths nulled to "preserve" notes/clips/embeddings via the
        // shared video_id string — but those tables don't FK to video_queue,
        // so the clips/notes survive a hard delete on their own. An orphan
        // queue row at status="archived" with no playable file just clutters
        // the Library. If anything failed to trash, leave the row alone so
        // the user has something to retry against.
        if (failed.length === 0 && trashed.length > 0) {
          getDb()
            .prepare("DELETE FROM video_queue WHERE video_id = ? AND channel_id = ?")
            .run(entry.video_id, entry.channel_id);
        }

        if (failed.length > 0 && trashed.length === 0) {
          return res.status(500).json({ error: failed[0].error, failed });
        }
        res.json({ ok: true, trashed, failed });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : "Trash failed" });
      }
    },
  );

  app.get(
    "/api/videos/library/:channelId/:videoId/stream",
    async (req: Request<{ channelId: string; videoId: string }>, res: Response) => {
      try {
        const entry = getQueueEntry(req.params.videoId, req.params.channelId);
        if (!entry?.video_path) {
          return res.status(404).json({ error: "Video file is not recorded in the library" });
        }

        // Prefer the browser-friendly playback sidecar when one exists
        // (set at ingestion for Ogg-Speex / Ogg-FLAC / other codecs
        // Firefox/Safari can't decode). Falls back to the original if
        // the sidecar's missing on disk (e.g. workingDir was cleaned).
        let sidecar = entry.playback_path ? path.resolve(entry.playback_path) : null;
        let usingSidecar = !!sidecar && fs.existsSync(sidecar);

        // Lazy fallback for entries that predate the playback-sidecar
        // feature, or that use an extension Firefox/Safari may not
        // decode. Generate one on first stream and persist its path so
        // subsequent streams are instant. Sidecar lives next to the
        // source; falls back to the app's working dir if the source
        // folder is read-only.
        const NEEDS_SIDECAR_EXTS = new Set([".ogg", ".oga", ".opus", ".flac", ".webm"]);
        const sourceExt = path.extname(entry.video_path).toLowerCase();
        if (!usingSidecar && NEEDS_SIDECAR_EXTS.has(sourceExt) && fs.existsSync(entry.video_path)) {
          const sourceStem = path.basename(entry.video_path, sourceExt);
          const beside = path.join(path.dirname(entry.video_path), `${sourceStem}.playback.m4a`);
          const cacheDir = path.join(pipeline.getConfig().workingDir, "playback-cache");
          const fallbackSidecar = path.join(cacheDir, `${entry.video_id}.playback.m4a`);
          let sidecarPath: string | null = null;
          try {
            if (fs.existsSync(beside)) {
              sidecarPath = beside;
            } else {
              await encodeAacSidecar(entry.video_path, beside);
              sidecarPath = beside;
            }
          } catch (err) {
            console.warn(`[stream] Cannot write sidecar beside source for ${entry.video_id}; using ${fallbackSidecar}:`, err);
            try {
              if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
              if (!fs.existsSync(fallbackSidecar)) await encodeAacSidecar(entry.video_path, fallbackSidecar);
              sidecarPath = fallbackSidecar;
            } catch (err2) {
              console.error(`[stream] Sidecar fallback also failed for ${entry.video_id}:`, err2);
            }
          }
          if (sidecarPath) {
            updateQueueStatus(entry.video_id, entry.channel_id, { playbackPath: sidecarPath });
            sidecar = sidecarPath;
            usingSidecar = true;
          }
        }

        const videoPath = usingSidecar ? sidecar! : path.resolve(entry.video_path);
        if (!fs.existsSync(videoPath)) {
          return res.status(404).json({ error: "Video file not found on disk" });
        }

        const stat = fs.statSync(videoPath);
        const fileSize = stat.size;
        const ext = path.extname(videoPath).toLowerCase();
        const contentType =
          ext === ".webm" ? "video/webm" :
          ext === ".mkv" ? "video/x-matroska" :
          ext === ".m4v" ? "video/x-m4v" :
          ext === ".mp3" ? "audio/mpeg" :
          ext === ".m4a" ? "audio/mp4" :
          ext === ".wav" ? "audio/wav" :
          ext === ".flac" ? "audio/flac" :
          ext === ".aac" ? "audio/aac" :
          ext === ".opus" ? "audio/ogg" :
          ext === ".ogg" ? "audio/ogg" :
          "video/mp4";
        const range = req.headers.range;

        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Cache-Control", "no-store");

        if (!range) {
          res.writeHead(200, { "Content-Length": fileSize, "Content-Type": contentType });
          fs.createReadStream(videoPath).pipe(res);
          return;
        }

        const match = range.match(/bytes=(\d*)-(\d*)/);
        if (!match) {
          res.status(416).setHeader("Content-Range", `bytes */${fileSize}`);
          return res.end();
        }

        const start = match[1] ? Number(match[1]) : 0;
        const end = match[2] ? Number(match[2]) : fileSize - 1;
        if (!Number.isFinite(start) || !Number.isFinite(end) || start >= fileSize || end >= fileSize || start > end) {
          res.status(416).setHeader("Content-Range", `bytes */${fileSize}`);
          return res.end();
        }

        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${fileSize}`,
          "Accept-Ranges": "bytes",
          "Content-Length": end - start + 1,
          "Content-Type": contentType,
        });
        fs.createReadStream(videoPath, { start, end }).pipe(res);
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : "Video stream failed" });
      }
    },
  );

  app.post(
    "/api/videos/library/:channelId/:videoId/export-segment",
    async (req: Request<{ channelId: string; videoId: string }>, res: Response) => {
      try {
        const entry = getQueueEntry(req.params.videoId, req.params.channelId);
        if (!entry?.video_path) return res.status(404).json({ error: "Video file is not recorded in the library" });

        const inputPath = path.resolve(entry.video_path);
        if (!fs.existsSync(inputPath)) return res.status(404).json({ error: "Video file not found on disk" });

        const startSeconds = Number(req.body?.startSeconds ?? -1);
        const endSeconds = Number(req.body?.endSeconds ?? -1);
        if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
          return res.status(400).json({ error: "Invalid start/end" });
        }

        const duration = endSeconds - startSeconds;
        const mode = (req.body?.mode === "accurate" ? "accurate" : "fast") as ExportMode;
        const quality = String(req.body?.quality ?? "same");
        const outputDir = path.resolve(String(req.body?.outputDir ?? pipeline.getConfig().videoSaveDir));
        if (!fs.existsSync(outputDir)) {
          try { fs.mkdirSync(outputDir, { recursive: true }); }
          catch { return res.status(400).json({ error: `Cannot create output dir: ${outputDir}` }); }
        }

        const baseName = path.basename(entry.video_path, path.extname(entry.video_path));
        const startLabel = formatSecondsForFile(startSeconds);
        const endLabel = formatSecondsForFile(endSeconds);
        const outputPath = uniquePath(path.join(outputDir, `${baseName} - ${startLabel}_to_${endLabel}.mp4`));

        await exportVideoSegment({ inputPath, outputPath, startSeconds, duration, mode, quality });

        const stat = fs.statSync(outputPath);
        res.json({ ok: true, outputPath, sizeBytes: stat.size, durationSeconds: duration, mode });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : "Export failed" });
      }
    },
  );

  app.patch(
    "/api/videos/library/:channelId/:videoId/notes",
    (req: Request<{ channelId: string; videoId: string }>, res: Response) => {
      try {
        const { notes } = req.body || {};
        const value = notes === null || notes === undefined ? null : String(notes);
        setVideoNotes(req.params.videoId, req.params.channelId, value);
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : "Failed to save notes" });
      }
    },
  );

  // Queue listings live here too since the Library UI is the main
  // consumer of both (channel-scoped + global).
  app.get("/api/pipeline/queue/:channelId", (req, res) => {
    const counts = countByStatus(req.params.channelId);
    const recent = getChannelQueue(req.params.channelId, 50);
    res.json({ counts, recent });
  });

  app.get("/api/pipeline/queue", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const requestedLimit = Number(req.query.limit);
    const limit = Number.isFinite(requestedLimit) ? requestedLimit : 100;
    const requestedOffset = Number(req.query.offset);
    const offset = Number.isFinite(requestedOffset) ? requestedOffset : 0;
    const result = getQueueList({
      limit,
      offset,
      status: String(req.query.status || "all"),
      channelId: String(req.query.channelId || "all"),
      type: String(req.query.type || "all"),
      hasTranscript: String(req.query.hasTranscript || "all"),
      q: req.query.q ? String(req.query.q) : "",
      sort: String(req.query.sort || "upload_desc"),
    });
    res.json({
      counts: result.counts,
      recent: result.rows,
      total: result.total,
      limit: Math.min(Math.max(Math.floor(limit), 1), 250),
      offset: Math.max(Math.floor(offset), 0),
    });
  });
}
