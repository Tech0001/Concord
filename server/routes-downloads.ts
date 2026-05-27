import type { Express } from "express";
import path from "path";
import fs from "fs";
import { nanoid } from "nanoid";
import { storage } from "./storage";
import { getYouTubeVideoInfo, downloadYouTubeVideo, formatDuration } from "./youtube-dl";
import { copyAudioTrack } from "./audio";
import { channelFolderName, datedBaseName, replaceExtension } from "./naming";
import {
  enqueueVideo,
  findChannelByYouTubeInfo,
  getQueueEntryByVideoId,
  updateQueueStatus,
} from "./db";
import type { Pipeline } from "./pipeline";

/**
 * One-off manual downloads — /api/videos/info, /api/videos/download,
 * the SSE progress stream, and the file-serve / "saved to your folder"
 * endpoint. Owns the cross-request `activeDownloads` map, the
 * `temp/` working directory, and the 15-minute periodic cleanup that
 * removes orphaned temp files (so a browser tab that gets closed
 * mid-download doesn't leave 2GB sitting on disk forever).
 *
 * Returns a `shutdown` hook so the caller can clear the cleanup
 * interval cleanly when the HTTP server closes.
 */
export function registerDownloadRoutes(app: Express, pipeline: Pipeline): { shutdown: () => void } {
  // Map keyed by the downloadId nanoid the route hands the client.
  // We keep entries around for a short window after completion so a
  // browser retry-on-failure can still pick up the file.
  const activeDownloads = new Map<string, {
    percent: number;
    downloadPath: string;
    videoId: string;
    finalLocation?: string;
    uploadDate?: string | null;
    channelId?: string | null;
    channelName?: string | null;
    /** yt-dlp's channel_url for the video — used by
     *  findChannelByYouTubeInfo's handle / normalized-URL matchers
     *  to attach the download to an already-configured channel when
     *  the UC id and display name alone don't disambiguate. */
    channelUrl?: string | null;
    /** Personal / work — passed through to enqueueVideo when the
     *  download finalizes. Defaults to the matched configured
     *  channel's category (or 'personal' if no match). */
    category?: "personal" | "work";
    isComplete: boolean;
  }>();

  // Create + own the temp working dir. Lives under cwd so it gets the
  // user's actual videoSaveDir-adjacent location when launched from
  // their project, and under app.userData when launched as the Electron
  // packaged binary (electron/main.ts chdirs there).
  const tempDir = path.join(process.cwd(), "temp");
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  // Daily scheduled cleanup. Anything older than 30 minutes that isn't
  // tracked as an active download gets unlinked. Skipping active
  // downloads matters because a long video can sit at 95% for several
  // minutes while ffmpeg merges streams. Daily cadence is plenty —
  // successful downloads clean their own temp file on move; this loop
  // only catches orphans from crashed/abandoned downloads.
  const cleanupTempFiles = () => {
    try {
      const files = fs.readdirSync(tempDir);
      const activeFilePaths = new Set<string>();
      activeDownloads.forEach(d => { activeFilePaths.add(d.downloadPath); });

      let deletedCount = 0;
      let totalSize = 0;
      for (const file of files) {
        const filePath = path.join(tempDir, file);
        if (activeFilePaths.has(filePath)) continue;
        try {
          const stats = fs.statSync(filePath);
          const fileAge = Date.now() - stats.mtimeMs;
          if (fileAge > 1800000) {
            totalSize += stats.size;
            fs.unlinkSync(filePath);
            deletedCount++;
            console.log(`[temp] Removed ${file} (${Math.round(stats.size / 1024)} KB, ${Math.round(fileAge / 60000)} min old)`);
          }
        } catch (error) {
          console.error(`[temp] Error processing ${file}:`, error);
        }
      }
      // Only log when there was actually something to clean — no point
      // surfacing a "did nothing" line on the typical daily run.
      if (deletedCount > 0) {
        console.log(`[temp] Cleanup freed ${Math.round(totalSize / (1024 * 1024))} MB (${deletedCount} files)`);
      }
    } catch (error) {
      console.error("[temp] Cleanup failed:", error);
    }
  };

  cleanupTempFiles(); // run once on boot
  const cleanupInterval = setInterval(cleanupTempFiles, 24 * 60 * 60 * 1000);

  // ---- Endpoints --------------------------------------------------------

  // 1) Probe a YouTube URL for info — title, formats, channel — so the
  // UI can render a picker before the actual download starts.
  app.post("/api/videos/info", async (req, res) => {
    try {
      const { url } = req.body;
      if (!url) return res.status(400).json({ error: "URL is required" });

      const videoInfo = await getYouTubeVideoInfo(url);
      if (!videoInfo) return res.status(404).json({ error: "Could not retrieve video information" });

      const formattedInfo = {
        id: videoInfo.id,
        title: videoInfo.title,
        thumbnail: videoInfo.thumbnail,
        duration: formatDuration(videoInfo.duration),
        views: `${Math.round((videoInfo.view_count || 0) / 1000)}K views`,
        uploadDate: videoInfo.upload_date || null,
        channelId: videoInfo.channel_id || videoInfo.uploader_id || null,
        channelName: videoInfo.channel || videoInfo.uploader || null,
        channelUrl: videoInfo.channel_url || null,
        formats: videoInfo.formats.map(format => ({
          format_id: format.format_id,
          format: format.format,
          quality: format.quality || "unknown",
          ext: format.ext,
          resolution: format.resolution,
          filesize: format.filesize,
          filesize_approx: format.filesize_approx,
          // Pass the language + codec metadata through so the UI
          // can show "English audio" / "Spanish audio" badges on
          // each format and the user can pick the right track for
          // multi-language YouTube videos.
          language: format.language ?? null,
          acodec: format.acodec,
          vcodec: format.vcodec,
          format_note: format.format_note,
        })),
      };

      storage.storeVideoInfo(formattedInfo);
      res.json(formattedInfo);
    } catch (error) {
      console.error("Error fetching video info:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to fetch video information",
      });
    }
  });

  // 2) Start a download. Allocates a downloadId, kicks off yt-dlp into
  // a temp file, then (on completion) moves the temp file to the user's
  // chosen location and enqueues the row in video_queue so the rest of
  // the pipeline (transcribe / embed / summarize) can process it.
  app.post("/api/videos/download", async (req, res) => {
    try {
      const { videoId, formatId, downloadLocation, uploadDate, channelId, channelName, category } = req.body;
      if (!videoId || !formatId) {
        return res.status(400).json({ error: "Video ID and format ID are required" });
      }

      const videoInfo = await storage.getVideoInfo(videoId);
      if (!videoInfo) return res.status(404).json({ error: "Video information not found" });

      const downloadId = nanoid();
      const timestamp = Date.now();
      const tempDownloadPath = path.join(tempDir, `${videoId}-${formatId}-${timestamp}.mp4`);

      const finalDownloadLocation =
        downloadLocation && downloadLocation.trim() !== ""
          ? downloadLocation.trim()
          : null;

      console.log(`Starting download process for ${videoId} with format ${formatId}`);
      console.log(`Temporary download path: ${tempDownloadPath}`);
      if (finalDownloadLocation) {
        console.log(`User requested final location: ${finalDownloadLocation}`);
      }

      activeDownloads.set(downloadId, {
        percent: 0,
        downloadPath: tempDownloadPath,
        finalLocation: finalDownloadLocation ?? undefined,
        videoId,
        uploadDate: uploadDate || videoInfo.uploadDate || null,
        // channelUrl rides along so the post-download matcher can use
        // it to attach to an existing configured channel. videoInfo
        // stashes channelUrl alongside channelId from the info probe.
        channelUrl: videoInfo.channelUrl || null,
        channelId: channelId || videoInfo.channelId || null,
        channelName: channelName || videoInfo.channelName || null,
        category: category === "work" ? "work" : category === "personal" ? "personal" : undefined,
        isComplete: false,
      });

      // Pull the preferred audio language from pipeline config so the
      // format string can target it. The download endpoint doesn't
      // currently accept a per-call override — the global setting is
      // the right scope for "I want English audio on every download
      // from this channel". A future enhancement could surface a
      // per-download picker in the manual download UI.
      const audioLanguage = pipeline.getConfig().audioLanguage || "";

      downloadYouTubeVideo(
        videoId,
        formatId,
        tempDownloadPath,
        (progress) => {
          const download = activeDownloads.get(downloadId);
          if (download && !download.isComplete) {
            console.log(`Download ${downloadId} progress: ${progress.percent}%`);
            let adjustedPercent = progress.percent;
            if (progress.percent === 100) {
              adjustedPercent = 90;
              console.log(`Download finished, merging audio/video. Display progress: ${adjustedPercent}%`);
            } else if (progress.percent > 0) {
              adjustedPercent = Math.floor(progress.percent * 0.9);
            }
            activeDownloads.set(downloadId, { ...download, percent: adjustedPercent });
          }
        },
        { audioLanguage },
      )
        .then(async () => {
          console.log(`Download ${downloadId} (ffmpeg processing) complete.`);
          const download = activeDownloads.get(downloadId);
          if (!download) {
            console.error(`Download ${downloadId} not found after completion.`);
            return;
          }
          if (!fs.existsSync(tempDownloadPath)) {
            console.error(`Temp file missing after download completion: ${tempDownloadPath}`);
            throw new Error("Temporary download file was not created properly.");
          }
          const stats = fs.statSync(tempDownloadPath);
          if (stats.size === 0) {
            console.error(`Temp file is empty after download completion: ${tempDownloadPath}`);
            throw new Error("Temporary download file is empty.");
          }
          console.log(`Temp file validated: ${tempDownloadPath}, size: ${stats.size} bytes`);

          let finalPath = tempDownloadPath;

          if (download.finalLocation) {
            console.log(`Attempting to move file to custom location: ${download.finalLocation}`);
            try {
              const videoInfo2 = await storage.getVideoInfo(download.videoId);
              const title = videoInfo2?.title || `youtube-video-${download.videoId}`;
              const safeFileName = `${datedBaseName(title, download.uploadDate)}.mp4`;

              const targetDir = path.resolve(download.finalLocation, channelFolderName(download.channelName));
              const destinationPath = path.join(targetDir, safeFileName);
              const destinationAudioPath = replaceExtension(destinationPath, ".m4a");

              if (!fs.existsSync(targetDir)) {
                console.log(`Creating target directory: ${targetDir}`);
                fs.mkdirSync(targetDir, { recursive: true });
              }

              console.log(`Moving file from ${tempDownloadPath} to ${destinationPath}`);
              fs.copyFileSync(tempDownloadPath, destinationPath);
              fs.unlinkSync(tempDownloadPath);
              console.log(`Successfully moved file to ${destinationPath}`);

              if (pipeline.getConfig().processing.keepAudio && !fs.existsSync(destinationAudioPath)) {
                await copyAudioTrack(destinationPath, destinationAudioPath);
              }

              const existingEntry = getQueueEntryByVideoId(download.videoId);
              // Attach to an already-configured channel when possible
              // — matches by stored UC id, then UC-in-URL, then
              // @handle, then normalized URL, then case-insensitive
              // name. Without this, a manual download of e.g. a live
              // that just ended creates an orphan row keyed by the
              // display name instead of the configured channel id,
              // so it doesn't show up when you filter by that
              // channel in Library and downstream tables (vec_segments,
              // FTS, anchors) all end up keyed by the wrong id.
              const matchedChannel = findChannelByYouTubeInfo(
                download.channelId,
                download.channelName,
                download.channelUrl,
              );
              // matchedChannel ALWAYS wins over a previously-saved
              // orphan: if the user had a video saved with
              // channel_id = display name (a stale orphan from
              // before this fix), the second manual download for
              // the same video should overwrite it with the
              // configured channel's id. existingEntry is the last
              // fallback for the case where we genuinely can't find
              // a configured channel match.
              const dbChannelId = matchedChannel?.id
                || existingEntry?.channel_id
                || (download.channelName ? String(download.channelName) : null)
                || download.channelId
                || "manual";
              // Diagnostic — shows what each candidate source
              // produced and which won. Lets us see at a glance
              // whether matchedChannel returned undefined (in
              // which case the match cascade log above tells us
              // why) or it matched but something downstream is
              // overwriting it.
              console.log("[manual-dl] enqueue decision", {
                videoId: download.videoId,
                matchedChannelId: matchedChannel?.id ?? null,
                existingEntryChannelId: existingEntry?.channel_id ?? null,
                downloadChannelName: download.channelName,
                downloadChannelId: download.channelId,
                downloadChannelUrl: download.channelUrl,
                FINAL_dbChannelId: dbChannelId,
              });
              // Category priority: explicit on the request > matched
              // configured channel's category > 'personal' fallback
              // (resolveCategoryForChannel inside enqueueVideo handles the
               // middle case when category is undefined).
              enqueueVideo({
                videoId: download.videoId,
                channelId: dbChannelId,
                title,
                url: `https://www.youtube.com/watch?v=${download.videoId}`,
                duration: null,
                isLive: false,
                isShorts: false,
                uploadDate: download.uploadDate || null,
                category: download.category,
              });
              updateQueueStatus(download.videoId, dbChannelId, {
                status: "complete",
                videoPath: destinationPath,
                error: null,
              });

              finalPath = destinationPath;
            } catch (moveError) {
              console.error(`Failed to move file to ${download.finalLocation}:`, moveError);
              finalPath = tempDownloadPath;
            }
          }

          activeDownloads.set(downloadId, {
            ...download,
            percent: 100,
            downloadPath: finalPath,
            isComplete: true,
          });
          console.log(`Download ${downloadId} fully complete. Final path: ${finalPath}`);
        })
        .catch((error) => {
          console.error(`Download ${downloadId} failed:`, error);
          const download = activeDownloads.get(downloadId);
          if (download) {
            activeDownloads.set(downloadId, {
              ...download,
              percent: -1,
              isComplete: true,
            });
          }
        });

      res.json({ downloadId });
    } catch (error) {
      console.error("Error starting download:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to start download",
      });
    }
  });

  // 3) SSE: stream the current download's percent until the merge /
  // move finishes. Emits a completion event with the final path and a
  // "savedToCustom" flag the UI uses to decide whether to also offer a
  // browser download link.
  app.get("/api/videos/download-progress/:downloadId", (req, res) => {
    const { downloadId } = req.params;
    console.log(`Progress tracking started for download: ${downloadId}`);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const initialDownload = activeDownloads.get(downloadId);
    if (!initialDownload) {
      console.error(`Download ${downloadId} not found when starting progress tracking`);
      res.write(`data: ${JSON.stringify({ error: "Download not found", percent: 0 })}\n\n`);
      return res.end();
    }

    const sendProgress = () => {
      const download = activeDownloads.get(downloadId);
      if (!download) {
        console.error(`Download ${downloadId} was lost during progress tracking`);
        clearInterval(interval);
        res.write(`data: ${JSON.stringify({ error: "Download was lost during processing", percent: 0 })}\n\n`);
        return res.end();
      }

      res.write(`data: ${JSON.stringify({ percent: download.percent })}\n\n`);

      if (download.isComplete) {
        clearInterval(interval);
        console.log(`Download ${downloadId} processing complete. Final path: ${download.downloadPath}`);

        if (!fs.existsSync(download.downloadPath)) {
          console.error(`Final download file missing at completion: ${download.downloadPath}`);
          res.write(`data: ${JSON.stringify({
            error: "Download file was not created properly or failed to move",
            percent: -1,
            completed: true,
          })}\n\n`);
          return res.end();
        }

        try {
          const stats = fs.statSync(download.downloadPath);
          if (stats.size === 0) {
            console.error(`Final download file is empty: ${download.downloadPath}`);
            res.write(`data: ${JSON.stringify({
              error: "Download file is empty",
              percent: -1,
              completed: true,
            })}\n\n`);
            return res.end();
          }
          console.log(`Final download file validated: ${download.downloadPath}, size: ${stats.size} bytes`);
        } catch (error) {
          console.error(`Error checking final file stats: ${error}`);
          res.write(`data: ${JSON.stringify({
            error: "Error validating final file",
            percent: -1,
            completed: true,
          })}\n\n`);
          return res.end();
        }

        const finalFileName = path.basename(download.downloadPath);
        const savedToCustomLocation =
          download.finalLocation && download.downloadPath.startsWith(path.resolve(download.finalLocation));

        console.log(`Sending completion event for ${downloadId}: filename=${finalFileName}, customLocation=${savedToCustomLocation}`);

        res.write(`data: ${JSON.stringify({
          percent: 100,
          fileName: finalFileName,
          finalPath: download.downloadPath,
          savedToCustom: savedToCustomLocation,
          completed: true,
        })}\n\n`);
        res.end();

        // Keep the entry around 5 minutes so a retry has a chance.
        setTimeout(() => {
          console.log(`Cleaning up download ${downloadId} from active downloads map`);
          activeDownloads.delete(downloadId);
        }, 5 * 60 * 1000);
        return;
      }
    };

    const interval = setInterval(sendProgress, 1000);
    sendProgress();

    req.on("close", () => {
      console.log(`Client disconnected from progress updates for ${downloadId}`);
      clearInterval(interval);
    });
  });

  // 4) Serve the finished file — or, when the file already landed in
  // the user's custom save dir, respond with 200 + the path so the UI
  // can show a "saved to ..." confirmation. Supports HEAD for existence
  // checks; deletes the temp file after a successful stream so the
  // temp dir doesn't grow unbounded.
  app.get("/api/videos/download/:downloadId", (req, res) => {
    const { downloadId } = req.params;
    console.log(`Download request received for ID: ${downloadId}`);

    const isHeadRequest = req.method === "HEAD";
    console.log(`Request type: ${req.method}`);

    const download = activeDownloads.get(downloadId);
    if (!download) {
      console.error(`Download ID not found: ${downloadId}`);
      return res.status(404).json({ error: "Download not found" });
    }

    console.log(`Download found with path: ${download.downloadPath}`);

    if (!fs.existsSync(download.downloadPath)) {
      console.error(`File not found at path: ${download.downloadPath}`);
      return res.status(404).json({ error: "Download file not found on server" });
    }

    let stats;
    try {
      stats = fs.statSync(download.downloadPath);
      if (stats.size === 0) {
        console.error(`Empty file found: ${download.downloadPath}`);
        return res.status(500).json({ error: "Downloaded file is empty" });
      }
      console.log(`File exists with size: ${stats.size} bytes`);
    } catch (error) {
      console.error(`Error checking file stats: ${error}`);
      return res.status(500).json({ error: "Error accessing file" });
    }

    if (isHeadRequest) {
      console.log(`HEAD request successful for: ${downloadId}`);
      return res.status(200).end();
    }

    const isCustomLocation = !download.downloadPath.startsWith(tempDir);
    if (isCustomLocation) {
      console.log(`File is in custom location: ${download.downloadPath}. No need to download.`);
      return res.status(200).json({
        message: "File saved to your specified location",
        path: download.downloadPath,
        alreadySaved: true,
      });
    }

    console.log(`Serving file: ${download.downloadPath}, size: ${stats.size} bytes`);

    storage.getVideoInfo(download.videoId)
      .then((videoInfo) => {
        let fileName = `youtube-video-${download.videoId}.mp4`;
        if (videoInfo && videoInfo.title) {
          fileName = `${datedBaseName(videoInfo.title, download.uploadDate)}.mp4`;
        }
        console.log(`Using filename: ${fileName} for download`);

        res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
        res.setHeader("Content-Type", "video/mp4");
        res.setHeader("Content-Length", stats.size);

        try {
          const fileStream = fs.createReadStream(download.downloadPath);
          fileStream.on("error", (err) => {
            console.error(`Error streaming file: ${err.message}`);
            if (!res.headersSent) res.status(500).json({ error: "Error streaming file" });
            else res.end();
          });

          let bytesSent = 0;
          fileStream.on("data", (chunk: string | Buffer) => {
            bytesSent += chunk.length;
            if (stats.size > 10 * 1024 * 1024 && bytesSent % (5 * 1024 * 1024) === 0) {
              console.log(`Download progress: ${Math.round((bytesSent / stats.size) * 100)}%`);
            }
          });

          fileStream.pipe(res);

          fileStream.on("end", () => {
            console.log(`Finished streaming file: ${download.downloadPath}`);
            setTimeout(() => {
              try {
                if (fs.existsSync(download.downloadPath)) {
                  fs.unlinkSync(download.downloadPath);
                  console.log(`Deleted file: ${download.downloadPath}`);
                }
              } catch (error) {
                console.error("Error cleaning up download:", error);
              }
            }, 2000);
          });

          setTimeout(() => {
            console.log(`Removing download ${downloadId} from active downloads`);
            activeDownloads.delete(downloadId);
          }, 60000);
        } catch (error) {
          console.error(`Error creating file stream: ${error}`);
          return res.status(500).json({ error: "Could not read the file" });
        }
      })
      .catch((error) => {
        console.error("Error serving download:", error);
        return res.status(500).json({ error: "Failed to prepare download" });
      });
  });

  return {
    shutdown: () => {
      clearInterval(cleanupInterval);
    },
  };
}
